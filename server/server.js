
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// =============================================================================
// PATH CONVERSION - Convert Cygwin/Unix paths to Native OS paths
// =============================================================================

function toNativePath(unixStylePath) {
    // If already a native Windows path (starts with drive letter), return as-is
    if (/^[A-Za-z]:\\/.test(unixStylePath) || /^[A-Za-z]:\//.test(unixStylePath)) {
        return unixStylePath;
    }
    
    // Convert Cygwin/MSYS paths (/c/Users/... -> C:\Users\...)
    if (unixStylePath.startsWith('/') && unixStylePath.length >= 3 && 
        /^[a-zA-Z]/.test(unixStylePath.charAt(1))) {
        // Looks like /c/path or /d/path - convert to C:\path or D:\path
        const driveLetter = unixStylePath.charAt(1).toUpperCase();
        const restOfPath = unixStylePath.slice(2).replace(/\//g, '\\');
        const windowsPath = driveLetter + ':\\' + restOfPath;
        
        console.log('[Path Conversion] Cygwin -> Windows:');
        console.log('   FROM:', unixStylePath);
        console.log('   TO:  ', windowsPath);
        
        return windowsPath;
    }
    
    // For other Unix-style paths, use path.resolve to get absolute path
    const resolved = path.resolve(unixStylePath);
    console.log('[Path Conversion] Resolved:', unixStylePath, '->', resolved);
    
    return resolved;
}

function findIndexHtml() {
    const possiblePaths = [
        path.join(__dirname, '../public/index.html'),
        path.join(__dirname, '../../public/index.html'),
        path.join(process.cwd(), '../public/index.html'),
        path.join(process.cwd(), 'public/index.html'),
    ];
    
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) { 
            console.log('[findIndexHtml] FOUND:', p); 
            return p; 
        }
    }
    
    console.log('[findIndexHtml] NOT FOUND in any location');
    return null;
}

function resolvePublicPath(relativePath) {
    const possiblePaths = [
        path.join(__dirname, '../public', relativePath),
        path.join(process.cwd(), '..', 'public', relativePath),
        path.resolve(__dirname, '..', 'public', relativePath),
    ];
    
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) return p;
    }
    
    return possiblePaths[0];
}

// =============================================================================
// COOKIE MANAGEMENT - Smart detection and fallback
// =============================================================================

function getNativeCookiePath() {
    const originalPath = AUTH_CONFIG.cookieFilePath;
    const nativePath = toNativePath(originalPath);
    
    // Update config with native path
    AUTH_CONFIG.cookieFilePath = nativePath;
    
    console.log('[Cookie Path] Original:', originalPath);
    console.log('[Cookie Path] Native:   ', nativePath);
    
    return nativePath;
}

/**
 * Check if cookies.txt exists and appears valid
 * @returns {boolean} true if cookies.txt can be used
 */
