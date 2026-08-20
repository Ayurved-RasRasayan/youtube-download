
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
 * ⭐ NEW: Execute with REAL-TIME progress tracking using spawn()
 * Parses yt-dlp progress output and calls onProgress callback
 * Supports multi-strategy cookie fallback like executeWithRetry
 */
function executeWithProgress(strategies, currentIndex, downloadObj, onProgress, onSuccess, onError) {
    if (currentIndex >= strategies.length) {
        onError(new Error('All cookie strategies failed'));
        return;
    }
    
    const strategy = strategies[currentIndex];
    console.log('\n[executeWithProgress] Trying strategy', currentIndex + 1, '/', strategies.length + ':', strategy.description);
    console.log('[executeWithProgress] Command:', strategy.cmd.substring(0, 150), '...');
    
    const startTime = Date.now();
    
    // Use shell:true for Windows compatibility (finds yt-dlp in PATH)
    const childProcess = exec(strategy.cmd, { 
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true 
    }, (error, stdout, stderr) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        
        if (error) {
            console.log('[executeWithProgress] ❌ Strategy', currentIndex + 1, 'failed in', elapsed, 's');
            
            // Check if error is cookie-related (try next strategy)
            const isCookieError = 
                error.message.includes('invalid Netscape format') ||
                error.message.includes('CookieLoadError') ||
                error.message.includes('failed to load cookies') ||
                error.message.includes('DPAPI') ||
                error.message.includes('decrypt') ||
                (stderr && stderr.includes('invalid Netscape')) ||
                (stderr && stderr.includes('DPAPI')) ||
                (stderr && stderr.includes('decrypt'));
            
            if (isCookieError && currentIndex < strategies.length - 1) {
                console.log('[executeWithProgress] 🔄 Cookie-related error detected, trying next strategy...');
                executeWithProgress(strategies, currentIndex + 1, downloadObj, onProgress, onSuccess, onError);
                return;
            }
            
            // Non-cookie error or last strategy - fail completely
            console.log('[executeWithProgress] ❌ All strategies exhausted');
            if (stderr) {
                console.log('[executeWithProgress] Error (first 300 chars):', stderr.substring(0, 300));
            }
            onError(new Error(stderr.substring(0, 500) || error.message));
            return;
        }
        
        // Success!
        console.log('[executeWithProgress] ✅ Strategy', currentIndex + 1, 'completed in', elapsed, 's');
        console.log('[executeWithProgress] Output length:', stdout ? stdout.length : 0, 'chars');
        
        // Parse final output for any progress info
        if (stdout && onProgress) {
            const lines = stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/\[download\]\s+100%.*of\s+([\d.]+\w+)/);
                if (match) {
                    onProgress({ percent: 100, downloaded: match[1], total: match[1], speed: 'complete' });
                    break;
                }
            }
        }
        
        onSuccess(stdout, stderr);
    });
    
    // ⭐ REAL-TIME PROGRESS PARSING from stdout
    // This is the key fix - we parse progress as it happens!
    if (childProcess.stdout) {
        childProcess.stdout.on('data', (data) => {
            const output = data.toString();
            
            // Parse yt-dlp progress lines
            // Format: [download]  15.2% of 25.50MiB at 1.20MiB/s ETA 00:08
            const lines = output.split('\n');
            for (const line of lines) {
                const progressMatch = line.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+(\d+\.?\d*\w+)/);
                
                if (progressMatch && onProgress) {
                    const percent = parseFloat(progressMatch[1]);
                    const totalStr = progressMatch[2];
                    const speedMatch = line.match(/at\s+([\d.]+\w+\/s)/);
                    
                    // Update download object with real-time progress
                    if (downloadObj) {
                        downloadObj.progress = Math.round(percent);
                        downloadObj.total = totalStr;
                        if (speedMatch) {
                            downloadObj.speed = speedMatch[1];
                        }
                    }
                    
                    // Call the progress callback
                    onProgress({
                        percent: Math.round(percent),
                        downloaded: 'unknown',
                        total: totalStr,
                        speed: speedMatch ? speedMatch[1] : 'unknown'
                    });
                }
            }
        });
    }
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

// Download configuration - DEFAULT to user's Downloads folder!
function getDefaultDownloadsDir() {
    const os = require('os');
    
    if (process.platform === 'win32') {
        // Windows: C:\Users\Username\Downloads
        return path.join(os.homedir(), 'Downloads', 'YouTube-Downloader');
    } else if (process.platform === 'darwin') {
        // macOS: /Users/Username/Downloads/YouTube-Downloader
        return path.join(os.homedir(), 'Downloads', 'YouTube-Downloader');
    } else {
        // Linux: /home/username/Downloads/YouTube-Downloader
        return path.join(os.homedir(), 'Downloads', 'YouTube-Downloader');
    }
}

// Current downloads directory (can be changed at runtime!)
let DOWNLOADS_DIR = getDefaultDownloadsDir();

// App settings (persisted and changeable)
const appSettings = {
    downloadsDir: DOWNLOADS_DIR,
    quality: 'lowest',
    format: 'mp4',
    maxConcurrent: 1,  // Sequential downloads
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
};

// ⚡ Check for ffmpeg availability (required for merging video+audio)
let FFMPEG_AVAILABLE = false;
try {
    const { execSync } = require('child_process');
    execSync('ffmpeg -version', { stdio: 'pipe' });
    FFMPEG_AVAILABLE = true;
    console.log('✅ [FFmpeg] Found! Video+Audio merging enabled');
} catch (e) {
    console.log('⚠️ [FFmpeg] NOT FOUND! Downloads may not have audio.');
    console.log('   Install: winget install ffmpeg  (Windows)');
    console.log('   Or:     apt install ffmpeg      (Linux)');
}

// Auth configuration - will be updated after path conversion
const AUTH_CONFIG = {
    cookieFilePath: path.join(process.cwd(), '..', 'cookies.txt'), // Will be converted to native path
    browserName: 'edge'
};

// Ensure downloads directory exists
function ensureDownloadsDir() {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        console.log('✅ Created downloads directory:', DOWNLOADS_DIR);
    }
}
ensureDownloadsDir();

// =============================================================================
// VIDEO STATUS TRACKING - Track which videos are new vs downloaded
// =============================================================================

// In-memory set of downloaded video IDs (persisted across requests)
const downloadedVideos = new Set();  // Stores: videoId -> filename
const skippedVideos = new Set();    // Stores: videoId -> reason

/**
 * Check if a file already exists in the downloads directory
 * @param {string} filename - The filename to check
 * @returns {object} - { exists: boolean, path: string, size: number }
 */
function checkFileExists(filename) {
    // Try different possible extensions
    const extensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv'];
    const baseName = filename.replace(/\.[^.]+$/, ''); // Remove extension if present
    
    for (const ext of extensions) {
        const fullPath = path.join(DOWNLOADS_DIR, baseName + ext);
        if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            return {
                exists: true,
                path: fullPath,
                filename: baseName + ext,
                size: stats.size,
                sizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100,
                modified: stats.mtime
            };
        }
    }
    
    // Also check exact filename match
    const exactPath = path.join(DOWNLOADS_DIR, filename);
    if (fs.existsSync(exactPath)) {
        const stats = fs.statSync(exactPath);
        return {
            exists: true,
            path: exactPath,
            filename: filename,
            size: stats.size,
            sizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100,
            modified: stats.mtime
        };
    }
    
    return { exists: false, path: null, filename: null, size: 0, sizeMB: 0 };
}

