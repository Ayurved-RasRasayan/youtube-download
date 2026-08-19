const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/downloads', express.static(path.join(__dirname, '../downloads')));

// Data storage
const DATA_FILE = path.join(__dirname, 'data.json');
const DOWNLOADS_DIR = path.join(__dirname, '../downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Load or initialize data
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
    return { channels: [], knownVideos: {}, settings: {} };
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let appData = loadData();

// Check if yt-dlp is installed
function checkYtDlp() {
    try {
        execSync('yt-dlp --version', { stdio: 'pipe' });
        return true;
    } catch (error) {
        return false;
    }
}

// Extract channel ID from URL
function extractChannelId(url) {
    const patterns = [
        /youtube\.com\/@([^\/\?]+)/,
        /youtube\.com\/c\/([^\/\?]+)/,
        /youtube\.com\/channel\/([^\/\?]+)/,
        /youtube\.com\/user\/([^\/\?]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }

    if (url.startsWith('@') || /^[a-zA-Z0-9_-]+$/.test(url)) {
        return url.replace('@', '');
    }

    return null;
}

// Fetch channel info using yt-dlp
function fetchChannelInfo(channelId, channelUrl) {
    return new Promise((resolve, reject) => {
        const cmd = 'yt-dlp --flat-playlist --print "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s\t%(view_count)s\t%(is_live)s" "' + channelUrl + '"';
        
        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error('Failed to fetch channel: ' + error.message));
                return;
            }

            const lines = stdout.trim().split('\n').filter(function(line) { return line.trim(); });
            const videos = [];
            const liveVideos = [];

            lines.forEach(function(line) {
                const parts = line.split('\t');
                if (parts.length >= 6) {
                    const id = parts[0];
                    const title = parts[1] || 'Untitled';
                    const duration = parseInt(parts[2]);
                    const uploadDate = parts[3];
                    const viewCount = parseInt(parts[4]);
                    const isLive = parts[5] === 'True' || parts[5] === 'true';
                    
                    const video = {
                        id: id,
                        title: title,
                        duration: formatDuration(duration),
                        views: formatViews(viewCount),
                        viewCount: viewCount || 0,
                        publishedAt: formatDate(uploadDate),
                        isLive: isLive,
                        isNew: false,
                        url: 'https://www.youtube.com/watch?v=' + id,
                        thumbnail: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'
                    };

                    if (video.isLive) {
                        liveVideos.push(video);
                    } else {
                        videos.push(video);
                    }
                }
            });

            // Get channel name from first video or use channelId
            let channelName = channelId.replace(/[_-]/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
            
            resolve({
                id: channelId,
                name: channelName,
                url: channelUrl,
                avatar: channelId.charAt(0).toUpperCase(),
                videos: videos.slice(0, 50), // Limit to 50 recent videos
                liveVideos: liveVideos.slice(0, 20),
                lastChecked: new Date().toISOString(),
                newVideoCount: 0
            });
        });
    });
}

// Format duration
function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'Unknown';
    
    if (seconds >= 3600) {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        return hours + ':' + mins.toString().padStart(2, '0') + ':00';
    }
    
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins + ':' + secs.toString().padStart(2, '0');
}

// Format views
function formatViews(count) {
    if (!count || isNaN(count)) return '0 views';
    
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M views';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K views';
    return count + ' views';
}

// Format date
function formatDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) return new Date().toISOString();
    
    const year = dateStr.substring(0, 4);
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    
    return new Date(year, month, day).toISOString();
}

// Track active downloads
const activeDownloads = new Map();

// API Routes

// Health check
app.get('/api/health', function(req, res) {
    res.json({
        status: 'ok',
        ytDlpInstalled: checkYtDlp(),
        channels: appData.channels.length,
        activeDownloads: activeDownloads.size
    });
});

// Get all channels
app.get('/api/channels', function(req, res) {
    res.json({ channels: appData.channels });
});

// Add/Load channel
app.post('/api/channels', async function(req, res) {
    const url = req.body.url;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const channelId = extractChannelId(url);
    if (!channelId) {
        return res.status(400).json({ error: 'Invalid YouTube channel URL' });
    }

    try {
        const channelData = await fetchChannelInfo(channelId, url);
        
        // Check for new videos
        if (!appData.knownVideos[channelId]) {
            appData.knownVideos[channelId] = [];
        }

        let newCount = 0;
        
        channelData.videos.forEach(function(video) {
            if (appData.knownVideos[channelId].indexOf(video.id) === -1) {
                video.isNew = true;
                newCount++;
                appData.knownVideos[channelId].push(video.id);
            }
        });
        
        channelData.liveVideos.forEach(function(video) {
            if (appData.knownVideos[channelId].indexOf(video.id) === -1) {
                video.isNew = true;
                newCount++;
                appData.knownVideos[channelId].push(video.id);
            }
        });

        channelData.newVideoCount = newCount;

        // Update or add channel
        const existingIndex = appData.channels.findIndex(function(c) { return c.id === channelId; });
        if (existingIndex >= 0) {
            appData.channels[existingIndex] = channelData;
        } else {
            appData.channels.push(channelData);
        }

        saveData(appData);
        
        res.json({ 
            success: true, 
            message: 'Channel loaded! Found ' + newCount + ' new videos',
            channel: channelData 
        });
    } catch (error) {
        console.error('Error loading channel:', error);
        res.status(500).json({ error: error.message });
    }
});

