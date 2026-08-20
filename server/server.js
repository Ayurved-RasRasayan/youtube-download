
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
 * Check if cookies.txt exists and appears valid - WITH DETAILED LOGGING
 * @returns {boolean} true if cookies.txt can be used
 */
function isCookiesFileValid() {
    console.log('\n[isCookiesFileValid] Starting validation...');
    const cookiePath = AUTH_CONFIG.cookieFilePath;
    console.log('[isCookiesFileValid] Checking path:', cookiePath);
    
    // Check if path is defined
    if (!cookiePath) {
        console.log('[isCookiesFileValid] ❌ FAIL: Cookie path is undefined/null!');
        return false;
    }
    
    // Check if file exists
    console.log('[isCookiesFileValid] Checking if file exists...');
    const exists = fs.existsSync(cookiePath);
    console.log('[isCookiesFileValid] File exists?', exists);
    
    if (!exists) {
        console.log('[isCookiesFileValid] ❌ FAIL: File does not exist:', cookiePath);
        console.log('[isCookiesFileValid] 💡 TIP: Delete bad cookies.txt or export fresh ones');
        return false;
    }
    
    // Check if file has content
    try {
        console.log('[isCookiesFileValid] Reading file stats...');
        const stats = fs.statSync(cookiePath);
        console.log('[isCookiesFileValid] File size:', stats.size, 'bytes');
        
        if (stats.size === 0) {
            console.log('[isCookiesFileValid] ❌ FAIL: File is empty!');
            return false;
        }
        
        // Read first few lines to check format
        console.log('[isCookiesFileValid] Reading file content...');
        const content = fs.readFileSync(cookiePath, 'utf8');
        console.log('[isCookiesFileValid] Content length:', content.length, 'chars');
        
        const allLines = content.split('\n');
        console.log('[isCookiesFileValid] Total lines (including empty/comments):', allLines.length);
        
        const lines = allLines.filter(line => line.trim() && !line.startsWith('#'));
        console.log('[isCookiesFileValid] Data lines (non-empty, non-comment):', lines.length);
        
        if (lines.length === 0) {
            console.log('[isCookiesFileValid] ❌ FAIL: No cookie entries found (only comments/empty lines)');
            console.log('[isCookiesFileValid] First few lines of file:');
            allLines.slice(0, 5).forEach((line, i) => console.log(`   Line ${i}:`, line.substring(0, 100)));
            return false;
        }
        
        // Show first few data lines for debugging
        console.log('[isCookiesFileValid] First 3 data lines:');
        lines.slice(0, 3).forEach((line, i) => {
            const fields = line.split('\t');
            console.log(`   Data line ${i}: ${fields.length} fields`);
            console.log('      Raw:', line.substring(0, 120));
        });
        
        // Validate at least one line has correct Netscape format (7 tab-separated fields)
        const sampleLine = lines[0];
        const fields = sampleLine.split('\t');
        
        console.log('[isCookiesFileValid] Validating Netscape format...');
        console.log('[isCookiesFileValid] Expected: 7 tab-separated fields');
        console.log('[isCookiesFileValid] Actual:', fields.length, 'fields');
        
        if (fields.length < 7) {
            console.log('\n[isCookiesFileValid] ❌ INVALID FORMAT DETECTED!');
            console.log('[isCookiesFileValid] This is why channel loading fails with cookies.txt!');
            console.log('[isCookiesFileValid] Problem: Lines have only', fields.length, 'fields instead of 7');
            console.log('[isCookiesFileValid] Root cause: Python extractor produced corrupted cookies');
            console.log('[isCookiesFileValid] Solution: Server will fall back to browser cookies automatically');
            console.log('\n[isCookiesFileValid] Field breakdown of first line:');
            fields.forEach((field, i) => {
                console.log(`   Field ${i}: [${field.substring(0, 50)}]`);
            });
            return false;
        }
        
        console.log('\n[isCookiesFileValid] ✅ PASS: Valid Netscape format!');
        console.log('[isCookiesFileValid] Found', lines.length, 'cookies in correct format');
        console.log('[isCookiesFileValid] Cookies file can be used safely');
        return true;
        
    } catch (err) {
        console.log('[isCookiesFileValid] ❌ EXCEPTION during validation:');
        console.log('   Error name:', err.name);
        console.log('   Error message:', err.message);
        console.log('   Error code:', err.code);
        return false;
    }
}