/**
 * Scan downloads directory and populate downloadedVideos set
 * Call this on server startup to track already-downloaded files
 */
function scanExistingDownloads() {
    console.log('\n[Status Tracker] Scanning existing downloads in:', DOWNLOADS_DIR);
    
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        let count = 0;
        
        files.forEach(file => {
            if (file.endsWith('.mp4') || file.endsWith('.webm') || file.endsWith('.mkv')) {
                // Extract video ID from filename if possible (format: title_videoId.mp4 or just title.mp4)
                // For now, we'll use filename as the key
                downloadedVideos.add(file);
                count++;
            }
        });
        
        console.log('[Status Tracker] ✅ Found', count, 'existing downloaded files');
        console.log('[Status Tracker] Videos marked as "downloaded":', count);
        
    } catch (error) {
        console.log('[Status Tracker] ⚠️ Error scanning downloads:', error.message);
    }
}

/**
 * Get status of a specific video
 * @param {string} videoId - YouTube video ID
 * @param {string} title - Video title (used as fallback)
 * @returns {string} - 'new' | 'downloaded' | 'downloading' | 'skipped' | 'error'
 */
function getVideoStatus(videoId, title) {
    if (skippedVideos.has(videoId)) {
        return 'skipped';
    }
    
    // Check by video ID first
    if (downloadedVideos.has(videoId)) {
        return 'downloaded';
    }
    
    // Check by filename (title-based)
    if (title) {
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
        const possibleFiles = [
            safeTitle + '.mp4',
            safeTitle.substring(0, 100) + '.mp4'
        ];
        
        for (const file of possibleFiles) {
            if (downloadedVideos.has(file)) {
                return 'downloaded';
            }
            
            // Also check actual filesystem
            const fileInfo = checkFileExists(file);
            if (fileInfo.exists) {
                downloadedVideos.add(file); // Cache it
                return 'downloaded';
            }
        }
    }
    
    return 'new';
}

// Scan existing downloads on startup
scanExistingDownloads();

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

        // ⭐ NEW: Check if file already exists (skip download if so)
        const existingFile = checkFileExists(outputFilename);
        const videoTitle = req.body.title || filename || `video_${videoId}`;
        
        if (existingFile.exists) {
            console.log('\n[Download] ⚠️ FILE ALREADY EXISTS - SKIPPING DOWNLOAD');
            console.log('[Download] Existing file:', existingFile.filename);
            console.log('[Download] File size:', existingFile.sizeMB, 'MB');
            console.log('[Download] Last modified:', existingFile.modified);
            
            // Mark as downloaded in tracking
            downloadedVideos.add(videoId);
            downloadedVideos.add(existingFile.filename);
            
            // Return immediate success with "skipped" status
            return res.status(200).json({
                success: true,
                jobId: downloadId,
                status: 'skipped',
                message: 'File already exists, skipped download',
                download: {
                    id: downloadId,
                    url: videoUrl,
                    filename: existingFile.filename,
                    status: 'skipped',
                    progress: 100,
                    size: existingFile.sizeMB,
                    sizeMB: existingFile.sizeMB,
                    path: existingFile.path,
                    reason: 'already_exists',
                    skippedAt: new Date().toISOString()
                }
            });
        }

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

        console.log('[Download] ✅ Job created, starting SMART DOWNLOAD...');
        
        // Start SMART DOWNLOAD asynchronously (analyze formats → pick lowest → download)
        setImmediate(async () => {
            try {
                download.status = 'analyzing';  // Show "analyzing" status first
                download.startTime = Date.now();
                
                // Use SMART DOWNLOAD: analyzes formats, picks lowest quality, then downloads
                // ⭐ FIXED: Pass 'download' object as 4th parameter for status updates!
                await smartDownload(
                    downloadId,
                    videoUrl,
                    outputPath,
                    download,  // ⭐ PASS DOWNLOAD OBJECT so status can be updated to 'downloading'
                    (progress) => {
                        download.progress = progress.percent;
                        download.downloaded = progress.downloaded;
                        download.total = progress.total;
                        download.speed = progress.speed;
                        
                        // Log progress only when percentage changes (clean output)
                        const lastPercent = download._lastLoggedPercent || -1;
                        if (progress.percent !== lastPercent && (progress.percent % 5 === 0 || progress.percent === 100)) {
                            download._lastLoggedPercent = progress.percent;
                            const shortName = (download.filename || 'video').substring(0, 35);
                            const sizeInfo = download.total ? `${download.total}` : '';
                            console.log(`   ⬇️  ${shortName} | ${sizeInfo} | ${progress.percent}%`);
                        }
                    },
                    (result) => {
                        download.status = 'completed';
                        download.progress = 100;
                        download.endTime = Date.now();
                        
                        // ⭐ Mark as downloaded in tracking system
                        if (videoId) {
                            downloadedVideos.add(videoId);
                        }
                        if (download.filename) {
                            downloadedVideos.add(download.filename);
                        }
                        
                        const shortName = (download.filename || 'video').substring(0, 35);
                        console.log(`   ✅  ${shortName} | Download complete!`);
                    },
                    (error) => {
                        download.status = 'error';
                        download.error = error;
                        download.endTime = Date.now();
                        const shortName = (download.filename || 'video').substring(0, 35);
                        console.log(`   ❌  ${shortName} | Failed: ${error}`);
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

// =============================================================================
// FILE DOWNLOAD ENDPOINT - Serve completed files for download
// =============================================================================

/**
 * GET /api/download-file/:id - Download a completed video file
 * Returns the actual file for browser download
 */
app.get('/api/download-file/:id', (req, res) => {
    const downloadId = req.params.id;
    
    console.log('\n[File Download] Request for download ID:', downloadId);
    
    // Find the download record
    const download = downloadManager.get(downloadId);
    
    if (!download) {
        console.log('[File Download] ❌ Download not found:', downloadId);
        return res.status(404).json({
            success: false,
            error: 'Download not found'
        });
    }
    
    // Check if download is completed
    if (download.status !== 'completed' && download.status !== 'skipped') {
        console.log('[File Download] ❌ Not ready for download. Status:', download.status);
        return res.status(400).json({
            success: false,
            error: `Download not complete (status: ${download.status})`,
            status: download.status
        });
    }
    
    // Get the file path
    const filePath = download.outputPath || path.join(DOWNLOADS_DIR, download.filename);
    
    // Check if file exists on disk
    if (!fs.existsSync(filePath)) {
        // Try to find the file with different extensions
        const baseName = filePath.replace(/\.[^.]+$/, '');
        const extensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv'];
        let foundPath = null;
        
        for (const ext of extensions) {
            const testPath = baseName + ext;
            if (fs.existsSync(testPath)) {
                foundPath = testPath;
                break;
            }
        }
        
        if (!foundPath) {
            console.log('[File Download] ❌ File not found on disk:', filePath);
            return res.status(404).json({
                success: false,
                error: 'File not found on disk',
                expectedPath: filePath
            });
        }
        
        // Use found path
        res.sendFile(path.resolve(foundPath), {
            headers: {
                'Content-Disposition': `attachment; filename="${encodeURIComponent(download.title || 'video.mp4')}"`
            }
        });
        console.log('[File Download] ✅ Serving file (alternate extension):', foundPath);
        return;
    }
    
    // File exists - serve it for download
    const fileName = download.filename || download.title || 'video.mp4';
    console.log('[File Download] ✅ Serving file:', fileName, `(${download.sizeMB || '?'}MB)`);
    
    res.sendFile(path.resolve(filePath), {
        headers: {
            'Content-Type': 'video/mp4',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
        }
    });
});

/**
 * GET /api/files - List all downloaded files in downloads directory
 */
app.get('/api/files', (req, res) => {
    try {
        console.log('\n[Files] Listing downloaded files in:', DOWNLOADS_DIR);
        
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => !f.startsWith('.') && f.match(/\.(mp4|webm|mkv|avi|mov|flv|mp3|m4a)$/i))
            .map(filename => {
                const filePath = path.join(DOWNLOADS_DIR, filename);
                const stats = fs.statSync(filePath);
                return {
                    filename: filename,
                    size: stats.size,
                    sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                    modified: stats.mtime.toISOString(),
                    url: `/api/download-file/by-name/${encodeURIComponent(filename)}`,
                    downloadUrl: `/api/download-file/by-name/${encodeURIComponent(filename)}?download=true`
                };
            })
            .sort((a, b) => new Date(b.modified) - new Date(a.modified)); // Newest first
        
        console.log(`[Files] ✅ Found ${files.length} downloaded files`);
        
        res.json({
            success: true,
            files: files,
            count: files.length,
            directory: DOWNLOADS_DIR,
            totalSizeMB: files.reduce((sum, f) => sum + parseFloat(f.sizeMB), 0).toFixed(2)
        });
        
    } catch (error) {
        console.error('[Files] ❌ Error listing files:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to list files: ' + error.message
        });
    }
});

/**
 * GET /api/download-file/by-name/:filename - Download by exact filename
 */
app.get('/api/download-file/by-name/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const isDownload = req.query.download === 'true';
    
    console.log(`\n[File Download] Request for file: ${filename} (download: ${isDownload})`);
    
    // Security: Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({
            success: false,
            error: 'Invalid filename'
        });
    }
    
    const filePath = path.join(DOWNLOADS_DIR, filename);
    
    if (!fs.existsSync(filePath)) {
        console.log('[File Download] ❌ File not found:', filePath);
        return res.status(404).json({
            success: false,
            error: 'File not found',
            filename: filename
        });
    }
    
    const stats = fs.statSync(filePath);
    console.log(`[File Download] ✅ Serving: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    
    res.sendFile(path.resolve(filePath), {
        headers: {
            'Content-Type': getContentType(filename),
            'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(filename)}"`
        }
    });
});