function isCookiesFileValid() {
    const cookiePath = AUTH_CONFIG.cookieFilePath;
    
    // Check if file exists
    if (!cookiePath || !fs.existsSync(cookiePath)) {
        console.log('[Cookie Check] File does not exist:', cookiePath);
        return false;
    }
    
    // Check if file has content
    try {
        const stats = fs.statSync(cookiePath);
        if (stats.size === 0) {
            console.log('[Cookie Check] File is empty:', cookiePath);
            return false;
        }
        
        // Read first few lines to check format
        const content = fs.readFileSync(cookiePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'));
        
        if (lines.length === 0) {
            console.log('[Cookie Check] No cookie entries found');
            return false;
        }
        
        // Validate at least one line has correct Netscape format (7 tab-separated fields)
        const sampleLine = lines[0];
        const fields = sampleLine.split('\t');
        
        if (fields.length < 7) {
            console.log('[Cookie Check] INVALID FORMAT - line has only', fields.length, 'fields (need 7):');
            console.log('   Sample:', sampleLine.substring(0, 100) + (sampleLine.length > 100 ? '...' : ''));
            return false;
        }
        
        console.log('[Cookie Check] ✅ VALID - Found', lines.length, 'cookies in valid Netscape format');
        return true;
        
    } catch (err) {
        console.log('[Cookie Check] Error reading file:', err.message);
        return false;
    }
}

/**
 * Build yt-dlp command with smart cookie handling
 * Tries cookies.txt first, falls back to browser extraction
 * @param {string} baseUrl - The base yt-dlp command (without cookie args)
 * @param {string} url - The URL to process
 * @returns {string} Complete command string
 */
function buildCommandWithCookies(baseUrl, url) {
    // Ensure we have native path
    getNativeCookiePath();
    
    // Try to use cookies.txt if valid
    if (isCookiesFileValid()) {
        const cmd = baseUrl + ' --cookies "' + AUTH_CONFIG.cookieFilePath + '" "' + url + '"';
        console.log('[Command] Using cookies.txt file:', AUTH_CONFIG.cookieFilePath);
        return cmd;
    }
    
    // Fall back to browser-based cookie extraction
    const browser = AUTH_CONFIG.browserName || 'edge';
    const cmd = baseUrl + ' --cookies-from-browser ' + browser + ' "' + url + '"';
    console.log('[Command] Falling back to browser cookies:', browser);
    console.log('[Command] Reason: cookies.txt not available or invalid');
    
    return cmd;
}


// =============================================================================
// CONFIGURATION
// =============================================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Server configuration
const PORT = process.env.PORT || 3000;

// Download configuration
const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');

// Auth configuration - will be updated after path conversion
const AUTH_CONFIG = {
    cookieFilePath: path.join(process.cwd(), '..', 'cookies.txt'), // Will be converted to native path
    browserName: 'edge'
};

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// =============================================================================
// STATIC FILE SERVING - Robust frontend loading
// =============================================================================

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Root route - serve index.html with fallback
app.get('/', (req, res) => {
    const indexPath = findIndexHtml();
    
    if (indexPath && fs.existsSync(indexPath)) {
        console.log('[Root Route] Serving:', indexPath);
        res.sendFile(indexPath);
    } else {
        // Fallback: search for index.html in common locations
        const searchPaths = [
            path.join(__dirname, '..', 'public', 'index.html'),
            path.join(__dirname, '..', '..', 'public', 'index.html'),
            path.join(process.cwd(), 'public', 'index.html'),
        ];
        
        let found = false;
        for (const searchPath of searchPaths) {
            if (fs.existsSync(searchPath)) {
                console.log('[Root Route] Fallback found:', searchPath);
                res.sendFile(searchPath);
                found = true;
                break;
            }
        }
        
        if (!found) {
            res.status(200).json({ 
                message: 'YouTube Channel Downloader Server is running',
                port: PORT,
                api: '/api/health',
                status: 'ok'
            });
        }
    }
});

// API Routes
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        port: PORT,
        uptime: process.uptime(),
        cookieMode: isCookiesFileValid() ? 'cookies.txt' : 'browser (' + AUTH_CONFIG.browserName + ')',
        cookiePath: AUTH_CONFIG.cookieFilePath
    });
});

// =============================================================================
// DOWNLOAD MANAGEMENT
// =============================================================================

const activeDownloads = new Map();

class DownloadManager {
    constructor() {
        this.downloads = new Map();
        this.maxConcurrent = 3;
        this.activeCount = 0;
    }

    add(download) {
        this.downloads.set(download.id, download);
        return download;
    }

    get(id) {
        return this.downloads.get(id);
    }

    remove(id) {
        this.downloads.delete(id);
    }

    getAll() {
        return Array.from(this.downloads.values());
    }

    cancel(id) {
        const download = this.get(id);
        if (download && download.process) {
            download.process.kill('SIGTERM');
            download.status = 'cancelled';
        }
    }

    pause(id) {
        // Pause functionality would require more complex implementation
        const download = this.get(id);
        if (download) {
            download.status = 'paused';
        }
    }

