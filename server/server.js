
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
 * Build yt-dlp command with smart cookie handling - WITH DEBUG LOGGING
 * Tries cookies.txt first, falls back to browser extraction
 * @param {string} baseUrl - The base yt-dlp command (without cookie args)
 * @param {string} url - The URL to process
 * @returns {string} Complete command string
 */
function buildCommandWithCookies(baseUrl, url) {
    console.log('\n[buildCommandWithCookies] Building command...');
    console.log('[buildCommandWithCookies] Input URL:', url);
    
    // Ensure we have native path
    getNativeCookiePath();
    
    console.log('[buildCommandWithCookies] Cookie path after conversion:', AUTH_CONFIG.cookieFilePath);
    
    // Validate cookies file
    const cookiesValid = isCookiesFileValid();
    console.log('[buildCommandWithCookies] Cookies file valid?', cookiesValid);
    
    if (cookiesValid) {
        const cmd = baseUrl + ' --cookies "' + AUTH_CONFIG.cookieFilePath + '" "' + url + '"';
        console.log('[buildCommandWithCookies] ✅ Using cookies.txt file mode');
        console.log('[buildCommandWithCookies] Cookie path:', AUTH_CONFIG.cookieFilePath);
        console.log('[buildCommandWithCookies] Full command length:', cmd.length, 'chars');
        return cmd;
    }
    
    // Fall back to browser-based cookie extraction
    const browser = AUTH_CONFIG.browserName || 'edge';
    const cmd = baseUrl + ' --cookies-from-browser ' + browser + ' "' + url + '"';
    console.log('[buildCommandWithCookies] 🔄 Using browser fallback mode');
    console.log('[buildCommandWithCookies] Browser:', browser);
    console.log('[buildCommandWithCookies] Reason: cookies.txt not available or invalid');
    console.log('[buildCommandWithCookies] Full command length:', cmd.length, 'chars');
    
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

// Fetch channel info using yt-dlp - WITH FULL DEBUG LOGGING
function fetchChannelInfo(channelId, channelUrl) {
    return new Promise((resolve, reject) => {
        console.log('\n[fetchChannelInfo] Starting...');
        console.log('[fetchChannelInfo] Parameters:');
        console.log('   - channelId:', channelId);
        console.log('   - channelUrl:', channelUrl);
        
        // Base command without cookie arguments
        const baseCmd = 'yt-dlp --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=web" --no-check-certificate --remote-components ejs:github --flat-playlist --print "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s\t%(view_count)s\t%(is_live)s"';
        
        console.log('[fetchChannelInfo] Base command built');
        
        // Use smart cookie handling - tries cookies.txt, falls back to browser
        const cmd = buildCommandWithCookies(baseCmd, channelUrl);
        
        console.log('[fetchChannelInfo] Final command:');
        console.log('   ', cmd);
        console.log('[fetchChannelInfo] Command length:', cmd.length, 'characters');
        
        const startTime = Date.now();
        console.log('[fetchChannelInfo] Executing command at:', new Date().toISOString());

        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log('\n[fetchChannelInfo] Command completed in', elapsed, 'seconds');
            console.log('[fetchChannelInfo] Results:');
            console.log('   - error:', error ? error.message : 'null');
            console.log('   - stdout length:', stdout ? stdout.length : 0, 'chars');
            console.log('   - stderr length:', stderr ? stderr.length : 0, 'chars');
            
            if (stderr && stderr.trim()) {
                console.log('\n[fetchChannelInfo] STDERR output (first 2000 chars):');
                console.log(stderr.substring(0, 2000));
                if (stderr.length > 2000) {
                    console.log('... [truncated, total', stderr.length, 'chars]');
                }
            }
            
            if (stdout && stdout.trim()) {
                console.log('\n[fetchChannelInfo] STDOUT output (first 1500 chars):');
                console.log(stdout.substring(0, 1500));
                if (stdout.length > 1500) {
                    console.log('... [truncated, total', stdout.length, 'chars]');
                }
            }
            
            if (error) {
                console.log('\n[fetchChannelInfo] ❌ ERROR DETECTED:');
                console.log('   - Error code:', error.code);
                console.log('   - Error signal:', error.signal);
                console.log('   - Error message:', error.message);
                console.log('   - Killed:', error.killed);
                
                // If cookies.txt failed but we haven't tried browser yet, retry with browser
                if (error.message.includes('invalid Netscape format') || 
                    error.message.includes('CookieLoadError') ||
                    error.message.includes('failed to load cookies') ||
                    error.message.includes('invalid Netscape format')) {
                    
                    console.log('\n[fetchChannelInfo] 🔄 RETRYING WITH BROWSER COOKIES...');
                    console.log('[fetchChannelInfo] Reason: Invalid cookies.txt detected');
                    
                    const browserCmd = baseCmd + ' --cookies-from-browser ' + AUTH_CONFIG.browserName + ' "' + channelUrl + '"';
                    
                    console.log('[fetchChannelInfo] Browser fallback command:');
                    console.log('   ', browserCmd);
                    
                    exec(browserCmd, { maxBuffer: 50 * 1024 * 1024 }, (retryError, retryStdout, retryStderr) => {
                        const retryElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                        console.log('\n[fetchChannelInfo] Browser fallback completed in', retryElapsed, 'seconds total');
                        
                        if (retryError) {
                            console.log('[fetchChannelInfo] ❌ BROWSER FALLBACK ALSO FAILED:');
                            console.log('   - Error:', retryError.message);
                            
                            if (retryStderr) {
                                console.log('   - STDERR:', retryStderr.substring(0, 1000));
                            }
                            
                            reject(new Error('Failed to fetch channel (browser fallback also failed): ' + retryError.message));
                            return;
                        }
                        
                        console.log('[fetchChannelInfo] ✅ BROWSER FALLBACK SUCCEEDED!');
                        
                        if (retryStdout) {
                            console.log('[fetchChannelInfo] Browser stdout (first 1000 chars):');
                            console.log(retryStdout.substring(0, 1000));
                        }
                        
                        const videos = parseChannelOutput(retryStdout);
                        console.log('[fetchChannelInfo] Parsed result:', videos.videos.length, 'videos,', videos.liveVideos.length, 'live');
                        resolve(videos);
                    });
                    
                    return;
                }
                
                console.log('[fetchChannelInfo] Rejecting with error (no retry):');
                reject(new Error('Failed to fetch channel: ' + error.message));
                return;
            }

            console.log('\n[fetchChannelInfo] ✅ SUCCESS - Parsing output...');
            const videos = parseChannelOutput(stdout);
            console.log('[fetchChannelInfo] Parsed result:', videos.videos.length, 'videos,', videos.liveVideos.length, 'live');
            resolve(videos);
        });
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