// Refresh channel (check for new videos)
app.post('/api/channels/:id/refresh', async function(req, res) {
    const channelId = req.params.id;
    const channel = appData.channels.find(function(c) { return c.id === channelId; });
    
    if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
    }

    try {
        const updatedData = await fetchChannelInfo(channelId, channel.url);
        
        let newCount = 0;
        if (!appData.knownVideos[channelId]) {
            appData.knownVideos[channelId] = [];
        }

        updatedData.videos.forEach(function(video) {
            if (appData.knownVideos[channelId].indexOf(video.id) === -1) {
                video.isNew = true;
                newCount++;
                appData.knownVideos[channelId].push(video.id);
            }
        });
        
        updatedData.liveVideos.forEach(function(video) {
            if (appData.knownVideos[channelId].indexOf(video.id) === -1) {
                video.isNew = true;
                newCount++;
                appData.knownVideos[channelId].push(video.id);
            }
        });

        updatedData.newVideoCount = newCount;

        const index = appData.channels.findIndex(function(c) { return c.id === channelId; });
        appData.channels[index] = updatedData;
        
        saveData(appData);
        
        res.json({ 
            success: true, 
            message: 'Found ' + newCount + ' new videos',
            channel: updatedData 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Remove channel
app.delete('/api/channels/:id', function(req, res) {
    const channelId = req.params.id;
    appData.channels = appData.channels.filter(function(c) { return c.id !== channelId; });
    delete appData.knownVideos[channelId];
    saveData(appData);
    res.json({ success: true, message: 'Channel removed' });
});

// Clear all channels
app.delete('/api/channels', function(req, res) {
    appData.channels = [];
    appData.knownVideos = {};
    saveData(appData);
    res.json({ success: true, message: 'All channels cleared' });
});

// Download video
app.post('/api/download', function(req, res) {
    const videoId = req.body.videoId;
    const title = req.body.title;
    const quality = req.body.quality;
    const format = req.body.format;
    const channelId = req.body.channelId;
    
    if (!videoId || !title) {
        return res.status(400).json({ error: 'Video ID and title are required' });
    }

    // Create download job
    const jobId = uuidv4();
    const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 100);
    const folderPath = path.join(DOWNLOADS_DIR, sanitizeFilename(channelId || 'general'));
    
    // Create subfolder for videos/lives
    const subFolder = req.body.isLive ? 'Live Streams' : 'Videos';
    const finalPath = path.join(folderPath, subFolder);
    
    // Ensure directories exist
    if (!fs.existsSync(finalPath)) {
        fs.mkdirSync(finalPath, { recursive: true });
    }

    const outputTemplate = path.join(finalPath, safeTitle + '.%(ext)s');
    
    // Build yt-dlp command
    var command = 'yt-dlp -o "' + outputTemplate + '"';
    
    // Add quality/format options
    if (format === 'mp3' || format === 'm4a') {
        command += ' -x --audio-format ' + format;
        if (quality && quality !== 'best') {
            command += ' --audio-quality ' + quality;
        }
    } else {
        if (quality && quality !== 'best') {
            command += ' -f "bestvideo[height<=' + quality + ']+bestaudio/best[height<=' + quality + ']"';
        }
        if (format && format !== 'mp4') {
            command += ' --merge-output-format ' + format;
        }
    }

    command += ' https://www.youtube.com/watch?v=' + videoId;

    // Start download process
    const downloadJob = {
        id: jobId,
        videoId: videoId,
        title: title,
        status: 'downloading',
        progress: 0,
        speed: '',
        eta: '',
        startedAt: new Date().toISOString()
    };

    activeDownloads.set(jobId, downloadJob);

    // Execute download
    const child = spawn(command, [], { shell: true });

    var output = '';
    var errorOutput = '';

    child.stdout.on('data', function(data) {
        output += data.toString();
        parseProgress(output, jobId);
    });

    child.stderr.on('data', function(data) {
        errorOutput += data.toString();
        parseProgress(errorOutput, jobId);
    });

    child.on('close', function(code) {
        const job = activeDownloads.get(jobId);
        if (job) {
            if (code === 0) {
                job.status = 'completed';
                job.progress = 100;
                
                // Mark as downloaded (not new)
                markAsDownloaded(channelId, videoId);
            } else {
                job.status = 'error';
                job.error = errorOutput.substring(0, 500);
            }
            job.completedAt = new Date().toISOString();
        }
    });

    child.on('error', function(err) {
        const job = activeDownloads.get(jobId);
        if (job) {
            job.status = 'error';
            job.error = err.message;
        }
    });

    res.json({ 
        success: true, 
        jobId: jobId,
        message: 'Download started',
        outputPath: finalPath
    });
});

// Parse yt-dlp progress output
function parseProgress(output, jobId) {
    const job = activeDownloads.get(jobId);
    if (!job) return;

    // Match progress percentage
    const progressMatch = output.match(/(\d+\.?\d*)%/);
    if (progressMatch) {
        job.progress = parseFloat(progressMatch[1]);
    }

    // Match speed
    const speedMatch = output.match(/(\d+\.?\d*\w*\/s)/);
    if (speedMatch) {
        job.speed = speedMatch[1];
    }

    // Match ETA
    const etaMatch = output.match(/ETA\s+(\d+:\d+)/);
    if (etaMatch) {
        job.eta = etaMatch[1];
    }
}

// Get download status
app.get('/api/download/:jobId', function(req, res) {
    const jobId = req.params.jobId;
    const job = activeDownloads.get(jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Download job not found' });
    }
    
    res.json(job);
});

// Get all active downloads
app.get('/api/downloads', function(req, res) {
    const downloads = Array.from(activeDownloads.values());
    res.json({ downloads: downloads });
});

// Mark video as downloaded
function markAsDownloaded(channelId, videoId) {
    if (channelId && videoId) {
        const channel = appData.channels.find(function(c) { return c.id === channelId; });
        if (channel) {
            channel.videos.forEach(function(video) {
                if (video.id === videoId) {
                    video.isNew = false;
                    video.downloaded = true;
                    video.downloadedAt = new Date().toISOString();
                }
            });
            channel.liveVideos.forEach(function(video) {
                if (video.id === videoId) {
                    video.isNew = false;
                    video.downloaded = true;
                    video.downloadedAt = new Date().toISOString();
                }
            });
            
            const newCount = channel.videos.filter(function(v) { return v.isNew; }).length +
                            channel.liveVideos.filter(function(v) { return v.isNew; }).length;
            channel.newVideoCount = newCount;
            saveData(appData);
        }
    }
}

// Sanitize filename
function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_-]/gi, '_').substring(0, 50);
}