// Helper to get content type based on extension
function getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.flv': 'video/x-flv',
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4'
    };
    return types[ext] || 'application/octet-stream';
}

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

// Update existing appSettings with additional frontend-compatible fields
appSettings.downloadPath = DOWNLOADS_DIR;
appSettings.concurrentDownloads = 3;
appSettings.autoCheckInterval = 5;
appSettings.cookiesEnabled = true;
appSettings.cookieMode = isCookiesFileValid() ? 'file' : 'browser';

// GET /api/settings - Return application settings
app.get('/api/settings', (req, res) => {
    // Silent - no logging (can be called frequently)
    
    // Get download folder details
    let dirExists = false;
    let fileCount = 0;
    let recentFiles = [];
    let totalSizeMB = 0;
    
    try {
        dirExists = fs.existsSync(DOWNLOADS_DIR);
        
        if (dirExists) {
            const files = fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => !f.startsWith('.') && f.match(/\.(mp4|webm|mkv|avi|mov|flv|mp3|m4a)$/i));
            
            fileCount = files.length;
            
            // Get recent files (last 5 by modification time)
            recentFiles = files.map(filename => {
                const filePath = path.join(DOWNLOADS_DIR, filename);
                const stats = fs.statSync(filePath);
                return {
                    name: filename,
                    size: stats.size,
                    sizeMB: (stats.size / 1024 / 1024).toFixed(2),
                    modified: stats.mtime.toISOString()
                };
            })
            .sort((a, b) => new Date(b.modified) - new Date(a.modified))
            .slice(0, 5);
            
            // Calculate total size
            totalSizeMB = recentFiles.reduce((sum, f) => sum + parseFloat(f.sizeMB), 0);
        }
    } catch (e) {
        // Ignore errors
    }
    
    res.json({
        success: true,
        data: {
            ...appSettings,
            currentDownloadsDir: DOWNLOADS_DIR,
            resolvedPath: path.resolve(DOWNLOADS_DIR),
            dirExists: dirExists,
            fileCount: fileCount,
            totalSizeMB: totalSizeMB.toFixed(2),
            recentFiles: recentFiles,
            defaultDir: getDefaultDownloadsDir(),
            isCustomDir: DOWNLOADS_DIR !== getDefaultDownloadsDir()
        },
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
        const { downloadsDir, quality, format } = req.body || {};
        
        // If downloadsDir is being changed, validate and update it
        if (downloadsDir && downloadsDir !== DOWNLOADS_DIR) {
            console.log('[Settings] 📁 Changing download folder...');
            console.log('   From:', DOWNLOADS_DIR);
            console.log('   To:  ', downloadsDir);
            
            // Validate path (prevent directory traversal attacks)
            const normalizedPath = path.normalize(downloadsDir);
            if (normalizedPath.includes('..')) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid path: directory traversal not allowed'
                });
            }
            
            // Try to create/access the new directory
            try {
                if (!fs.existsSync(normalizedPath)) {
                    fs.mkdirSync(normalizedPath, { recursive: true });
                    console.log('[Settings] ✅ Created new downloads folder:', normalizedPath);
                }
                
                // Update global variable
                DOWNLOADS_DIR = normalizedPath;
                appSettings.downloadsDir = normalizedPath;
                appSettings.updatedAt = new Date().toISOString();
                
                console.log('[Settings] ✅ Download folder changed successfully!');
                console.log('[Settings] New location:', DOWNLOADS_DIR);
                
            } catch (dirError) {
                console.error('[Settings] ❌ Failed to create directory:', dirError.message);
                return res.status(500).json({
                    success: false,
                    error: `Failed to create download directory: ${dirError.message}`
                });
            }
        }
        
        // Update other settings
        if (quality) appSettings.quality = quality;
        if (format) appSettings.format = format;
        appSettings.updatedAt = new Date().toISOString();
        
        console.log('[Settings] ✅ Settings updated successfully');
        res.json({
            success: true,
            message: downloadsDir ? 'Download folder updated!' : 'Settings updated',
            data: {
                ...appSettings,
                currentDownloadsDir: DOWNLOADS_DIR,
                dirExists: fs.existsSync(DOWNLOADS_DIR),
                fileCount: getDownloadedFilesCount()
            }
        });
    } catch (error) {
        console.error('[Settings] ❌ Error updating settings:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to update settings: ' + error.message
        });
    }
});

// Helper function to count downloaded files
function getDownloadedFilesCount() {
    try {
        if (!fs.existsSync(DOWNLOADS_DIR)) return 0;
        return fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => !f.startsWith('.') && f.match(/\.(mp4|webm|mkv|avi|mov|flv|mp3|m4a)$/i))
            .length;
    } catch (e) {
        return 0;
    }
}

// GET /api/settings - Get current application settings
app.get('/api/settings', (req, res) => {
    const files = [];
    
    try {
        if (fs.existsSync(DOWNLOADS_DIR)) {
            files = fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => !f.startsWith('.') && f.match(/\.(mp4|webm|mkv|avi|mov|flv|mp3|m4a)$/i))
                .map(f => {
                    const stats = fs.statSync(path.join(DOWNLOADS_DIR, f));
                    return { name: f, sizeMB: (stats.size / 1024 / 1024).toFixed(2) };
                })
                .slice(0, 5); // Last 5 files for preview
        }
    } catch (e) {}
    
    res.json({
        success: true,
        data: {
            ...appSettings,
            currentDownloadsDir: DOWNLOADS_DIR,
            resolvedPath: path.resolve(DOWNLOADS_DIR),
            dirExists: fs.existsSync(DOWNLOADS_DIR),
            fileCount: getDownloadedFilesCount(),
            recentFiles: files,
            platform: process.platform,
            defaultDir: getDefaultDownloadsDir()
        }
    });
});