    resume(id) {
        const download = this.get(id);
        if (download) {
            download.status = 'downloading';
        }
    }
}

const downloadManager = new DownloadManager();

// =============================================================================
// YT-DLP HELPERS
// =============================================================================

function formatDuration(seconds) {
    if (!seconds) return 'Live';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatViews(count) {
    if (!count) return 'No views';
    if (count >= 1000000000) return (count / 1000000000).toFixed(1) + 'B views';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M views';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K views';
    return count + ' views';
}

function formatDate(dateStr) {
    if (!dateStr) return 'Unknown';
    
    // Handle YYYYMMDD format
    if (dateStr.length === 8) {
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        return `${month}/${day}/${year}`;
    }
    
    return dateStr;
}

/**
 * Get the best format for downloading (lowest quality for faster downloads)
 */
function getBestFormat(formats) {
    if (!formats || formats.length === 0) return null;
    
    // Prefer mp4 formats with audio+video combined
    const mp4Formats = formats.filter(f => 
        f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none'
    );
    
    if (mp4Formats.length > 0) {
        // Sort by filesize (ascending) to get lowest quality
        mp4Formats.sort((a, b) => (a.filesize || Infinity) - (b.filesize || Infinity));
        return mp4Formats[0].format_id;
    }
    
    // Fallback to any combined format
    const combined = formats.filter(f => 
        f.vcodec !== 'none' && f.acodec !== 'none'
    );
    
    if (combined.length > 0) {
        combined.sort((a, b) => (a.filesize || Infinity) - (b.filesize || Infinity));
        return combined[0].format_id;
    }
    
    // Last resort: best video format
    const videoOnly = formats.filter(f => f.vcodec !== 'none').sort(
        (a, b) => (a.height || 0) - (b.height || 0)
    );
    
    return videoOnly.length > 0 ? videoOnly[0].format_id : 'best';
}

// =============================================================================
// CHANNEL FETCHING - WITH SMART COOKIE HANDLING
// =============================================================================

// Fetch channel info using yt-dlp
function fetchChannelInfo(channelId, channelUrl) {
    return new Promise((resolve, reject) => {
        // Base command without cookie arguments
        const baseCmd = 'yt-dlp --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=web" --no-check-certificate --remote-components ejs:github --flat-playlist --print "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s\t%(view_count)s\t%(is_live)s"';
        
        // Use smart cookie handling - tries cookies.txt, falls back to browser
        const cmd = buildCommandWithCookies(baseCmd, channelUrl);
        
        console.log('[Channel] Command:', cmd);

        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                // If cookies.txt failed but we haven't tried browser yet, retry with browser
                if (error.message.includes('invalid Netscape format') || 
                    error.message.includes('CookieLoadError') ||
                    error.message.includes('failed to load cookies')) {
                    
                    console.log('[Channel] Retrying with browser cookies due to invalid cookies.txt...');
                    
                    const browserCmd = baseCmd + ' --cookies-from-browser ' + AUTH_CONFIG.browserName + ' "' + channelUrl + '"';
                    
                    exec(browserCmd, { maxBuffer: 50 * 1024 * 1024 }, (retryError, retryStdout, retryStderr) => {
                        if (retryError) {
                            reject(new Error('Failed to fetch channel (browser fallback also failed): ' + retryError.message));
                            return;
                        }
                        
                        const videos = parseChannelOutput(retryStdout);
                        resolve(videos);
                    });
                    
                    return;
                }
                
                reject(new Error('Failed to fetch channel: ' + error.message));
                return;
            }

            const videos = parseChannelOutput(stdout);
            resolve(videos);
        });
    });
}

/**
 * Parse yt-dlp channel output into video objects
 */
function parseChannelOutput(stdout) {
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

    return { videos, liveVideos };
}

// =============================================================================
// VIDEO INFO EXTRACTION - WITH SMART COOKIE HANDLING
// =============================================================================