// Auto-check scheduler (every 5 minutes by default)
cron.schedule('*/5 * * * *', function() {
    console.log('Running scheduled check for new videos...');
    
    appData.channels.forEach(async function(channel) {
        try {
            const updatedData = await fetchChannelInfo(channel.id, channel.url);
            
            let newCount = 0;
            if (!appData.knownVideos[channel.id]) {
                appData.knownVideos[channel.id] = [];
            }

            updatedData.videos.forEach(function(video) {
                if (appData.knownVideos[channel.id].indexOf(video.id) === -1) {
                    video.isNew = true;
                    newCount++;
                    appData.knownVideos[channel.id].push(video.id);
                }
            });
            
            updatedData.liveVideos.forEach(function(video) {
                if (appData.knownVideos[channel.id].indexOf(video.id) === -1) {
                    video.isNew = true;
                    newCount++;
                    appData.knownVideos[channel.id].push(video.id);
                }
            });

            if (newCount > 0) {
                console.log('Found ' + newCount + ' new videos for ' + channel.name);
                
                const index = appData.channels.findIndex(function(c) { return c.id === channel.id; });
                appData.channels[index] = updatedData;
                appData.channels[index].newVideoCount = newCount;
                saveData(appData);
            }
        } catch (error) {
            console.error('Error checking channel ' + channel.id + ':', error.message);
        }
    });
});

// Serve the HTML frontend
app.get('/', function(req, res) {
    const htmlPath = path.join(__dirname, '../public/index.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.send('<!DOCTYPE html><html><head><title>YouTube Downloader</title></head><body>' +
            '<h1>YouTube Channel Downloader</h1>' +
            '<p>Server is running on port ' + PORT + '</p>' +
            '<p>API available at <a href="/api/health">/api/health</a></p>' +
            '</body></html>');
    }
});

// Start server
app.listen(PORT, function() {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     YouTube Channel Downloader Server    ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log('║  Server running on: http://localhost:' + PORT + '  ║');
    console.log('║  API Health: http://localhost:' + PORT + '/api/health ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log('║  yt-dlp installed: ' + (checkYtDlp() ? '✅ Yes' : '❌ No') + '              ║');
    console.log('║  Channels tracked: ' + appData.channels.length + '                   ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    
    if (!checkYtDlp()) {
        console.log('');
        console.log('⚠️  WARNING: yt-dlp is not installed!');
        console.log('   Install with: pip install yt-dlp');
        console.log('   Or: brew install yt-dlp (macOS)');
        console.log('   Or: sudo apt install yt-dlp (Ubuntu)');
        console.log('');
    }
});