// POST /api/settings/test-folder - Test if a folder is writable
app.post('/api/settings/test-folder', (req, res) => {
    const { folderPath } = req.body;
    
    if (!folderPath) {
        return res.status(400).json({ success: false, error: 'folderPath required' });
    }
    
    console.log('\n[Settings] Testing folder:', folderPath);
    
    try {
        const normalizedPath = path.normalize(folderPath);
        
        // Security check
        if (normalizedPath.includes('..') && !normalizedPath.startsWith(os.homedir())) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid path' 
            });
        }
        
        // Check if exists or can be created
        let exists = fs.existsSync(normalizedPath);
        let writable = false;
        
        if (!exists) {
            // Try to create
            fs.mkdirSync(normalizedPath, { recursive: true });
            exists = true;
            console.log('[Settings] Created test folder:', normalizedPath);
        }
        
        // Test write permission by creating a temp file
        const testFile = path.join(normalizedPath, '.write-test-' + Date.now());
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        writable = true;
        
        console.log('[Settings] ✅ Folder is writable:', normalizedPath);
        
        res.json({
            success: true,
            message: 'Folder is valid and writable',
            data: {
                path: normalizedPath,
                exists: exists,
                writable: writable,
                canUse: true
            }
        });
        
    } catch (error) {
        console.error('[Settings] ❌ Folder test failed:', error.message);
        res.json({
            success: false,
            message: 'Cannot use this folder',
            error: error.message,
            data: { canUse: false }
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
        
        // ⭐ NEW: Add download status to each video
        const videosWithStatus = channelData.videos.map(video => {
            const status = getVideoStatus(video.id || video.videoId, video.title);
            const fileInfo = status === 'downloaded' ? checkFileExists(video.title) : null;
            
            return {
                ...video,
                downloadStatus: status,  // 'new' | 'downloaded' | 'skipped'
                downloadedAt: fileInfo?.modified || null,
                fileSize: fileInfo?.sizeMB || null,
                filePath: fileInfo?.path || null
            };
        });
        
        // Count statuses for summary
        const newCount = videosWithStatus.filter(v => v.downloadStatus === 'new').length;
        const downloadedCount = videosWithStatus.filter(v => v.downloadStatus === 'downloaded').length;
        
        console.log('[Channels] 📊 Video status breakdown:');
        console.log('   ✨ New (not downloaded):', newCount);
        console.log('   ✅ Already downloaded:', downloadedCount);
        
        // Create channel object
        const channel = {
            id: uuidv4(),
            youtubeId: channelIdFinal,
            url: channelUrl,
            name: name || channelIdFinal,
            videoCount: channelData.videos.length + channelData.liveVideos.length,
            videos: videosWithStatus,  // ← Use videos WITH STATUS
            liveVideos: channelData.liveVideos,
            addedAt: new Date().toISOString(),
            lastChecked: new Date().toISOString(),
            status: 'active',
            stats: {
                total: videosWithStatus.length,
                new: newCount,
                downloaded: downloadedCount
            }
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

// =============================================================================
// VIDEO FORMAT ANALYZER & SMART DOWNLOAD SYSTEM
// =============================================================================

/**
 * Analyze available formats for a YouTube video
 * Returns sorted list from lowest to highest quality
 */
/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  FORMAT ANALYZER - Smart Format Detection & Lowest Quality Selection      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * 
 * 🔧 FEATURES:
 *   ✅ Scans EACH video before download using yt-dlp --list-formats
 *   ✅ Parses available formats and selects LOWEST quality
 *   ✅ Shows selected format in UI for each download
 *   ✅ Falls back gracefully if format detection fails
 *   ✅ Displays format info: resolution, filesize, codec, extension
 */

/**
 * Analyze available formats for a YouTube video using TEXT PARSING (more reliable)
 * Returns the best (lowest quality) format ID with full details
 */
function analyzeVideoFormats(videoUrl) {
    return new Promise((resolve, reject) => {
        console.log('\n[Format Analyzer] Starting analysis for:', videoUrl);
        console.log('[Format Analyzer] Using text-based parsing (reliable method)');
        
        // Command to list all available formats in TEXT format (more reliable than JSON)
        // ⚠️ WINDOWS COMPATIBILITY: Don't use shell redirects like 2>/dev/null (Unix-only!)
        // Instead, use Node.js exec options to handle stderr properly
        const cmd = 'yt-dlp --list-formats "' + videoUrl + '"';
        
        console.log('[Format Analyzer] Command:', cmd);
        
        const startTime = Date.now();
        
        exec(cmd, { 
            maxBuffer: 50 * 1024 * 1024, 
            timeout: 30000,
            windowsHide: true  // Hide console window on Windows
        }, (error, stdout, stderr) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            
            if (error) {
                console.log('[Format Analyzer] ❌ Error in', elapsed, 's:', error.message);
                // Return default low format on error - DON'T fail the download!
                return resolve({
                    success: true,
                    formatId: 'worstvideo+worstaudio/worst',
                    formatString: '-f "worstvideo+worstaudio/worstvideo/worstaudio/worst/best"',
                    resolution: 'Auto (Low)',
                    fileSize: 'Unknown',
                    codec: 'auto',
                    ext: 'mp4',
                    note: 'Format detection failed, using safest fallback',
                    analysisTime: elapsed,
                    fallbackUsed: true
                });
            }
            
            try {
                // Parse the TEXT output (more reliable than JSON!)
                const lines = stdout.split('\n').filter(line => 
                    line.trim() && !line.startsWith('[info]') && !line.startsWith('[warning]')
                );
                
                // Find format lines (they contain format code, extension, resolution)
                const formatLines = lines.filter(line => 
                    /\d+\s+(audio|video|mp4|webm|m4a)/i.test(line) || 
                    line.includes('audio only') || 
                    line.includes('video only')
                );
                
                console.log('[Format Analyzer] Found', formatLines.length, 'format lines');
                
                if (formatLines.length === 0) {
                    console.log('[Format Analyzer] ⚠️ No formats parsed, using worst');
                    return resolve({
                        success: true,
                        formatId: 'worst',
                        formatString: '-f "worst"',
                        resolution: 'Auto',
                        fileSize: 'Unknown',
                        codec: 'auto',
                        ext: 'mp4',
                        note: 'No formats parsed, using worst',
                        analysisTime: elapsed,
                        fallbackUsed: true
                    });
                }
                
                // Parse formats to find the WORST (lowest quality) video+audio combo
                let worstVideoFormat = null;
                let worstAudioFormat = null;
                let worstCombinedFormat = null;
                let allParsedFormats = [];
                
                // Analyze each format line
                formatLines.forEach((line, index) => {
                    // Extract format ID (usually first number/code)
                    const parts = line.trim().split(/\s{2,}/);
                    if (parts.length < 2) return;
                    
                    const formatCode = parts[0].trim();
                    const extension = parts[1] ? parts[1].trim() : 'unknown';
                    const resolution = parts[2] ? parts[2].trim() : 'unknown';
                    
                    // Check if this is audio-only
                    const isAudioOnly = line.toLowerCase().includes('audio only') || 
                                       resolution === 'audio only';
                    
                    // Check if this is video-only or combined
                    const isVideoOnly = line.toLowerCase().includes('video only');
                    
                    // Parse resolution to number for comparison (lower = worse quality = what we want)
                    let height = Infinity;
                    if (resolution.match(/^(\d+)x(\d+)$/)) {
                        height = parseInt(resolution.split('x')[1]);
                    } else if (resolution.match(/^(\d+)p$/)) {
                        height = parseInt(resolution);
                    } else if (resolution.match(/^(\d+)x/)) {
                        height = parseInt(resolution.split('x')[1]);
                    }
                    
                    const formatInfo = {
                        code: formatCode,
                        ext: extension,
                        resolution: resolution,
                        height: height,
                        isAudioOnly: isAudioOnly,
                        isVideoOnly: isVideoOnly,
                        fullLine: line,
                        lineNumber: index + 1
                    };
                    
                    allParsedFormats.push(formatInfo);
                    
                    // Track worst (lowest quality) of each type
                    if (isAudioOnly && (!worstAudioFormat || height < worstAudioFormat.height)) {
                        worstAudioFormat = formatInfo;
                    } else if (!isAudioOnly) {
                        // Video or combined format
                        if (!worstVideoFormat || height < worstVideoFormat.height) {
                            worstVideoFormat = formatInfo;
                            // If not video-only, it might be combined
                            if (!isVideoOnly) {
                                worstCombinedFormat = formatInfo;
                            }
                        }
                    }
                });
                
                // Determine best format string to use
                let selectedFormat;
                let formatDescription;
                
                // Priority order for selection:
                // 1. Combined format (video+audio together) - BEST OPTION
                // 2. Need to merge video + audio separately
                // 3. Video only (no audio merged)
                // 4. Ultimate fallback to generic worst
                
                if (worstCombinedFormat && !worstCombinedFormat.isVideoOnly) {
                    // We found a combined format (video+audio together) - BEST OPTION!
                    selectedFormat = {
                        success: true,
                        formatId: worstCombinedFormat.code,
                        formatString: '-f "' + worstCombinedFormat.code + '"',
                        resolution: worstCombinedFormat.resolution,
                        fileSize: '~' + estimateFileSize(worstCombinedFormat.height),
                        codec: worstCombinedFormat.ext,
                        ext: worstCombinedFormat.ext,
                        note: 'Combined format (video+audio)',
                        rawInfo: worstCombinedFormat.fullLine,
                        analysisTime: elapsed,
                        fallbackUsed: false,
                        allFormats: allParsedFormats
                    };
                    formatDescription = '✅ Combined format found';
                } else if (worstVideoFormat && worstAudioFormat) {
                    // Need to merge video + audio
                    selectedFormat = {
                        success: true,
                        formatId: worstVideoFormat.code + '+' + worstAudioFormat.code,
                        formatString: '-f "' + worstVideoFormat.code + '+' + worstAudioFormat.code + '"',
                        resolution: worstVideoFormat.resolution,
                        fileSize: '~' + estimateFileSize(worstVideoFormat.height),
                        codec: worstVideoFormat.ext + '+' + worstAudioFormat.ext,
                        ext: 'mp4', // Merged output will be MP4
                        note: 'Merged: video(' + worstVideoFormat.resolution + ') + audio',
                        rawVideoInfo: worstVideoFormat.fullLine,
                        rawAudioInfo: worstAudioFormat.fullLine,
                        analysisTime: elapsed,
                        fallbackUsed: false,
                        allFormats: allParsedFormats
                    };
                    formatDescription = '🔀 Video + Audio merge needed';
                } else if (worstVideoFormat) {
                    // Only video format available
                    selectedFormat = {
                        success: true,
                        formatId: worstVideoFormat.code,
                        formatString: '-f "' + worstVideoFormat.code + '"',
                        resolution: worstVideoFormat.resolution,
                        fileSize: '~' + estimateFileSize(worstVideoFormat.height),
                        codec: worstVideoFormat.ext,
                        ext: worstVideoFormat.ext,
                        note: 'Video only (no audio merged)',
                        rawInfo: worstVideoFormat.fullLine,
                        analysisTime: elapsed,
                        fallbackUsed: false,
                        allFormats: allParsedFormats
                    };
                    formatDescription = '🎥 Video only format';
                } else {
                    // Fallback to generic worst
                    selectedFormat = {
                        success: true,
                        formatId: 'worst',
                        formatString: '-f "worstvideo+worstaudio/worstvideo/worstaudio/worst/best"',
                        resolution: 'Auto (Lowest)',
                        fileSize: 'Unknown',
                        codec: 'auto',
                        ext: 'mp4',
                        note: 'Using fallback: worst quality with multiple fallbacks',
                        analysisTime: elapsed,
                        fallbackUsed: true,
                        allFormats: allParsedFormats
                    };
                    formatDescription = '⚠️ Using safe fallback';
                }
                
                console.log('\n[Format Analyzer] ✅ Analysis complete in', elapsed, 's:');
                console.log('   📊 Total formats scanned:', formatLines.length);
                console.log('   🎯 Selection:', formatDescription);
                console.log('');
                console.log('   📋 Selected Format Details:');
                console.log('      Format ID:', selectedFormat.formatId);
                console.log('      Resolution:', selectedFormat.resolution);
                console.log('      File Size:', selectedFormat.fileSize);
                console.log('      Codec:', selectedFormat.codec);
                console.log('      Extension:', selectedFormat.ext);
                console.log('      Note:', selectedFormat.note);
                
                if (allParsedFormats.length > 0) {
                    console.log('');
                    console.log('   📋 All Available Formats (sorted by quality):');
                    const sortedByQuality = [...allParsedFormats].sort((a, b) => a.height - b.height);
                    sortedByQuality.slice(0, 8).forEach((f, i) => {
                        const type = f.isAudioOnly ? '🔊' : (f.isVideoOnly ? '🎥' : '🎬');
                        console.log(`      ${i + 1}. ${type} ${f.code.padEnd(8)} | ${f.resolution.padEnd(12)} | ${f.ext.padEnd(5)} | ~${estimateFileSize(f.height)}`);
                    });
                    if (sortedByQuality.length > 8) {
                        console.log(`      ... and ${sortedByQuality.length - 8} more formats`);
                    }
                }
                
                resolve(selectedFormat);
                
            } catch (parseError) {
                console.error('[Format Analyzer] ❌ Parse error:', parseError.message);
                // Return safe fallback on parse error
                resolve({
                    success: true,
                    formatId: 'worst',
                    formatString: '-f "worst"',
                    resolution: 'Parse Error',
                    fileSize: 'Unknown',
                    codec: 'auto',
                    ext: 'mp4',
                    note: 'Parse error, using worst',
                    analysisTime: elapsed,
                    fallbackUsed: true
                });
            }
        });
    });
}

/**
 * Estimate file size based on resolution (very rough estimate)
 */
function estimateFileSize(height) {
    if (height <= 240) return '3-8 MB';
    if (height <= 360) return '5-15 MB';
    if (height <= 480) return '10-25 MB';
    if (height <= 720) return '20-50 MB';
    if (height <= 1080) return '40-100 MB';
    return '100+ MB';
}

// ============================================
// API ENDPOINT: Get video formats manually
// ============================================
app.get('/api/video/:videoId/formats', (req, res) => {
    const videoId = req.params.videoId;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    console.log('\n[API] 📊 Manual format request for video:', videoId);
    
    analyzeVideoFormats(videoUrl)
        .then(formatInfo => {
            res.json({
                success: true,
                videoId: videoId,
                formatInfo: formatInfo,
                message: `Format analysis complete. Recommended: ${formatInfo.formatId || 'worst'}`
            });
        })
        .catch(error => {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to analyze formats: ' + error.message 
            });
        });
});

/**
 * Smart download with automatic format selection (LOWEST QUALITY)
 * Now with real-time progress tracking using spawn()
 */
function smartDownload(downloadId, videoUrl, outputPath, downloadObj, onProgress, onComplete, onError) {
    return new Promise(async (resolve, reject) => {
        console.log('\n[Smart Download] Starting smart download for:', videoUrl);
        console.log('[Smart Download] Step 1: Analyzing formats...');
        
        try {
            // Step 1: Analyze formats using NEW text-parsing analyzer
            const analysis = await analyzeVideoFormats(videoUrl);
            
            // New analyzer always returns a result (never fails!)
            // It includes fallback formats if detection fails
            const selectedFormatId = analysis.formatId || 'worst';
            const formatString = analysis.formatString || `-f "${selectedFormatId}"`;
            
            console.log('[Smart Download] Step 2: Format analysis complete!');
            console.log('   📺 Format ID:', selectedFormatId);
            console.log('   📐 Resolution:', analysis.resolution);
            console.log('   💾 Est. Size:', analysis.fileSize);
            console.log('   🎵 Codec:', analysis.codec);
            console.log('   📝 Note:', analysis.note);
            if (analysis.fallbackUsed) {
                console.log('   ⚠️ Used fallback format');
            }
            
            // Store format info in download object for UI display
            if (downloadObj) {
                downloadObj.formatInfo = {
                    resolution: analysis.resolution,
                    formatId: selectedFormatId,
                    fileSize: analysis.fileSize,
                    codec: analysis.codec,
                    ext: analysis.ext,
                    note: analysis.note,
                    fallbackUsed: analysis.fallbackUsed,
                    status: 'analyzed'
                };
                downloadObj.selectedResolution = analysis.resolution;
                downloadObj.estimatedSize = analysis.fileSize;
            }
            
            // ⭐ CRITICAL FIX: Update status to DOWNLOADING before starting download
            console.log('[Smart Download] Step 3: Starting download...');
            if (downloadObj) {
                downloadObj.status = 'downloading';
                downloadObj.progress = 0;
                if (downloadObj.formatInfo) {
                    downloadObj.formatInfo.status = 'downloading';
                }
                console.log('[Smart Download] ✅ Status updated to: downloading');
            }
            
            // Step 3: Download with selected format using REAL-TIME progress
            const outputTemplate = outputPath.replace(/\.[^.]+$/, '') + '.%(ext)s';
            
            // Build command with analyzed format - use formatString if available, otherwise construct it
            let baseCmd;
            const needsMerge = selectedFormatId.includes('+');  // Format like "602+233" needs merging
            
            if (analysis.formatString && !analysis.fallbackUsed) {
                // Use the exact format string from analysis (most reliable)
                if (needsMerge && !FFMPEG_AVAILABLE) {
                    // ⚠️ Format requires merging but no ffmpeg - use combined format instead
                    console.log('[Smart Download] ⚠️ Format needs merging but FFmpeg unavailable!');
                    console.log('[Smart Download] Using "best" format instead (combined video+audio)');
                    baseCmd = `yt-dlp -f "best[height<=480]/best" --no-check-certificate --newline --ignore-no-formats-error --retries 5 --fragment-retries 10 --force-ipv4 -o "${outputTemplate}"`;
                } else {
                    baseCmd = `yt-dlp ${formatString} --merge-output-format mp4 --no-check-certificate --newline --ignore-no-formats-error --retries 5 --fragment-retries 10 --force-ipv4 -o "${outputTemplate}"`;
                }
            } else {
                // Use fallback or constructed format
                if ((selectedFormatId.includes('+') || selectedFormatId === 'worst') && !FFMPEG_AVAILABLE) {
                    console.log('[Smart Download] ⚠️ Merge needed but no FFmpeg - using safe format');
                    baseCmd = `yt-dlp -f "worst[height<=360]/worst" --no-check-certificate --newline --ignore-no-formats-error --retries 5 --fragment-retries 10 --force-ipv4 -o "${outputTemplate}"`;
                } else {
                    baseCmd = `yt-dlp --format "${selectedFormatId}" --merge-output-format mp4 --no-check-certificate --newline --ignore-no-formats-error --retries 5 --fragment-retries 10 --force-ipv4 -o "${outputTemplate}"`;
                }
            }
            
            // Add reliability flags for better downloads
            if (!baseCmd.includes('--format-sort')) {
                // Add format sort as additional safety net (prefers smallest files)
                baseCmd = baseCmd.replace('yt-dlp ', 'yt-dlp --format-sort "size:asc,res:240,vcodec:h264" ');
            }
            
            console.log('[Smart Download] Command template:', baseCmd.substring(0, 100) + '...');
            
            const strategies = buildCommandsWithCookieStrategies(baseCmd, videoUrl);
            
            // Use executeWithProgress for REAL-TIME progress tracking
            executeWithProgress(strategies, 0, downloadObj, onProgress,
                // Success callback
                (stdout, stderr) => {
                    console.log('[Smart Download] ✅ Download complete!');
                    if (downloadObj) {
                        downloadObj.progress = 100;
                        if (downloadObj.formatInfo) {
                            downloadObj.formatInfo.status = 'completed';
                        }
                    }
                    onComplete(stdout);
                    resolve(stdout);
                },
                // Error callback (all strategies failed)
                (error) => {
                    console.log('[Smart Download] ❌ Failed:', error.message);
                    if (downloadObj && downloadObj.formatInfo) {
                        downloadObj.formatInfo.status = 'error';
                        downloadObj.formatInfo.error = error.message;
                    }
                    onError(error.message);
                    reject(error);
                }
            );
            
        } catch (error) {
            console.log('[Smart Download] ❌ Analysis failed:', error.message);
            if (downloadObj && downloadObj.formatInfo) {
                downloadObj.formatInfo.status = 'error';
                downloadObj.formatInfo.error = error.message;
            }
            onError(error.message);
            reject(error);
        }
    });
}

// =============================================================================
// DOWNLOAD QUEUE MANAGEMENT
// =============================================================================

// Note: Sequential download queue system is defined below (search for "SEQUENTIAL DOWNLOAD QUEUE")
// This section contains the queue API endpoints and download manager

// GET /api/download-queue - List all downloads + sequential queue status
// ⚠️ COMPLETELY SILENT: No logging (frontend polls every 2s!)
app.get('/api/download-queue', (req, res) => {
    const allDownloads = downloadManager.getAll();
    const activeDownloads = allDownloads.filter(d => d.status === 'downloading' || d.status === 'analyzing' || d.status === 'queued');
    const completedDownloads = allDownloads.filter(d => d.status === 'completed');
    const failedDownloads = allDownloads.filter(d => d.status === 'error' || d.status === 'cancelled');
    const skippedDownloads = allDownloads.filter(d => d.status === 'skipped');
    
    // Get sequential queue status (no logging!)
    const seqStatus = downloadQueue.getStatus();
    const seqStats = seqStatus.stats;
    
    res.json({
        success: true,
        mode: 'sequential',  // Tell frontend we're in sequential mode!
        queue: {
            active: activeDownloads,
            currentJob: seqStatus.currentJob,  // Which video is downloading NOW
            waiting: seqStatus.queueLength,    // How many videos are waiting
            completed: completedDownloads.slice(-20), // Last 20 completed
            failed: failedDownloads.slice(-10),       // Last 10 failed
            skipped: skippedDownloads.slice(-20)
        },
        sequential: {
            isProcessing: seqStatus.isProcessing,
            currentVideo: seqStatus.currentJob ? {
                title: seqStatus.currentJob.title,
                progress: seqStatus.currentJob.progress,
                batchIndex: seqStatus.currentJob.batchIndex,
                status: seqStatus.currentJob.status
            } : null,
            remainingInQueue: seqStatus.queueLength,
            overallProgress: {
                completed: seqStats.completed,
                failed: seqStats.failed,
                skipped: seqStats.skipped,
                totalProcessed: seqStats.completed + seqStats.failed + seqStats.skipped,
                totalQueued: seqStats.totalQueued,
                percentage: seqStats.totalQueued > 0 
                    ? Math.round(((seqStats.completed + seqStats.failed + seqStats.skipped) / seqStats.totalQueued) * 100) 
                    : 0
            }
        },
        stats: {
            total: allDownloads.length,
            active: activeDownloads.length,
            completed: completedDownloads.length,
            failed: failedDownloads.length,
            skipped: skippedDownloads.length
        }
    });
});

// DELETE /api/download-queue - Clear completed/failed downloads from display
app.delete('/api/download-queue', (req, res) => {
    console.log('\n[Queue] DELETE /api/download-queue - Clearing queue');
    
    const allDownloads = downloadManager.getAll();
    let cleared = 0;
    
    allDownloads.forEach(download => {
        if (download.status === 'completed' || download.status === 'error' || download.status === 'cancelled') {
            downloadManager.remove(download.id);
            cleared++;
        }
    });
    
    console.log('[Queue] ✅ Cleared', cleared, 'downloads');
    
    res.json({
        success: true,
        message: `Cleared ${cleared} downloads`,
        cleared: cleared
    });
});

// =============================================================================
// SEQUENTIAL DOWNLOAD QUEUE SYSTEM
// =============================================================================

/**
 * Global sequential download queue
 * Ensures ONLY ONE video downloads at a time, even in batch mode
 */
const downloadQueue = {
    isProcessing: false,
    queue: [],
    currentJob: null,
    stats: {
        totalQueued: 0,
        completed: 0,
        failed: 0,
        skipped: 0
    },
    
    /**
     * Add a download job to the queue
     * @param {Object} job - Download job configuration
     */
    add(job) {
        this.queue.push(job);
        this.stats.totalQueued++;
        console.log(`\n[Queue] 📥 Job added to queue: ${job.title?.substring(0, 30)} | Position: #${this.queue.length}`);
        
        // Auto-start processing if not already running
        if (!this.isProcessing) {
            this.processNext();
        }
        
        return job;
    },
    
    /**
     * Process next job in queue (SEQUENTIAL - waits for completion)
     */
    async processNext() {
        // Skip if already processing or queue is empty
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }
        
        this.isProcessing = true;
        const job = this.queue.shift();
        this.currentJob = job;
        
        console.log('\n' + '='.repeat(80));
        console.log(`🎬 [Sequential Queue] Starting job #${job.batchIndex + 1}/${job.totalInBatch}`);
        console.log(`   Title: ${job.title}`);
        console.log(`   Queue remaining: ${this.queue.length} jobs`);
        console.log('='.repeat(80));
        
        try {
            // Update status to analyzing
            job.download.status = 'analyzing';
            job.download.startTime = Date.now();
            
            // Execute smart download (this AWaits completion!)
            await smartDownload(
                job.downloadId,
                job.videoUrl,
                job.outputPath,
                job.download,
                (progress) => {
                    // Real-time progress updates
                    job.download.progress = progress.percent;
                    job.download.speed = progress.speed;
                    
                    // Clean logging - only on percentage changes
                    const lastPercent = job.download._lastLoggedPercent || -1;
                    if (progress.percent !== lastPercent && 
                        (progress.percent % 10 === 0 || progress.percent === 100)) {
                        job.download._lastLoggedPercent = progress.percent;
                        const shortName = (job.download.filename || 'video').substring(0, 25);
                        console.log(`   ⬇️  [#${job.batchIndex + 1}] ${shortName} | ${progress.percent}%`);
                    }
                },
                (result) => {
                    // Success callback
                    job.download.status = 'completed';
                    job.download.progress = 100;
                    job.download.endTime = Date.now();
                    this.stats.completed++;
                    
                    const shortName = (job.download.filename || 'video').substring(0, 25);
                    console.log(`   ✅  [#${job.batchIndex + 1}] COMPLETE: ${shortName}`);
                    console.log(`   📊 Queue Progress: ${this.stats.completed}/${job.totalInBatch} done`);
                },
                (errorMsg) => {
                    // Error callback
                    job.download.status = 'error';
                    job.download.error = errorMsg;
                    job.download.endTime = Date.now();
                    this.stats.failed++;
                    
                    const shortName = (job.download.filename || 'video').substring(0, 25);
                    console.log(`   ❌  [#${job.batchIndex + 1}] FAILED: ${shortName}`);
                    console.log(`   Error: ${errorMsg?.substring(0, 100)}`);
                }
            );
            
        } catch (err) {
            // Unexpected error during download
            job.download.status = 'error';
            job.download.error = err.message;
            job.download.endTime = Date.now();
            this.stats.failed++;
            console.error(`   ❌ Unexpected error:`, err.message);
        }
        
        // Mark current job as done
        this.currentJob = null;
        this.isProcessing = false;
        
        // Small delay before next job (prevents rapid firing)
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Process next job in queue
        if (this.queue.length > 0) {
            this.processNext();
        } else {
            console.log('\n' + '='.repeat(80));
            console.log('✅ [Sequential Queue] ALL JOBS COMPLETED');
            console.log(`   Total: ${job.totalInBatch} | ✅ Completed: ${this.stats.completed} | ❌ Failed: ${this.stats.failed}`);
            console.log('='.repeat(80) + '\n');
        }
    },
    
    /**
     * Get current queue status
     */
    getStatus() {
        return {
            isProcessing: this.isProcessing,
            currentJob: this.currentJob ? {
                title: this.currentJob.title,
                batchIndex: this.currentJob.batchIndex,
                progress: this.currentJob.download?.progress || 0,
                status: this.currentJob.download?.status
            } : null,
            queueLength: this.queue.length,
            stats: { ...this.stats }
        };
    },
    
    /**
     * Clear the queue (stop processing)
     */
    clear() {
        this.queue = [];
        this.isProcessing = false;
        this.currentJob = null;
        console.log('[Queue] 🗑️ Queue cleared');
    }
};