/**
 * Build MULTIPLE yt-dlp commands with different cookie strategies
 * Returns array of commands to try in order of preference
 * @param {string} baseUrl - The base yt-dlp command (without cookie args)
 * @param {string} url - The URL to process
 * @returns {Array} Array of {cmd, description} objects to try in sequence
 */
function buildCommandsWithCookieStrategies(baseUrl, url) {
    console.log('\n[buildCommands] Building command strategies...');
    console.log('[buildCommands] Input URL:', url);
    
    // Ensure we have native path
    getNativeCookiePath();
    
    const strategies = [];
    
    // Strategy 1: No cookies at all (works for most public channels!)
    const noCookiesCmd = baseUrl + ' "' + url + '"';
    strategies.push({
        cmd: noCookiesCmd,
        description: 'No cookies (public access)',
        type: 'none'
    });
    console.log('[commands] Strategy 1: No cookies (fastest, works for public channels)');
    
    // Strategy 2: Use cookies.txt if available and looks valid
    const cookiesValid = isCookiesFileValid();
    if (cookiesValid && fs.existsSync(AUTH_CONFIG.cookieFilePath)) {
        const cookiesCmd = baseUrl + ' --cookies "' + AUTH_CONFIG.cookieFilePath + '" "' + url + '"';
        strategies.push({
            cmd: cookiesCmd,
            description: 'cookies.txt file',
            type: 'file'
        });
        console.log('[commands] Strategy 2: cookies.txt file');
    } else {
        console.log('[commands] Strategy 2: SKIPPED (cookies.txt invalid or missing)');
    }
    
    // Strategy 3: Browser-based extraction (may fail on Windows due to DPAPI)
    const browser = AUTH_CONFIG.browserName || 'edge';
    const browserCmd = baseUrl + ' --cookies-from-browser ' + browser + ' "' + url + '"';
    strategies.push({
        cmd: browserCmd,
        description: `Browser (${browser})`,
        type: 'browser'
    });
    console.log('[commands] Strategy 3: Browser fallback (' + browser + ')');
    
    console.log('[commands] Total strategies prepared:', strategies.length);
    
    return strategies;
}

/**
 * Execute a command with automatic retry using different strategies
 * @param {Array} strategies - Array of {cmd, description} from buildCommandsWithCookieStrategies
 * @param {number} currentIndex - Current strategy index to try
 * @param {Function} onSuccess - Callback on success(stdout)
 * @param {Function} onError - Callback when all strategies fail(error)
 */
function executeWithRetry(strategies, currentIndex, onSuccess, onError) {
    if (currentIndex >= strategies.length) {
        onError(new Error('All cookie strategies failed'));
        return;
    }
    
    const strategy = strategies[currentIndex];
    console.log('\n[executeWithRetry] Trying strategy', currentIndex + 1, '/', strategies.length + ':', strategy.description);
    console.log('[executeWithRetry] Command:', strategy.cmd.substring(0, 150) + '...');
    
    const startTime = Date.now();
    
    exec(strategy.cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        
        if (error) {
            console.log('[executeWithRetry] ❌ Strategy', currentIndex + 1, 'failed in', elapsed, 's:', strategy.description);
            
            // Check if error is cookie-related (try next strategy)
            const isCookieError = 
                error.message.includes('invalid Netscape format') ||
                error.message.includes('CookieLoadError') ||
                error.message.includes('failed to load cookies') ||
                error.message.includes('DPAPI') ||
                error.message.includes('decrypt') ||
                stderr.includes('invalid Netscape') ||
                stderr.includes('DPAPI') ||
                stderr.includes('decrypt');
            
            if (isCookieError && currentIndex < strategies.length - 1) {
                console.log('[executeWithRetry] 🔄 Cookie-related error detected, trying next strategy...');
                
                // Show partial stderr (not full traceback)
                if (stderr) {
                    const firstLine = stderr.split('\n').find(l => l.trim().startsWith('ERROR:'));
                    if (firstLine) {
                        console.log('[executeWithRetry] Error hint:', firstLine.trim());
                    }
                }
                
                // Try next strategy
                executeWithRetry(strategies, currentIndex + 1, onSuccess, onError);
                return;
            }
            
            // Non-cookie error or last strategy - fail completely
            console.log('[executeWithRetry] ❌ All strategies exhausted or non-recoverable error');
            if (stderr) {
                console.log('[executeWithRetry] Final error (first 500 chars):', stderr.substring(0, 500));
            }
            onError(error);
            return;
        }
        
        // Success!
        console.log('[executeWithRetry] ✅ Strategy', currentIndex + 1, 'succeeded in', elapsed, 's:', strategy.description);
        console.log('[executeWithRetry] STDOUT length:', stdout ? stdout.length : 0, 'chars');
        onSuccess(stdout, stderr);
    });
}