function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        // Base command without cookie arguments
        const baseCmd = 'yt-dlp --js-runtimes node --dump-json --no-check-certificate --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"';
        
        // Use smart cookie handling
        const cmd = buildCommandWithCookies(baseCmd, url);
        
        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                // Retry with browser cookies on failure
                if (error.message.includes('invalid Netscape format') || 
                    error.message.includes('CookieLoadError')) {
                    
                    console.log('[Video Info] Retrying with browser cookies...');
                    
                    const browserCmd = baseCmd + ' --cookies-from-browser ' + AUTH_CONFIG.browserName + ' "' + url + '"';
                    
                    exec(browserCmd, { maxBuffer: 50 * 1024 * 1024 }, (retryError, retryStdout) => {
                        if (retryError) {
                            reject(new Error('Failed to get video info: ' + retryError.message));
                            return;
                        }
                        
                        try {
                            const info = JSON.parse(retryStdout);
                            resolve(info);
                        } catch (e) {
                            reject(new Error('Failed to parse video info'));
                        }
                    });
                    
                    return;
                }
                
                reject(new Error('Failed to get video info: ' + error.message));
                return;
            }

            try {
                const info = JSON.parse(stdout);
                resolve(info);
            } catch (e) {
                reject(new Error('Failed to parse video info'));
            }
        });
    });
}

// =============================================================================
// DOWNLOAD EXECUTION - WITH SMART COOKIE HANDLING
// =============================================================================

function executeDownload(downloadId, url, outputPath, format, onProgress, onComplete, onError) {
    return new Promise((resolve, reject) => {
        // Build output template
        const outputTemplate = outputPath.replace(/\.[^.]+$/, '') + '.%(ext)s';
        
        // Build base command
        let baseCmd = 'yt-dlp --js-runtimes node';
        baseCmd += ' --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"';
        baseCmd += ' --no-check-certificate';
        baseCmd += ' -o "' + outputTemplate + '"';
        
        // Add format selection if specified
        if (format && format !== 'best') {
            baseCmd += ' -f "' + format + '"';
        } else {
            // Auto-select lowest quality for faster downloads
            baseCmd += ' -f "best[filesize<50M]/best[height<=480]/best"';
        }
        
        // Add progress hooks
        baseCmd += ' --progress-template "download:%(progress.downloaded_bytes)s/%(progress.total_bytes)s"';
        
        // Use smart cookie handling
        const cmd = buildCommandWithCookies(baseCmd, url);
        
        console.log('[Download] Starting:', cmd);

        const process = exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                // Retry with browser cookies on cookie-related failures
                if (error.message.includes('invalid Netscape format') || 
                    error.message.includes('CookieLoadError') ||
                    error.message.includes('failed to load cookies')) {
                    
                    console.log('[Download] Retrying with browser cookies...');
                    
                    let browserCmd = 'yt-dlp --js-runtimes node';
                    browserCmd += ' --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"';
                    browserCmd += ' --no-check-certificate';
                    browserCmd += ' --cookies-from-browser ' + AUTH_CONFIG.browserName;
                    browserCmd += ' -o "' + outputTemplate + '"';
                    
                    if (format && format !== 'best') {
                        browserCmd += ' -f "' + format + '"';
                    } else {
                        browserCmd += ' -f "best[filesize<50M]/best[height<=480]/best"';
                    }
                    
                    browserCmd += ' "' + url + '"';
                    
                    const retryProcess = exec(browserCmd, { maxBuffer: 50 * 1024 * 1024 }, (retryError, retryStdout) => {
                        if (retryError) {
                            onError(retryError.message);
                            reject(retryError);
                            return;
                        }
                        onComplete(retryStdout);
                        resolve(retryStdout);
                    });
                    
                    // Update process reference for cancellation
                    const download = downloadManager.get(downloadId);
                    if (download) {
                        download.process = retryProcess;
                    }
                    
                    return;
                }
                
                onError(error.message);
                reject(error);
                return;
            }
            
            onComplete(stdout);
            resolve(stdout);
        });

        // Store process reference for cancellation
        const download = downloadManager.get(downloadId);
        if (download) {
            download.process = process;
        }

        // Parse progress from stderr
        if (process.stderr) {
            process.stderr.on('data', (data) => {
                const output = data.toString();
                
                // Parse progress information
                const downloadMatch = output.match(/download:(\d+)\/(\d+)/);
                if (downloadMatch) {
                    const downloaded = parseInt(downloadMatch[1]) || 0;
                    const total = parseInt(downloadMatch[2]) || 0;
                    onProgress({
                        downloaded: downloaded,
                        total: total,
                        percent: total > 0 ? Math.round((downloaded / total) * 100) : 0
                    });
                }
                
                // Also try to parse percentage from yt-dlp output
                const percentMatch = output.match(/(\d+(?:\.\d+)?)%/);
                if (percentMatch && !downloadMatch) {
                    onProgress({
                        percent: parseFloat(percentMatch[1]),
                        downloaded: 0,
                        total: 0
                    });
                }
            });
        }
    });
}

