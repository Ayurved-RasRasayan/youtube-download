
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Child process tracking for download cancellation
const childProcessMap = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/downloads', express.static(path.join(__dirname, '../downloads')));

// Data storage
const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'YouTube Channel Downloader');
let DOWNLOADS_DIR = DEFAULT_DOWNLOADS_DIR;

// Download queue for sequential mode
downloadQueue = [];
let isProcessingQueue = false;
let currentDownloadMode = 'batch'; // 'batch' or 'sequential'
let maxConcurrentDownloads = 5; // For batch mode (increased)

// Load or initialize data FIRST (before loadSettings)
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

// Ensure downloads directory exists
function ensureDownloadsDir() {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
}
ensureDownloadsDir();

// Load user settings from data (AFTER appData is initialized)
function loadSettings() {
    if (appData && appData.settings) {
        if (appData.settings.outputFolder) {
            DOWNLOADS_DIR = appData.settings.outputFolder;
            ensureDownloadsDir();
        }
        if (appData.settings.downloadMode) {
            currentDownloadMode = appData.settings.downloadMode;
        }
        if (appData.settings.maxConcurrent) {
            maxConcurrentDownloads = appData.settings.maxConcurrent;
        }
    }
}
loadSettings();

// Check if yt-dlp is installed
function checkYtDlp() {
    try {
        execSync('yt-dlp --version', { stdio: 'pipe' });
        return true;
    } catch (error) {
        return false;
    }
}

// Get the currently installed yt-dlp version (or null if not installed)
function getYtDlpVersion() {
    try {
        return execSync('yt-dlp --version', { stdio: 'pipe' }).toString().trim();
    } catch (error) {
        return null;
    }
}

// Update yt-dlp to the latest version. Tries pip3 first, falls back to pip.
// This matches how setup.sh installs yt-dlp, so `yt-dlp -U` (which fails
// for pip/PyPI installs) is intentionally not used here.
function updateYtDlp() {
    return new Promise((resolve) => {
        const beforeVersion = getYtDlpVersion();

        const runPip = (pipCmd) => new Promise((res) => {
            const updater = spawn(pipCmd, ['install', '-U', 'yt-dlp'], { shell: true });
            let output = '';
            updater.stdout.on('data', (d) => output += d.toString());
            updater.stderr.on('data', (d) => output += d.toString());
            updater.on('error', () => res({ code: 1, output }));
            updater.on('close', (code) => res({ code, output }));
        });

        runPip('pip3').then((result) => {
            if (result.code === 0) {
                const afterVersion = getYtDlpVersion();
                resolve({
                    success: !!afterVersion,
                    beforeVersion,
                    afterVersion,
                    updated: !!afterVersion && afterVersion !== beforeVersion,
                    output: result.output
                });
                return;
            }
            // pip3 failed or isn't available — fall back to pip
            runPip('pip').then((fallback) => {
                const afterVersion = getYtDlpVersion();
                resolve({
                    success: !!afterVersion,
                    beforeVersion,
                    afterVersion,
                    updated: !!afterVersion && afterVersion !== beforeVersion,
                    output: result.output + '\n' + fallback.output
                });
            });
        });
    });
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
        const cmd = 'yt-dlp --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=web" --no-check-certificate --cookies-from-browser edge --remote-components ejs:github --flat-playlist --print "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s\t%(view_count)s\t%(is_live)s" "' + channelUrl + '"';
        
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
        activeDownloads: activeDownloads.size,
        downloadsDir: DOWNLOADS_DIR,
        downloadMode: currentDownloadMode
    });
});

// Get current yt-dlp version
app.get('/api/ytdlp/version', function(req, res) {
    const version = getYtDlpVersion();
    res.json({
        installed: !!version,
        version: version
    });
});