// POST /api/download/batch - Batch download multiple videos SEQUENTIALLY (one at a time!)
app.post('/api/download/batch', async (req, res) => {
    console.log('\n' + '='.repeat(80));
    console.log('📦 [Sequential Batch] POST /api/download/batch');
    console.log('⚡ Mode: ONE VIDEO AT A TIME (Sequential Processing)');
    console.log('='.repeat(80));
    
    try {
        const { videos, channelId, format, quality } = req.body;
        
        if (!videos || !Array.isArray(videos) || videos.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Videos array required'
            });
        }

        console.log(`\n[Sequential Batch] 📋 Preparing ${videos.length} videos for SEQUENTIAL download`);
        console.log('[Sequential Batch] Channel ID:', channelId || 'N/A');
        console.log('[Sequential Batch] Quality preference:', quality || 'auto (lowest)');
        console.log('[Sequential Batch] ⏳ Videos will download ONE BY ONE (not parallel)');
        
        const jobIds = [];
        const errors = [];
        
        // Reset queue stats for new batch
        if (downloadQueue.queue.length === 0 && !downloadQueue.isProcessing) {
            downloadQueue.stats = { totalQueued: 0, completed: 0, failed: 0, skipped: 0 };
        }
        
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            const videoUrl = video.url || (video.id ? `https://www.youtube.com/watch?v=${video.id}` : null);
            
            if (!videoUrl) {
                errors.push({ index: i, video: video, error: 'No URL provided' });
                continue;
            }
            
            const downloadId = uuidv4();
            const safeTitle = (video.title || `video_${i}`).replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 50);
            const outputFilename = `${safeTitle}.mp4`;
            const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
            
            // Check if file already exists (skip if so)
            const existingFile = checkFileExists(outputFilename);
            if (existingFile.exists) {
                console.log(`[Sequential Batch] ⏭️ Skipping [${i+1}/${videos.length}] ${safeTitle.substring(0, 30)} (already exists)`);
                downloadQueue.stats.skipped++;
                
                // Still add to download manager as skipped
                const skippedDownload = downloadManager.add({
                    id: downloadId,
                    url: videoUrl,
                    videoId: video.id,
                    title: video.title,
                    channelId: channelId,
                    filename: outputFilename,
                    outputPath: outputPath,
                    status: 'skipped',
                    progress: 100,
                    reason: 'already_exists',
                    sizeMB: existingFile.sizeMB,
                    batchIndex: i,
                    totalInBatch: videos.length,
                    createdAt: new Date().toISOString()
                });
                
                jobIds.push(downloadId);
                continue;
            }
            
            const download = downloadManager.add({
                id: downloadId,
                url: videoUrl,
                videoId: video.id,
                title: video.title,
                channelId: channelId,
                filename: outputFilename,
                outputPath: outputPath,
                status: 'queued',  // Will be updated by queue processor
                progress: 0,
                batchIndex: i,
                totalInBatch: videos.length,
                createdAt: new Date().toISOString()
            });
            
            jobIds.push(downloadId);
            
            // ⭐ ADD TO SEQUENTIAL QUEUE (not immediate execution!)
            downloadQueue.add({
                downloadId: downloadId,
                videoUrl: videoUrl,
                outputPath: outputPath,
                download: download,
                video: video,
                batchIndex: i,
                totalInBatch: videos.length,
                title: video.title || `Video ${i + 1}`
            });
        }
        
        const queueStatus = downloadQueue.getStatus();
        
        console.log('\n[Sequential Batch] ✅ All jobs added to sequential queue');
        console.log(`   📊 Total jobs: ${jobIds.length}`);
        console.log(`   ✅ To download: ${jobIds.length - errors.length - downloadQueue.stats.skipped}`);
        console.log(`   ⏭️ Skipped (exist): ${downloadQueue.stats.skipped}`);
        console.log(`   ❌ Errors: ${errors.length}`);
        console.log(`   🔄 Currently processing: ${queueStatus.isProcessing ? 'YES' : 'NO'}`);
        console.log(`   📋 Waiting in queue: ${queueStatus.queueLength}`);
        console.log('='.repeat(80));
        console.log('\n⚠️ NOTE: Videos will download SEQUENTIALLY (one at a time)');
        console.log('   Watch console for: [#1], [#2], [#3]... as each completes\n');
        
        res.status(202).json({
            success: true,
            message: `${jobIds.length} jobs queued for SEQUENTIAL download (one at a time)`,
            mode: 'sequential',
            jobsCreated: jobIds.length,
            totalRequested: videos.length,
            errors: errors,
            jobIds: jobIds,
            queueStatus: queueStatus,
            estimatedTime: `${Math.ceil((jobIds.length - errors.length - downloadQueue.stats.skipped) * 20 / 60)} min`,
            note: 'Downloads will process one after another automatically'
        });

    } catch (error) {
        console.log('\n❌ [Batch Download] ERROR:', error.message);
        res.status(500).json({
            success: false,
            error: 'Batch download failed: ' + error.message
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
    // Get actual files in downloads directory
    let downloadedFiles = [];
    let downloadsDirExists = false;
    try {
        if (fs.existsSync(DOWNLOADS_DIR)) {
            downloadsDirExists = true;
            downloadedFiles = fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => !f.startsWith('.') && f.match(/\.(mp4|webm|mkv|avi|mov|flv|mp3|m4a)$/i))
                .map(filename => {
                    const filePath = path.join(DOWNLOADS_DIR, filename);
                    const stats = fs.statSync(filePath);
                    return {
                        filename: filename,
                        size: stats.size,
                        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                        modified: stats.mtime.toISOString(),
                        downloadUrl: `/api/download-file/by-name/${encodeURIComponent(filename)}?download=true`
                    };
                })
                .sort((a, b) => new Date(b.modified) - new Date(a.modified));
        }
    } catch (e) {
        console.error('[System Status] Error reading downloads dir:', e.message);
    }
    
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
                version: '2026.08.19',
                status: 'ok'
            },
            ffmpeg: {
                available: FFMPEG_AVAILABLE,
                status: FFMPEG_AVAILABLE ? 'installed' : 'not_found'
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
                total: downloadManager.getAll().length,
                directory: {
                    path: path.resolve(DOWNLOADS_DIR),
                    exists: downloadsDirExists,
                    fileCount: downloadedFiles.length,
                    totalSizeMB: downloadedFiles.reduce((sum, f) => sum + parseFloat(f.sizeMB), 0).toFixed(2),
                    files: downloadedFiles.slice(0, 10) // Last 10 files
                }
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
    console.log('   POST /api/download/batch');     // ← Batch with format analysis!
    console.log('   GET  /api/download/list');
    console.log('   GET  /api/download-queue');      // ← Queue status (frontend polls!)
    console.log('   DELETE /api/download-queue');    // ← Clear queue
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
            '/api/download',              // ← MAIN DOWNLOAD!
            '/api/download/start',
            '/api/download/batch',         // ← BATCH DOWNLOAD!
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
    console.log('║                   🚀 SERVER STARTED! 🚀                      ║');
    console.log('║                                                              ║');
    console.log(`║  🌐 Server:     http://localhost:${PORT}                            ║`);
    console.log(`║  📁 Downloads:  ${DOWNLOADS_DIR}        ║`);
    console.log(`║  🎬 FFmpeg:     ${FFMPEG_AVAILABLE ? '✅ Installed (merging enabled)' : '⚠️ Not found (using fallback)'}        ║`);
    console.log(`║  🍪 Cookies:    ${isCookiesFileValid() ? '✅ Valid' : '⚠️ Using browser'}                              ║`);
    console.log('║                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  Available API Endpoints:                                   ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  GET    /api/settings          View/change download folder     ║');
    console.log('║  PUT    /api/settings          Update settings                 ║');
    console.log('║  POST   /api/channels          Load channel videos             ║');
    console.log('║  POST   /api/download           Download single video           ║');
    console.log('║  POST   /api/download/batch     Batch download (sequential)     ║');
    console.log('║  GET    /api/files              List all downloaded files        ║');
    console.log('║  GET    /api/download-file/:id  Download file by ID            ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`💡 Default download folder is your Downloads/YouTube-Downloader`);
    console.log(`   Change it in frontend Settings panel or via /api/settings`);
    console.log('');
    console.log('Press Ctrl+C to stop the server');
});

module.exports = app;