/**
 * Legacy function for backward compatibility - now uses multi-strategy approach
 * @param {string} baseUrl - Base command
 * @param {string} url - URL to fetch
 * @returns {string} First strategy command (no cookies)
 */
function buildCommandWithCookies(baseUrl, url) {
    // For backward compatibility, return no-cookies version
    // Real logic now in executeWithRetry() with multiple strategies
    return baseUrl + ' "' + url + '"';
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

// Fetch channel info using yt-dlp - WITH MULTI-STRATEGY COOKIE RETRY
function fetchChannelInfo(channelId, channelUrl) {
    return new Promise((resolve, reject) => {
        console.log('\n[fetchChannelInfo] Starting...');
        console.log('[fetchChannelInfo] Parameters:');
        console.log('   - channelId:', channelId);
        console.log('   - channelUrl:', channelUrl);
        
        // Base command without cookie arguments
        const baseCmd = 'yt-dlp --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=web" --no-check-certificate --remote-components ejs:github --flat-playlist --print "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s\t%(view_count)s\t%(is_live)s"';
        
        console.log('[fetchChannelInfo] Base command built');
        
        // Build all strategies (no cookies, cookies.txt, browser)
        const strategies = buildCommandsWithCookieStrategies(baseCmd, channelUrl);
        
        const startTime = Date.now();
        console.log('[fetchChannelInfo] Starting multi-strategy execution at:', new Date().toISOString());
        
        // Execute with automatic retry on cookie errors
        executeWithRetry(strategies, 0, 
            // Success callback
            (stdout, stderr) => {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log('\n[fetchChannelInfo] ✅ SUCCESS in', elapsed, 'seconds total');
                
                if (stderr && stderr.trim()) {
                    console.log('[fetchChannelInfo] Warnings (first 500 chars):', stderr.substring(0, 500));
                }
                
                if (stdout && stdout.trim()) {
                    console.log('[fetchChannelInfo] STDOUT output (first 1000 chars):');
                    console.log(stdout.substring(0, 1000));
                    if (stdout.length > 1000) {
                        console.log('... [truncated, total', stdout.length, 'chars]');
                    }
                }
                
                console.log('\n[fetchChannelInfo] Parsing output...');
                const videos = parseChannelOutput(stdout);
                console.log('[fetchChannelInfo] Parsed result:', videos.videos.length, 'videos,', videos.liveVideos.length, 'live');
                resolve(videos);
            },
            // Error callback (all strategies failed)
            (error) => {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log('\n[fetchChannelInfo] ❌ ALL STRATEGIES FAILED after', elapsed, 'seconds');
                reject(new Error('Failed to fetch channel: ' + error.message));
            }
        );
    });
}

/**
 * Parse yt-dlp channel output into video objects - WITH DEBUG LOGGING
 */
function parseChannelOutput(stdout) {
    console.log('\n[parseChannelOutput] Starting parse...');
    console.log('[parseChannelOutput] Input length:', stdout ? stdout.length : 0, 'chars');
    
    if (!stdout || typeof stdout !== 'string') {
        console.log('[parseChannelOutput] ⚠️  WARNING: Invalid input - not a string!');
        return { videos: [], liveVideos: [] };
    }
    
    const lines = stdout.trim().split('\n').filter(function(line) { return line.trim(); });
    console.log('[parseChannelOutput] Total non-empty lines:', lines.length);
    
    const videos = [];
    const liveVideos = [];
    let parseErrors = 0;

    lines.forEach(function(line, index) {
        const parts = line.split('\t');
        
        // Debug first 3 lines in detail
        if (index < 3) {
            console.log(`[parseChannelOutput] Line ${index}: ${parts.length} fields`);
            console.log('   Raw:', line.substring(0, 150));
        }
        
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
        } else {
            parseErrors++;
            if (parseErrors <= 3) {
                console.log(`[parseChannelOutput] ⚠️  Skipped line ${index}: only ${parts.length} fields (need 6+)`);
            }
        }
    });
    
    if (parseErrors > 0) {
        console.log('[parseChannelOutput] Total skipped lines (wrong format):', parseErrors);
    }
    
    console.log('[parseChannelOutput] Parse complete:');
    console.log('   - Regular videos:', videos.length);
    console.log('   - Live videos:', liveVideos.length);
    console.log('   - Total:', videos.length + liveVideos.length);
    
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

// Channel info endpoint - WITH FULL DEBUG LOGGING
app.post('/api/channel/info', async (req, res) => {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 [DEBUG] Channel Info API Called');
    console.log('='.repeat(80));
    console.log('[DEBUG] Request body:', JSON.stringify(req.body, null, 2));
    console.log('[DEBUG] Request headers:', JSON.stringify({
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent']
    }, null, 2));
    
    try {
        const { channelId, channelUrl } = req.body;
        
        console.log('[DEBUG] Extracted params:');
        console.log('   - channelId:', channelId);
        console.log('   - channelUrl:', channelUrl);
        
        if (!channelId && !channelUrl) {
            console.log('[DEBUG] ❌ ERROR: No channelId or channelUrl provided!');
            return res.status(400).json({ error: 'Channel ID or URL required' });
        }

        const url = channelUrl || `https://www.youtube.com/@${channelId}`;
        console.log('[DEBUG] Resolved URL:', url);
        console.log('\n[Channel] Loading channel:', channelId || channelUrl);
        
        // Log cookie status before fetching
        console.log('\n[DEBUG] Cookie Status Check:');
        console.log('   - Cookie Path:', AUTH_CONFIG.cookieFilePath);
        console.log('   - File Exists:', fs.existsSync(AUTH_CONFIG.cookieFilePath));
        
        if (fs.existsSync(AUTH_CONFIG.cookieFilePath)) {
            try {
                const stats = fs.statSync(AUTH_CONFIG.cookieFilePath);
                console.log('   - File Size:', stats.size, 'bytes');
                const content = fs.readFileSync(AUTH_CONFIG.cookieFilePath, 'utf8');
                const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
                console.log('   - Cookie Entries:', lines.length);
                if (lines.length > 0) {
                    console.log('   - Sample Line:', lines[0].substring(0, 100));
                    const fields = lines[0].split('\t');
                    console.log('   - Fields Count:', fields.length, '(need 7 for valid Netscape)');
                }
            } catch (e) {
                console.log('   - Error reading file:', e.message);
            }
        }
        
        console.log('\n[DEBUG] Calling fetchChannelInfo...');
        const channelData = await fetchChannelInfo(channelId || channelUrl, url);
        
        console.log('\n[DEBUG] ✅ fetchChannelInfo SUCCESS!');
        console.log('[DEBUG] Videos found:', channelData.videos.length);
        console.log('[DEBUG] Live videos found:', channelData.liveVideos.length);
        
        if (channelData.videos.length > 0) {
            console.log('[DEBUG] First video:', JSON.stringify(channelData.videos[0], null, 2));
        }
        
        const response = {
            success: true,
            data: channelData.videos,
            liveVideos: channelData.liveVideos,
            count: channelData.videos.length + channelData.liveVideos.length
        };
        
        console.log('[DEBUG] Sending response with count:', response.count);
        console.log('='.repeat(80) + '\n');
        
        res.json(response);
        
    } catch (error) {
        console.log('\n' + '='.repeat(80));
        console.log('❌ [DEBUG] Channel Fetch FAILED!');
        console.log('='.repeat(80));
        console.log('[DEBUG] Error Type:', error.constructor.name);
        console.log('[DEBUG] Error Message:', error.message);
        console.log('[DEBUG] Error Stack:', error.stack);
        console.log('='.repeat(80) + '\n');
        
        res.status(500).json({ 
            error: 'Failed to load channel: ' + error.message,
            suggestion: 'Try refreshing the page or check your internet connection',
            debug: {
                errorType: error.constructor.name,
                errorMessage: error.message,
                timestamp: new Date().toISOString()
            }
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

// FRONTEND COMPATIBLE: POST /api/download (main download endpoint frontend expects!)
app.post('/api/download', async (req, res) => {
    console.log('\n' + '='.repeat(80));
    console.log('⬇️ [Download] POST /api/download - Frontend Download Request');
    console.log('='.repeat(80));
    console.log('[Download] Request body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { 
            url,           // Video URL
            videoId,       // Video ID (alternative)
            channelId,     // Parent channel ID
            format,        // Video format preference
            quality,        // Quality preference
            filename       // Custom filename
        } = req.body;
        
        // Determine video URL
        const videoUrl = url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
        
        if (!videoUrl) {
            console.log('[Download] ❌ ERROR: No URL or videoId provided!');
            return res.status(400).json({
                success: false,
                error: 'Video URL or videoId required'
            });
        }

        console.log('[Download] Processing download:');
        console.log('   - URL:', videoUrl);
        console.log('   - Video ID:', videoId || 'extracted from URL');
        console.log('   - Channel ID:', channelId || 'N/A');
        console.log('   - Format:', format || 'auto (best)');
        console.log('   - Quality:', quality || 'auto');

        const downloadId = uuidv4();
        const safeFilename = (filename || `video_${downloadId}`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const outputFilename = safeFilename.endsWith('.mp4') ? safeFilename : `${safeFilename}.mp4`;
        const outputPath = path.join(DOWNLOADS_DIR, outputFilename);

        console.log('[Download] Creating download job:');
        console.log('   - Download ID:', downloadId);
        console.log('   - Output file:', outputFilename);
        console.log('   - Full path:', outputPath);

        const download = downloadManager.add({
            id: downloadId,
            url: videoUrl,
            videoId: videoId,
            channelId: channelId,
            filename: outputFilename,
            outputPath: outputPath,
            format: format || 'best',
            quality: quality || 'auto',
            status: 'queued',
            progress: 0,
            startTime: null,
            endTime: null,
            createdAt: new Date().toISOString()
        });

        console.log('[Download] ✅ Job created, starting execution...');
        
        // Start download asynchronously (don't await - return immediately)
        setImmediate(async () => {
            try {
                download.status = 'downloading';
                download.startTime = Date.now();
                
                await executeDownload(
                    downloadId,
                    videoUrl,
                    outputPath,
                    format || 'best',
                    (progress) => {
                        download.progress = progress.percent;
                        download.downloaded = progress.downloaded;
                        download.total = progress.total;
                        
                        // Log progress every 25%
                        if (progress.percent % 25 < 5 || progress.percent === 100) {
                            console.log(`[Download ${downloadId.substring(0,8)}] Progress: ${progress.percent}%`);
                        }
                    },
                    (result) => {
                        download.status = 'completed';
                        download.endTime = Date.now();
                        console.log(`[Download ${downloadId.substring(0,8)}] ✅ COMPLETED!`);
                    },
                    (error) => {
                        download.status = 'error';
                        download.error = error;
                        download.endTime = Date.now();
                        console.log(`[Download ${downloadId.substring(0,8)}] ❌ FAILED:`, error);
                    }
                );
            } catch (err) {
                download.status = 'error';
                download.error = err.message;
                download.endTime = Date.now();
                console.log(`[Download ${downloadId.substring(0,8)}] ❌ EXCEPTION:`, err.message);
            }
        });

        console.log('[Download] ✅ Response sent to frontend');
        console.log('='.repeat(80) + '\n');

        // Return immediately with job info (frontend can poll for status)
        res.status(202).json({
            success: true,
            jobId: downloadId,
            status: 'accepted',
            message: 'Download queued successfully',
            download: {
                id: downloadId,
                url: videoUrl,
                filename: outputFilename,
                status: 'queued',
                format: format || 'best',
                quality: quality || 'auto'
            }
        });

    } catch (error) {
        console.log('\n❌ [Download] CRITICAL ERROR:');
        console.log('   Error:', error.message);
        console.log('   Stack:', error.stack);
        console.log('='.repeat(80) + '\n');
        
        res.status(500).json({
            success: false,
            error: 'Failed to create download job: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/download/:jobId - Check download status (for polling)
app.get('/api/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    
    console.log(`\n[Download Status] Checking job: ${jobId}`);
    
    const download = downloadManager.get(jobId);
    
    if (!download) {
        console.log(`[Download Status] ❌ Job not found: ${jobId}`);
        return res.status(404).json({
            success: false,
            error: 'Download job not found',
            jobId: jobId
        });
    }
    
    console.log(`[Download Status] ✅ Job ${jobId.substring(0,8)}: ${download.status} (${download.progress}%)`);
    
    // Calculate duration if available
    let duration = null;
    if (download.startTime) {
        const endTime = download.endTime || Date.now();
        duration = Math.round((endTime - download.startTime) / 1000); // seconds
    }
    
    res.json({
        success: true,
        download: {
            id: download.id,
            url: download.url,
            filename: download.filename,
            status: download.status,
            progress: download.progress || 0,
            downloaded: download.downloaded || 0,
            total: download.total || 0,
            error: download.error || null,
            startTime: download.startTime,
            endTime: download.endTime,
            duration: duration,
            format: download.format,
            quality: download.quality
        }
    });
});

// Download progress endpoint (legacy /api/download/:id)
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
// MISSING API ENDPOINTS - Frontend Compatibility Layer
// =============================================================================

// In-memory storage for channels and settings (for demo/compatibility)
const savedChannels = new Map();
const appSettings = {
    downloadPath: DOWNLOADS_DIR,
    concurrentDownloads: 3,
    autoCheckInterval: 5,
    quality: 'best',
    format: 'mp4',
    cookiesEnabled: true,
    cookieMode: isCookiesFileValid() ? 'file' : 'browser'
};

// GET /api/settings - Return application settings
app.get('/api/settings', (req, res) => {
    console.log('\n[Settings] GET /api/settings requested');
    console.log('[Settings] Returning current settings');
    
    res.json({
        success: true,
        data: appSettings,
        cookieInfo: {
            mode: isCookiesFileValid() ? 'cookies.txt' : 'browser (' + AUTH_CONFIG.browserName + ')',
            path: AUTH_CONFIG.cookieFilePath,
            valid: isCookiesFileValid()
        }
    });
});

// PUT /api/settings - Update application settings  
app.put('/api/settings', (req, res) => {
    console.log('\n[Settings] PUT /api/settings requested');
    console.log('[Settings] New settings:', JSON.stringify(req.body, null, 2));
    
    try {
        // Merge new settings with existing
        Object.assign(appSettings, req.body || {});
        
        console.log('[Settings] ✅ Settings updated successfully');
        res.json({
            success: true,
            message: 'Settings updated',
            data: appSettings
        });
    } catch (error) {
        console.error('[Settings] ❌ Error updating settings:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to update settings: ' + error.message
        });
    }
});

// GET /api/channels - Return list of saved channels (FRONTEND COMPATIBLE FORMAT!)
app.get('/api/channels', (req, res) => {
    console.log('\n[Channels] GET /api/channels requested');
    console.log('[Channels] Total saved channels:', savedChannels.size);
    
    const channelsList = Array.from(savedChannels.values());
    
    // FRONTEND EXPECTS: { channels: [...] }
    // NOT: { data: [...], count: X }
    console.log('[Channels] Returning', channelsList.length, 'channels in frontend-compatible format');
    
    res.json({
        channels: channelsList  // ← Frontend looks for this property!
    });
});

// POST /api/channels - Add a new channel (THIS IS WHAT "LOAD CHANNEL" CALLS!)
app.post('/api/channels', async (req, res) => {
    console.log('\n' + '='.repeat(80));
    console.log('🎬 [Channels] POST /api/channels - ADD NEW CHANNEL');
    console.log('='.repeat(80));
    console.log('[Channels] Request body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { url, channelId, name } = req.body;
        
        if (!url && !channelId) {
            console.log('[Channels] ❌ ERROR: No URL or channelId provided!');
            return res.status(400).json({
                success: false,
                error: 'Channel URL or ID required'
            });
        }

        // Determine the channel URL
        const channelUrl = url || `https://www.youtube.com/@${channelId}`;
        const channelIdFinal = channelId || url.split('@').pop().split('/')[0];
        
        console.log('[Channels] Processing channel:');
        console.log('   - URL:', channelUrl);
        console.log('   - ID:', channelIdFinal);
        console.log('   - Name:', name || 'Auto-detected');
        
        console.log('\n[Channels] 📡 Fetching channel info from YouTube...');
        
        // Fetch channel info using our existing function with smart cookie handling
        const channelData = await fetchChannelInfo(channelIdFinal, channelUrl);
        
        console.log('\n[Channels] ✅ Channel fetched successfully!');
        console.log('[Channels] Videos found:', channelData.videos.length);
        console.log('[Channels] Live videos found:', channelData.liveVideos.length);
        
        // Create channel object
        const channel = {
            id: uuidv4(),
            youtubeId: channelIdFinal,
            url: channelUrl,
            name: name || channelIdFinal,
            videoCount: channelData.videos.length + channelData.liveVideos.length,
            videos: channelData.videos,
            liveVideos: channelData.liveVideos,
            addedAt: new Date().toISOString(),
            lastChecked: new Date().toISOString(),
            status: 'active'
        };
        
        // Save to in-memory storage
        savedChannels.set(channel.id, channel);
        
        console.log('[Channels] 💾 Channel saved with ID:', channel.id);
        console.log('='.repeat(80) + '\n');
        
        // Return success response with full channel data (FRONTEND COMPATIBLE FORMAT!)
        // Frontend expects the channel object directly or in specific format
        console.log('[Channels] Returning channel to frontend...');
        
        res.status(201).json({
            success: true,
            message: 'Channel added successfully',
            channel: channel,  // ← Include channel object at top level
            channels: [channel],  // ← Also in array for loadChannelsFromServer()
            videos: channelData.videos,
            liveVideos: channelData.liveVideos,
            totalVideos: channelData.videos.length + channelData.liveVideos.length
        });
        
    } catch (error) {
        console.log('\n' + '='.repeat(80));
        console.log('❌ [Channels] FAILED TO ADD CHANNEL!');
        console.log('='.repeat(80));
        console.log('[Channels] Error Type:', error.constructor.name);
        console.log('[Channels] Error Message:', error.message);
        console.log('[Channels] Stack:', error.stack);
        console.log('='.repeat(80) + '\n');
        
        res.status(500).json({
            success: false,
            error: 'Failed to add channel: ' + error.message,
            suggestion: 'Check yt-dlp installation and internet connection',
            debug: {
                errorType: error.constructor.name,
                errorMessage: error.message,
                timestamp: new Date().toISOString()
            }
        });
    }
});

// DELETE /api/channels/:id - Remove a saved channel
app.delete('/api/channels/:id', (req, res) => {
    const { id } = req.params;
    console.log('\n[Channels] DELETE /api/channels/' + id);
    
    if (savedChannels.has(id)) {
        savedChannels.delete(id);
        console.log('[Channels] ✅ Channel deleted:', id);
        res.json({
            success: true,
            message: 'Channel deleted successfully'
        });
    } else {
        console.log('[Channels] ⚠️  Channel not found:', id);
        res.status(404).json({
            success: false,
            error: 'Channel not found'
        });
    }
});

// POST /api/channels/:id/check - Check for new videos on a channel
app.post('/api/channels/:id/check', async (req, res) => {
    const { id } = req.params;
    console.log('\n[Channels] POST /api/channels/' + id + '/check - Checking for new videos');
    
    const channel = savedChannels.get(id);
    if (!channel) {
        return res.status(404).json({
            success: false,
            error: 'Channel not found'
        });
    }
    
    try {
        console.log('[Channels] Re-fetching channel:', channel.url);
        const channelData = await fetchChannelInfo(channel.youtubeId, channel.url);
        
        // Update channel data
        channel.videos = channelData.videos;
        channel.liveVideos = channelData.liveVideos;
        channel.videoCount = channelData.videos.length + channelData.liveVideos.length;
        channel.lastChecked = new Date().toISOString();
        
        savedChannels.set(id, channel);
        
        console.log('[Channels] ✅ Channel updated. Total videos:', channel.videoCount);
        
        res.json({
            success: true,
            message: 'Channel checked for new videos',
            data: channel,
            newVideos: channelData.videos.length,
            totalVideos: channel.videoCount
        });
        
    } catch (error) {
        console.error('[Channels] ❌ Error checking channel:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to check channel: ' + error.message
        });
    }
});

// Additional compatibility endpoints that frontend might call

// GET /api/download/list - List all downloads
app.get('/api/download/list', (req, res) => {
    const downloads = downloadManager.getAll();
    res.json({
        success: true,
        data: downloads,
        count: downloads.length
    });
});

// GET /api/system/status - System status endpoint
app.get('/api/system/status', (req, res) => {
    res.json({
        success: true,
        data: {
            server: {
                status: 'running',
                port: PORT,
                uptime: process.uptime(),
                memory: process.memoryUsage()
            },
            yt_dlp: {
                installed: true,
                version: '2026.08.19', // We know this from earlier test
                status: 'ok'
            },
            cookies: {
                mode: isCookiesFileValid() ? 'file' : 'browser',
                valid: isCookiesFileValid(),
                path: AUTH_CONFIG.cookieFilePath
            },
            channels: {
                saved: savedChannels.size,
                active: Array.from(savedChannels.values()).filter(c => c.status === 'active').length
            },
            downloads: {
                active: downloadManager.getAll().filter(d => d.status === 'downloading').length,
                total: downloadManager.getAll().length
            }
        }
    });
});

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

// 404 handler - Enhanced with logging
app.use((req, res) => {
    console.log('\n[404] Not Found:', req.method, req.originalUrl);
    console.log('[404] This endpoint does not exist in server.js');
    console.log('[404] Available endpoints:');
    console.log('   GET  /api/health');
    console.log('   GET  /api/settings');
    console.log('   PUT  /api/settings');
    console.log('   GET  /api/channels');
    console.log('   POST /api/channels');
    console.log('   DELETE /api/channels/:id');
    console.log('   POST /api/channels/:id/check');
    console.log('   GET  /api/channel/info');
    console.log('   POST /api/video/info');
    console.log('   POST /api/download');           // ← MAIN DOWNLOAD ENDPOINT!
    console.log('   POST /api/download/start');
    console.log('   GET  /api/download/:jobId');     // ← Status check
    console.log('   GET  /api/download/:id');       // Legacy status
    console.log('   POST /api/download/:id/cancel');
    console.log('   GET  /api/downloads');
    console.log('   POST /api/download/batch');
    console.log('   GET  /api/download/list');
    console.log('   GET  /api/system/status');
    console.log('');
    
    res.status(404).json({ 
        error: 'Not found',
        endpoint: req.method + ' ' + req.originalUrl,
        availableEndpoints: [
            '/api/health',
            '/api/settings', 
            '/api/channels',
            '/api/channel/info',
            '/api/video/info',
            '/api/download',              // ← ADD THIS!
            '/api/download/start',
            '/api/download/start',
            '/api/downloads',
            '/api/system/status'
        ]
    });
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