// Manually trigger a yt-dlp update (pip3/pip install -U yt-dlp)
app.post('/api/ytdlp/update', async function(req, res) {
    try {
        const result = await updateYtDlp();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get/Update settings
app.get('/api/settings', function(req, res) {
    res.json({
        outputFolder: DOWNLOADS_DIR,
        defaultFolder: DEFAULT_DOWNLOADS_DIR,
        downloadMode: currentDownloadMode,
        maxConcurrent: maxConcurrentDownloads,
        allSettings: appData.settings || {}
    });
});

app.post('/api/settings', function(req, res) {
    const { outputFolder, downloadMode, maxConcurrent } = req.body;
    
    // Update output folder
    if (outputFolder !== undefined && outputFolder !== null && outputFolder.trim() !== '') {
        const newDir = path.resolve(outputFolder.trim());
        try {
            if (!fs.existsSync(newDir)) {
                fs.mkdirSync(newDir, { recursive: true });
            }
            DOWNLOADS_DIR = newDir;
            appData.settings.outputFolder = newDir;
        } catch (error) {
            return res.status(400).json({ error: 'Invalid output folder path: ' + error.message });
        }
    } else if (outputFolder === '' || outputFolder === null) {
        // Reset to default
        DOWNLOADS_DIR = DEFAULT_DOWNLOADS_DIR;
        appData.settings.outputFolder = DEFAULT_DOWNLOADS_DIR;
        ensureDownloadsDir();
    }
    
    // Update download mode
    if (downloadMode === 'sequential' || downloadMode === 'batch') {
        currentDownloadMode = downloadMode;
        appData.settings.downloadMode = downloadMode;
    }
    
    // Update max concurrent downloads (for batch mode)
    if (maxConcurrent !== undefined && !isNaN(maxConcurrent) && maxConcurrent >= 1) {
        maxConcurrentDownloads = parseInt(maxConcurrent);
        appData.settings.maxConcurrent = maxConcurrentDownloads;
    }
    
    saveData(appData);
    
    res.json({ 
        success: true, 
        message: 'Settings updated',
        settings: {
            outputFolder: DOWNLOADS_DIR,
            downloadMode: currentDownloadMode,
            maxConcurrent: maxConcurrentDownloads
        }
    });
});

// Validate output folder (without saving)
app.post('/api/settings/validate-folder', function(req, res) {
    const { folderPath } = req.body;
    
    if (!folderPath || !folderPath.trim()) {
        return res.status(400).json({ error: 'Folder path is required' });
    }
    
    const resolvedPath = path.resolve(folderPath.trim());
    let exists = false;
    let accessible = false;
    let writable = false;
    
    try {
        exists = fs.existsSync(resolvedPath);
        if (!exists) {
            // Check if parent is writable (can create)
            const parentDir = path.dirname(resolvedPath);
            accessible = fs.existsSync(parentDir);
            if (accessible) {
                try {
                    fs.accessSync(parentDir, fs.constants.W_OK);
                    writable = true;
                } catch (e) {
                    writable = false;
                }
            }
        } else {
            accessible = true;
            try {
                fs.accessSync(resolvedPath, fs.constants.W_OK);
                writable = true;
            } catch (e) {
                writable = false;
            }
        }
    } catch (error) {
        return res.status(400).json({ error: 'Invalid path: ' + error.message });
    }
    
    res.json({
        valid: writable,
        path: resolvedPath,
        exists: exists,
        accessible: accessible,
        writable: writable,
        message: exists ? (writable ? 'Folder is writable' : 'Folder is not writable') : (writable ? 'Folder will be created' : 'Cannot create folder in parent directory')
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

// Process download queue (for sequential mode)
function processDownloadQueue() {
    if (isProcessingQueue || downloadQueue.length === 0) {
        return;
    }
    
    isProcessingQueue = true;
    
    function processNext() {
        if (downloadQueue.length === 0) {
            isProcessingQueue = false;
            return;
        }
        
        // In sequential mode, only process one at a time
        // In batch mode, process up to maxConcurrentDownloads
        const slotsAvailable = currentDownloadMode === 'sequential' ? 1 : (maxConcurrentDownloads - getActiveNonQueuedCount());
        
        if (slotsAvailable <= 0) {
            // Wait and try again
            setTimeout(processNext, 1000);
            return;
        }
        
        const itemsToProcess = downloadQueue.splice(0, Math.min(slotsAvailable, downloadQueue.length));
        
        itemsToProcess.forEach(queueItem => {
            executeDownload(queueItem.reqBody, queueItem.res, queueItem.jobId);
        });
        
        // Continue processing after a short delay if more items in queue
        if (downloadQueue.length > 0) {
            setTimeout(processNext, currentDownloadMode === 'sequential' ? 2000 : 500);
        } else {
            isProcessingQueue = false;
        }
    }
    
    processNext();
}

// Count active downloads that are not queued
function getActiveNonQueuedCount() {
    let count = 0;
    activeDownloads.forEach(function(job) {
        if (job.status === 'downloading') {
            count++;
        }
    });
    return count;
}

// Get available formats for a video and find lowest quality MP4
function getBestLowQualityFormat(videoId) {
    return new Promise((resolve, reject) => {
        console.log('[Format Analyzer] Analyzing formats for video:', videoId);
        
        const listCmd = 'yt-dlp --list-formats --no-check-certificate --cookies-from-browser edge "https://www.youtube.com/watch?v=' + videoId + '"';
        
        exec(listCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('[Format Analyzer] Error listing formats:', error.message);
                // Fallback to a safe default format that works for most videos
                resolve('worstvideo[ext=mp4]+worstaudio[ext=m4a]/worstvideo[ext=mp4]/worst');
                return;
            }
            
            const output = stdout + stderr;
            console.log('[Format Analyzer] Raw format output:', output.substring(0, 500));
            
            // Parse format lines - look for MP4 video formats
            const lines = output.split('\n');
            const videoFormats = [];
            
            for (const line of lines) {
                // Match format lines like: "137 mp4 1920x1080   3875KiB  3450kps 30fps"
                // or "18  mp4    360p     1234KiB   800kps"
                const match = line.match(/^\s*(\d+)\s+(mp4|webm)\s+(\d+x\d+|\d+p)/i);
                if (match) {
                    const formatId = match[1];
                    const ext = match[2].toLowerCase();
                    const resolution = match[3];
                    
                    // Only consider MP4 formats
                    if (ext === 'mp4') {
                        let height = 9999;
                        
                        // Parse height from resolution
                        if (resolution.includes('x')) {
                            height = parseInt(resolution.split('x')[1]) || 9999;
                        } else if (resolution.includes('p')) {
                            height = parseInt(resolution.replace('p', '')) || 9999;
                        }
                        
                        // Skip audio-only formats (usually very small heights or marked as audio)
                        if (height > 50) {
                            videoFormats.push({
                                id: formatId,
                                resolution: resolution,
                                height: height,
                                ext: ext
                            });
                        }
                    }
                }
            }
            
            // Sort by height (ascending) to get lowest quality first
            videoFormats.sort((a, b) => a.height - b.height);
            
            console.log('[Format Analyzer] Found MP4 formats:', videoFormats);
            
            if (videoFormats.length > 0) {
                // PRIORITY 1: Look for format 18 (360p pre-merged MP4 with audio) - MOST RELIABLE
                let bestFormat = videoFormats.find(f => f.id === '18');
                
                // PRIORITY 2: If no format 18, look for other low-quality pre-merged formats with audio
                // Pre-merged formats typically have IDs like: 5, 6, 17, 18, 34, 35, 36, 37, 38
                if (!bestFormat) {
                    const preMergedIds = ['17', '36', '35', '34', '5', '6'];
                    for (const pmId of preMergedIds) {
                        bestFormat = videoFormats.find(f => f.id === pmId);
                        if (bestFormat) break;
                    }
                }
                
                // PRIORITY 3: Use lowest resolution format (fallback)
                if (!bestFormat) {
                    bestFormat = videoFormats[0];
                }
                
                console.log('[Format Analyzer] Selected format:', bestFormat.id, bestFormat.resolution);
                
                // For pre-merged formats (like 18), just use the format ID directly
                // For video-only formats, add audio merge
                const preMergedFormatIds = ['5', '6', '17', '18', '22', '37', '38', '34', '35', '36'];
                if (preMergedFormatIds.includes(bestFormat.id)) {
                    // Pre-merged format - no need to merge audio
                    resolve(bestFormat.id);
                } else {
                    // Video-only format - need to merge with audio
                    resolve(bestFormat.id + '+bestaudio[ext=m4a]/' + bestFormat.id);
                }
            } else {
                // No MP4 formats found - use fallback chain that prefers pre-merged formats
                console.warn('[Format Analyzer] No MP4 formats found, using fallback');
                resolve('18/17/16/15/worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst');
            }
        });
    });
}

// Execute the actual download
async function executeDownload(reqBody, res, jobId) {
    const videoId = reqBody.videoId;
    const title = reqBody.title;
    const channelId = reqBody.channelId;
    const customOutputFolder = reqBody.outputFolder; // Allow per-request override
    
    const effectiveDownloadsDir = customOutputFolder || DOWNLOADS_DIR;
    
    // Create download job if not already created
    if (!jobId) {
        jobId = uuidv4();
    }
    
    const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 100);
    const folderPath = path.join(effectiveDownloadsDir, sanitizeFilename(channelId || 'general'));
    
    // Create subfolder for videos/lives
    const subFolder = reqBody.isLive ? 'Live Streams' : 'Videos';
    const finalPath = path.join(folderPath, subFolder);
    
    // Ensure directories exist
    if (!fs.existsSync(finalPath)) {
        fs.mkdirSync(finalPath, { recursive: true });
    }

    const outputTemplate = path.join(finalPath, safeTitle + '.%(ext)s');
    
    // Update job status to "analyzing" while we check formats
    const analyzingJob = {
        id: jobId,
        videoId: videoId,
        title: title,
        status: 'analyzing',
        progress: 0,
        speed: 'Analyzing formats...',
        eta: '',
        startedAt: new Date().toISOString(),
        mode: currentDownloadMode,
        outputPath: finalPath
    };
    
    activeDownloads.set(jobId, analyzingJob);
    
    try {
        // STEP 1: Analyze available formats and find lowest quality MP4
        console.log('[Download] Starting format analysis for:', videoId);
        const formatString = await getBestLowQualityFormat(videoId);
        console.log('[Download] Using format string:', formatString);
        
        // Update job status to downloading
        analyzingJob.status = 'downloading';
        analyzingJob.speed = '';
        
        // STEP 2: Build yt-dlp command with detected format
        // Using essential flags that are REQUIRED for YouTube to work
        var command = 'yt-dlp';
        
        // ESSENTIAL flags for YouTube (required as of 2024+):
        command += ' --js-runtimes node';                   // REQUIRED: JS runtime for YouTube extraction
        command += ' --no-check-certificate';                // Skip SSL verification issues
        command += ' --cookies-from-browser edge';            // Use browser cookies for login
        command += ' --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"';  // Standard browser UA
        
        // Add the auto-detected format (format 18 = pre-merged 360p MP4 with audio)
        command += ' -f "' + formatString + '"';
        
        // Only add merge flag if format string contains "+" (video+audio merge needed)
        if (formatString.includes('+')) {
            command += ' --merge-output-format mp4';
        }
        
        // Add output template
        command += ' -o "' + outputTemplate + '"';

        command += ' "https://www.youtube.com/watch?v=' + videoId + '"';
        
        console.log('[Download] Final command:', command);
        
        // Start download process
        const downloadJob = {
            id: jobId,
            videoId: videoId,
            title: title,
            status: 'downloading',
            progress: 0,
            speed: '',
            eta: '',
            startedAt: new Date().toISOString(),
            mode: currentDownloadMode,
            outputPath: finalPath
        };

        activeDownloads.set(jobId, downloadJob);

        // Execute download
        const child = spawn(command, [], { shell: true });

        // Store child process reference for cancellation
        downloadJob.childProcess = child;
        
        // Also store in global map for API access
        childProcessMap.set(jobId, child);

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
                } else if (code === null || job.status === 'cancelled') {
                    job.status = 'cancelled';
                    job.error = 'Download cancelled by user';
                } else {
                    job.status = 'error';
                    job.error = errorOutput.substring(0, 500);
                }
                job.completedAt = new Date().toISOString();
                
                // Clean up process tracking
                childProcessMap.delete(jobId);
                
                // Process next in queue after completion
                processDownloadQueue();
            }
        });

        child.on('error', function(err) {
            const job = activeDownloads.get(jobId);
            if (job) {
                job.status = 'error';
                job.error = err.message;
            }
            processDownloadQueue();
        });

        // Send response if provided
        if (res && !res.headersSent) {
            res.json({ 
                success: true, 
                jobId: jobId,
                message: currentDownloadMode === 'sequential' ? 'Download queued (sequential mode)' : 'Download started with auto-detected format',
                outputPath: finalPath,
                mode: currentDownloadMode,
                queuePosition: downloadQueue.length + 1
            });
        }
        
    } catch(error) {
        console.error('[Download] Error during format analysis or download:', error);
        
        // Update job status to error
        const errorJob = activeDownloads.get(jobId);
        if (errorJob) {
            errorJob.status = 'error';
            errorJob.error = 'Format analysis failed: ' + error.message;
        }
        
        // Try fallback download without format analysis
        console.log('[Download] Attempting fallback download...');
        
        var fallbackCommand = 'yt-dlp --no-check-certificate --cookies-from-browser edge -f "worst[ext=mp4]/worst" --merge-output-format mp4 -o "' + outputTemplate + '" https://www.youtube.com/watch?v=' + videoId;
        
        const fallbackChild = spawn(fallbackCommand, [], { shell: true });
        
        const fallbackJob = activeDownloads.get(jobId) || analyzingJob;
        fallbackJob.status = 'downloading';
        fallbackJob.childProcess = fallbackChild;
        childProcessMap.set(jobId, fallbackChild);
        
        var fbOutput = '';
        var fbErrorOutput = '';
        
        fallbackChild.stdout.on('data', function(data) {
            fbOutput += data.toString();
            parseProgress(fbOutput, jobId);
        });
        
        fallbackChild.stderr.on('data', function(data) {
            fbErrorOutput += data.toString();
            parseProgress(fbErrorOutput, jobId);
        });
        
        fallbackChild.on('close', function(code) {
            const job = activeDownloads.get(jobId);
            if (job) {
                if (code === 0) {
                    job.status = 'completed';
                    job.progress = 100;
                    markAsDownloaded(channelId, videoId);
                } else {
                    job.status = 'error';
                    job.error = fbErrorOutput.substring(0, 500);
                }
                job.completedAt = new Date().toISOString();
                childProcessMap.delete(jobId);
                processDownloadQueue();
            }
        });
        
        fallbackChild.on('error', function(err) {
            const job = activeDownloads.get(jobId);
            if (job) {
                job.status = 'error';
                job.error = err.message;
            }
            processDownloadQueue();
        });
    }
}