// =============================================================================
// API ROUTES
// =============================================================================

// Channel info endpoint
app.post('/api/channel/info', async (req, res) => {
    try {
        const { channelId, channelUrl } = req.body;
        
        if (!channelId && !channelUrl) {
            return res.status(400).json({ error: 'Channel ID or URL required' });
        }

        console.log('\n[Channel] Loading channel:', channelId || channelUrl);
        
        const url = channelUrl || `https://www.youtube.com/@${channelId}`;
        const channelData = await fetchChannelInfo(channelId || channelUrl, url);
        
        res.json({
            success: true,
            data: channelData.videos,
            liveVideos: channelData.liveVideos,
            count: channelData.videos.length + channelData.liveVideos.length
        });
        
    } catch (error) {
        console.error('[Channel] Error:', error.message);
        res.status(500).json({ 
            error: 'Failed to load channel: ' + error.message,
            suggestion: 'Try refreshing the page or check your internet connection'
        });
    }
});

// Video info endpoint
app.post('/api/video/info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'Video URL required' });
        }

        const info = await getVideoInfo(url);
        
        res.json({
            success: true,
            data: {
                id: info.id,
                title: info.title,
                duration: info.duration,
                thumbnail: info.thumbnail,
                formats: info.formats || [],
                bestFormat: getBestFormat(info.formats)
            }
        });
        
    } catch (error) {
        console.error('[Video Info] Error:', error.message);
        res.status(500).json({ error: 'Failed to get video info: ' + error.message });
    }
});

// Start download endpoint
app.post('/api/download/start', async (req, res) => {
    try {
        const { url, format, quality } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'Video URL required' });
        }

        const downloadId = uuidv4();
        const filename = `video_${downloadId}.mp4`;
        const outputPath = path.join(DOWNLOADS_DIR, filename);

        const download = downloadManager.add({
            id: downloadId,
            url: url,
            filename: filename,
            outputPath: outputPath,
            status: 'downloading',
            progress: 0,
            startTime: Date.now()
        });

        // Start download
        executeDownload(
            downloadId,
            url,
            outputPath,
            format || 'best',
            (progress) => {
                download.progress = progress.percent;
                download.downloaded = progress.downloaded;
                download.total = progress.total;
            },
            (result) => {
                download.status = 'completed';
                download.endTime = Date.now();
            },
            (error) => {
                download.status = 'error';
                download.error = error;
                download.endTime = Date.now();
            }
        );

        res.json({
            success: true,
            downloadId: downloadId,
            message: 'Download started'
        });

    } catch (error) {
        console.error('[Download Start] Error:', error.message);
        res.status(500).json({ error: 'Failed to start download: ' + error.message });
    }
});