// Download video (main endpoint)
app.post('/api/download', function(req, res) {
    const videoId = req.body.videoId;
    const title = req.body.title;
    const channelId = req.body.channelId;
    
    // Force auto-detection - ignore client quality/format settings
    // Server will analyze formats and pick lowest MP4 automatically
    const reqBody = {
        videoId: videoId,
        title: title,
        channelId: channelId,
        isLive: req.body.isLive,
        outputFolder: req.body.outputFolder
    };
    
    if (!videoId || !title) {
        return res.status(400).json({ error: 'Video ID and title are required' });
    }

    // Create job ID
    const jobId = uuidv4();
    
    // Check if we should queue this download (sequential mode with active downloads)
    const activeCount = getActiveNonQueuedCount();
    const shouldQueue = currentDownloadMode === 'sequential' && activeCount >= 1;
    
    if (shouldQueue) {
        // Add to queue for sequential processing
        downloadQueue.push({
            reqBody: reqBody,  // Use cleaned reqBody (no quality/format)
            res: res,
            jobId: jobId,
            queuedAt: new Date().toISOString()
        });
        
        // Create a pending job entry
        const pendingJob = {
            id: jobId,
            videoId: videoId,
            title: title,
            status: 'queued',
            progress: 0,
            speed: 'Waiting...',
            eta: 'In queue',
            startedAt: new Date().toISOString(),
            mode: 'sequential',
            queuePosition: downloadQueue.length
        };
        activeDownloads.set(jobId, pendingJob);
        
        res.json({ 
            success: true, 
            jobId: jobId,
            message: 'Download queued (position #' + downloadQueue.length + ')',
            mode: 'sequential',
            queuePosition: downloadQueue.length,
            queueSize: downloadQueue.length
        });
        
        // Start queue processor if not running
        processDownloadQueue();
    } else {
        // Execute immediately (batch mode or no active downloads)
        executeDownload(reqBody, res, jobId);  // Use cleaned reqBody
    }
});

// Get download queue status
app.get('/api/download-queue', function(req, res) {
    res.json({
        queue: downloadQueue.map(function(item, index) {
            return {
                position: index + 1,
                jobId: item.jobId,
                title: item.reqBody.title,
                queuedAt: item.queuedAt
            };
        }),
        queueSize: downloadQueue.length,
        isProcessing: isProcessingQueue,
        mode: currentDownloadMode,
        activeDownloads: getActiveNonQueuedCount()
    });
});

// Clear download queue
app.delete('/api/download-queue', function(req, res) {
    const clearedCount = downloadQueue.length;
    
    // Remove queued jobs from active downloads
    downloadQueue.forEach(function(item) {
        const job = activeDownloads.get(item.jobId);
        if (job && job.status === 'queued') {
            activeDownloads.delete(item.jobId);
        }
    });
    
    downloadQueue = [];
    isProcessingQueue = false;
    
    res.json({ 
        success: true, 
        message: 'Queue cleared', 
        clearedCount: clearedCount 
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

// Daily auto-update of yt-dlp (runs once every day at 3:00 AM server time)
cron.schedule('0 3 * * *', function() {
    console.log('Running scheduled yt-dlp update check...');
    updateYtDlp().then(function(result) {
        if (result.updated) {
            console.log('✅ yt-dlp updated: ' + result.beforeVersion + ' → ' + result.afterVersion);
        } else if (result.success) {
            console.log('yt-dlp already up to date (' + result.afterVersion + ')');
        } else {
            console.error('⚠️  yt-dlp auto-update failed. Update manually with: pip install -U yt-dlp');
        }
    }).catch(function(error) {
        console.error('⚠️  yt-dlp auto-update error:', error.message);
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

// API Endpoint: Cancel a download
app.post('/api/cancel/:id', (req, res) => {
    const downloadId = req.params.id;
    console.log('[API] Cancel request for:', downloadId);
    
    let cancelled = false;
    
    // Try to find and kill the process
    for (const [pid, proc] of childProcessMap.entries()) {
        if (pid.includes(downloadId) || proc._downloadId === downloadId) {
            console.log('[API] Killing process:', pid);
            try {
                proc.kill('SIGTERM');
                setTimeout(() => {
                    try { proc.kill('SIGKILL'); } catch(e) {}
                }, 1000);
                cancelled = true;
            } catch(e) {
                console.error('[API] Error killing process:', e.message);
            }
            break;
        }
    }
    
    res.json({ success: cancelled, message: cancelled ? 'Download cancelled' : 'Download not found' });
});

// API Endpoint: Cancel/Stop a download
app.post('/api/cancel/:id', (req, res) => {
    const downloadId = req.params.id;
    console.log('[API] Cancel request for:', downloadId);
    
    let cancelled = false;
    
    // Try to get the job first
    const job = activeDownloads.get(downloadId);
    
    if (job && job.childProcess) {
        try {
            console.log('[API] Killing process for job:', downloadId);
            job.childProcess.kill('SIGTERM');
            job.status = 'cancelled';
            cancelled = true;
            
            // Force kill after 2 seconds if still running
            setTimeout(() => {
                try {
                    job.childProcess.kill('SIGKILL');
                } catch(e) {}
            }, 2000);
        } catch(e) {
            console.error('[API] Error killing process:', e.message);
        }
    } else if (childProcessMap.has(downloadId)) {
        // Fallback to global map
        const proc = childProcessMap.get(downloadId);
        try {
            proc.kill('SIGTERM');
            cancelled = true;
            const fallbackJob = activeDownloads.get(downloadId);
            if (fallbackJob) fallbackJob.status = 'cancelled';
        } catch(e) {
            console.error('[API] Error killing from map:', e.message);
        }
    } else {
        // Just mark as cancelled in active downloads
        if (job) {
            job.status = 'cancelled';
            job.error = 'Cancelled by user';
            cancelled = true;
        }
    }
    
    res.json({ success: cancelled, message: cancelled ? 'Download cancelled' : 'Download not found or already finished' });
});

// API Endpoint: Resume/Retry a failed or cancelled download
app.post('/api/resume/:id', (req, res) => {
    const downloadId = req.params.id;
    console.log('[API] Resume request for:', downloadId);
    
    const job = activeDownloads.get(downloadId);
    
    if (!job) {
        return res.status(404).json({ success: false, message: 'Download not found' });
    }
    
    if (job.status === 'error' || job.status === 'cancelled') {
        // Reset job status and re-execute
        job.status = 'downloading';
        job.progress = 0;
        job.error = null;
        
        // Re-execute the download with stored info
        const reqBody = {
            videoId: job.videoId,
            title: job.title,
            quality: 'worst',
            format: 'mp4'
        };
        
        executeDownload(reqBody, null, downloadId);
        
        res.json({ success: true, message: 'Download restarted' });
    } else {
        res.json({ success: false, message: 'Only failed or cancelled downloads can be resumed' });
    }
});

// API Endpoint: Remove download item from list
app.delete('/api/download/:id', (req, res) => {
    const downloadId = req.params.id;
    console.log('[API] Remove request for:', downloadId);
    
    // Kill process if running
    const job = activeDownloads.get(downloadId);
    if (job && job.childProcess) {
        try { job.childProcess.kill('SIGKILL'); } catch(e) {}
    }
    childProcessMap.delete(downloadId);
    
    // Remove from active downloads
    const removed = activeDownloads.delete(downloadId);
    
    res.json({ success: removed, message: removed ? 'Download removed' : 'Download not found' });
});

// API Endpoint: Clear completed/failed downloads
app.delete('/api/downloads/clear', (req, res) => {
    console.log('[API] Clear completed downloads');
    let clearedCount = 0;
    
    for (const [id, job] of activeDownloads.entries()) {
        if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
            // Kill if somehow still running
            if (job.childProcess) {
                try { job.childProcess.kill('SIGKILL'); } catch(e) {}
            }
            childProcessMap.delete(id);
            activeDownloads.delete(id);
            clearedCount++;
        }
    }
    
    res.json({ success: true, message: `Cleared ${clearedCount} downloads`, clearedCount: clearedCount });
});

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
    } else {
        console.log('🔄 Checking for yt-dlp updates...');
        updateYtDlp().then(function(result) {
            if (result.updated) {
                console.log('✅ yt-dlp updated: ' + result.beforeVersion + ' → ' + result.afterVersion);
            } else if (result.success) {
                console.log('✅ yt-dlp is up to date (' + result.afterVersion + ')');
            } else {
                console.error('⚠️  yt-dlp auto-update failed. Update manually with: pip install -U yt-dlp');
            }
        }).catch(function(error) {
            console.error('⚠️  yt-dlp auto-update error:', error.message);
        });
    }
});