// Download progress endpoint
app.get('/api/download/:id', (req, res) => {
    const download = downloadManager.get(req.params.id);
    
    if (!download) {
        return res.status(404).json({ error: 'Download not found' });
    }

    res.json({
        success: true,
        data: download
    });
});

// Cancel download endpoint
app.post('/api/download/:id/cancel', (req, res) => {
    const download = downloadManager.get(req.params.id);
    
    if (!download) {
        return res.status(404).json({ error: 'Download not found' });
    }

    downloadManager.cancel(req.params.id);
    
    res.json({
        success: true,
        message: 'Download cancelled'
    });
});

// List all downloads endpoint
app.get('/api/downloads', (req, res) => {
    const downloads = downloadManager.getAll();
    
    res.json({
        success: true,
        data: downloads,
        count: downloads.length
    });
});

// Batch download endpoint (for multiple videos)
app.post('/api/download/batch', async (req, res) => {
    try {
        const { urls, format } = req.body;
        
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: 'Video URLs array required' });
        }

        const downloads = [];

        for (const url of urls) {
            const downloadId = uuidv4();
            const filename = `video_${downloadId}.mp4`;
            const outputPath = path.join(DOWNLOADS_DIR, filename);

            const download = downloadManager.add({
                id: downloadId,
                url: url,
                filename: filename,
                outputPath: outputPath,
                status: 'queued',
                progress: 0,
                startTime: Date.now()
            });

            downloads.push(downloadId);
        }

        res.json({
            success: true,
            downloads: downloads,
            message: `Queued ${downloads.length} downloads`
        });

        // Process downloads sequentially (respecting concurrent limit)
        processBatchDownloads(downloads, format);

    } catch (error) {
        console.error('[Batch Download] Error:', error.message);
        res.status(500).json({ error: 'Failed to start batch download: ' + error.message });
    }
});

async function processBatchDownloads(downloadIds, format) {
    for (const downloadId of downloadIds) {
        const download = downloadManager.get(downloadId);
        
        if (!download || download.status === 'cancelled') continue;

        download.status = 'downloading';

        await executeDownload(
            downloadId,
            download.url,
            download.outputPath,
            format || 'best',
            (progress) => {
                download.progress = progress.percent;
            },
            (result) => {
                download.status = 'completed';
                download.endTime = Date.now();
            },
            (error) => {
                download.status = 'error';
                download.error = error;
                download.endTime = Date.now();
            }
        );
    }
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((err, req, res, next) => {
    console.error('[Server Error]', err.stack);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

// Convert cookie path to native format on startup
getNativeCookiePath();

// Log cookie mode
console.log('\n' + '='.repeat(70));
console.log('🍪 COOKIE MODE DETECTION');
console.log('='.repeat(70));

if (isCookiesFileValid()) {
    console.log('✅ Mode: cookies.txt file (RECOMMENDED)');
    console.log('   Path:', AUTH_CONFIG.cookieFilePath);
} else {
    console.log('⚠️  Mode: Browser fallback (' + AUTH_CONFIG.browserName + ')');
    console.log('   Reason: cookies.txt not found or invalid format');
    console.log('');
    console.log('💡 TIP: For better reliability:');
    console.log('   1. Install "Get cookies.txt LOCALLY" browser extension');
    console.log('   2. Export YouTube cookies to: ' + path.join(process.cwd(), 'cookies.txt'));
    console.log('   3. Restart server');
}
console.log('='.repeat(70) + '\n');

// Start server
app.listen(PORT, () => {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                                                              ║');
    console.log('║                   🚀 SERVER STARTED! 🚀                      ║');
    console.log('║                                                              ║');
    console.log(`║  🌐 Server running at: http://localhost:${PORT}                     ║`);
    console.log(`║  🍪 Cookie Mode: ${isCookiesFileValid() ? 'cookies.txt ✅' : 'Browser (' + AUTH_CONFIG.browserName + ') ⚠️'}                  ║`);
    console.log('║                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Press Ctrl+C to stop the server');
});

module.exports = app;
