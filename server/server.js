
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
        } else {
            console.log('[executeWithRetry] ✅ Strategy', currentIndex + 1, 'succeeded in', elapsed, 's:', strategy.description);
            onSuccess(stdout);
        }
    });
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(process.cwd(), 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    console.log('[Init] Created downloads directory:', DOWNLOADS_DIR);
}

const AUTH_CONFIG = {
    cookieFilePath: process.env.COOKIE_FILE_PATH || path.join(process.cwd(), 'cookies.txt'),
    browserName: process.env.BROWSER_NAME || 'edge' // chrome, firefox, edge, safari
};

// FFmpeg availability check
let FFMPEG_AVAILABLE = false;
try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    FFMPEG_AVAILABLE = true;
    console.log('[Init] ✅ FFmpeg is available');
} catch (e) {
    console.log('[Init] ⚠️ FFmpeg not found - using fallback download method');
}

// =============================================================================
// IN-MEMORY STORAGE
// =============================================================================

const savedChannels = new Map();
const downloadManager = {
    downloads: new Map(),
    
    add(download) {
        this.downloads.set(download.id, download);
        return download;
    },
    
    get(id) {
        return this.downloads.get(id);
    },
    
    update(id, updates) {
        const download = this.downloads.get(id);
        if (download) {
            Object.assign(download, updates);
        }
        return download;
    },
    
    remove(id) {
        return this.downloads.delete(id);
    },
    
    getAll() {
        return Array.from(this.downloads.values());
    },
    
    getActive() {
        return this.getAll().filter(d => d.status === 'downloading' || d.status === 'queued');
    },
    
    getCompleted() {
        return this.getAll().filter(d => d.status === 'completed' || d.status === 'skipped');
    }
};

// =============================================================================
// ⭐ DOWNLOAD DETECTION & SYNC SYSTEM - Enhanced for renamed files
// =============================================================================

// In-memory set of downloaded video IDs (persisted across requests)
const downloadedVideos = new Set();  // Stores: videoId -> filename
const skippedVideos = new Set();    // Stores: videoId -> reason

// ⭐ NEW: Enhanced file index for fuzzy matching
// Structure: { normalizedTitle: { filename, path, size, modified, videoId } }
const downloadedFilesIndex = new Map();

/**
 * Normalize a string for fuzzy comparison
 * - Lowercase
 * - Remove special characters
 * - Remove extra spaces
 * - Common word variations
 */
function normalizeForMatch(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .replace(/[<>:"/\\|?*[\]]/g, '')  // Remove special chars
        .replace(/[_\-]/g, ' ')           // Replace underscores/hyphens with spaces
        .replace(/\s+/g, ' ')             // Collapse multiple spaces
        .trim()
        .substring(0, 200);               // Limit length
}

/**
 * Calculate similarity ratio between two strings (0-1)
 * Uses simple token-based matching
 */
function calculateSimilarity(str1, str2) {
    const norm1 = normalizeForMatch(str1);
    const norm2 = normalizeForMatch(str2);
    
    if (!norm1 || !norm2) return 0;
    
    // Exact match
    if (norm1 === norm2) return 1;
    
    // One contains the other
    if (norm1.includes(norm2) || norm2.includes(norm1)) return 0.9;
    
    // Token-based similarity
    const tokens1 = new Set(norm1.split(' ').filter(t => t.length > 2));
    const tokens2 = new Set(norm2.split(' ').filter(t => t.length > 2));
    
    if (tokens1.size === 0 || tokens2.size === 0) return 0;
    
    let commonTokens = 0;
    tokens1.forEach(token => {
        if (tokens2.has(token)) commonTokens++;
    });
    
    const similarity = (commonTokens * 2) / (tokens1.size + tokens2.size);
    return similarity;
}

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
 * ⭐ NEW: Find downloaded file by video title (fuzzy matching)
 * Searches the downloadedFilesIndex for matching files
 * @param {string} title - Video title from YouTube
 * @param {number} threshold - Minimum similarity threshold (default 0.6)
 * @returns {object|null} - File info object or null if not found
 */
function findFileByTitle(title, threshold = 0.6) {
    if (!title) return null;
    
    const normalizedTitle = normalizeForMatch(title);
    let bestMatch = null;
    let bestSimilarity = 0;
    
    // Search through indexed files
    for (const [normalizedKey, fileInfo] of downloadedFilesIndex) {
        const similarity = calculateSimilarity(normalizedTitle, normalizedKey);
        
        if (similarity > bestSimilarity && similarity >= threshold) {
            bestSimilarity = similarity;
            bestMatch = {
                ...fileInfo,
                similarity: similarity,
                matchedBy: 'title'
            };
        }
    }
    
    if (bestMatch) {
        console.log(`[Title Match] Found "${title.substring(0, 40)}..." with ${(bestMatch.similarity * 100).toFixed(0)}% confidence`);
    }
    
    return bestMatch;
}

/**
 * ⭐ ENHANCED: Scan downloads directory and populate both tracking structures
 * Call this on server startup to track already-downloaded files
 * Now builds an INDEX for fuzzy title matching!
 */
function scanExistingDownloads() {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📁 [Download Sync] Scanning existing downloads in:');
    console.log('   ', DOWNLOADS_DIR);
    console.log('═══════════════════════════════════════════════════════════════');
    
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        let count = 0;
        let totalSize = 0;
        
        // Clear and rebuild index
        downloadedFilesIndex.clear();
        
        files.forEach(file => {
            if (file.endsWith('.mp4') || file.endsWith('.webm') || file.endsWith('.mkv') || 
                file.endsWith('.avi') || file.endsWith('.mov')) {
                
                const fullPath = path.join(DOWNLOADS_DIR, file);
                const stats = fs.statSync(fullPath);
                
                // Add to basic set (backward compatibility)
                downloadedVideos.add(file);
                
                // ⭐ NEW: Add to enhanced index with normalized title for fuzzy matching
                // Remove extension for normalization
                const nameWithoutExt = file.replace(/\.[^.]+$/, '');
                const normalizedName = normalizeForMatch(nameWithoutExt);
                
                downloadedFilesIndex.set(normalizedName, {
                    filename: file,
                    path: fullPath,
                    size: stats.size,
                    sizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100,
                    modified: stats.mtime,
                    originalName: nameWithoutExt
                });
                
                count++;
                totalSize += stats.size;
            }
        });
        
        const totalSizeMB = Math.round(totalSize / 1024 / 1024 * 100) / 100;
        
        console.log(`\n[Download Sync] ✅ Scan Complete!`);
        console.log(`   📊 Files Found: ${count}`);
        console.log(`   💾 Total Size: ${totalSizeMB} MB`);
        console.log(`   📋 Indexed for fuzzy matching: ${downloadedFilesIndex.size} files`);
        console.log('═══════════════════════════════════════════════════════════════\n');
        
    } catch (error) {
        console.log('[Download Sync] ⚠️ Error scanning downloads:', error.message);
    }
}

/**
 * ⭐ ENHANCED: Get status of a specific video with fuzzy title matching
 * @param {string} videoId - YouTube video ID
 * @param {string} title - Video title (used for fuzzy matching!)
 * @returns {object} - { status: string, fileInfo: object|null }
 */
function getVideoStatus(videoId, title) {
    // Check skipped first
    if (skippedVideos.has(videoId)) {
        return { status: 'skipped', fileInfo: null, reason: 'previously_skipped' };
    }
    
    // Check by video ID (exact match in downloadedVideos set)
    if (downloadedVideos.has(videoId)) {
        const fileInfo = checkFileExists(videoId);
        return { status: 'downloaded', fileInfo, matchedBy: 'videoId' };
    }
    
    // ⭐ NEW: Try fuzzy title matching (for renamed files!)
    if (title) {
        const matchedFile = findFileByTitle(title);
        if (matchedFile) {
            // Cache the match for future lookups
            downloadedVideos.add(videoId);
            downloadedVideos.add(matchedFile.filename);
            
            return { 
                status: 'downloaded', 
                fileInfo: matchedFile, 
                matchedBy: 'title',
                similarity: matchedFile.similarity
            };
        }
        
        // Legacy exact filename check (fallback)
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
        const possibleFiles = [
            safeTitle + '.mp4',
            safeTitle.substring(0, 100) + '.mp4'
        ];
        
        for (const file of possibleFiles) {
            if (downloadedVideos.has(file)) {
                const fileInfo = checkFileExists(file);
                return { status: 'downloaded', fileInfo, matchedBy: 'filename_exact' };
            }
            
            // Also check actual filesystem
            const fileInfo = checkFileExists(file);
            if (fileInfo.exists) {
                downloadedVideos.add(file); // Cache it
                return { status: 'downloaded', fileInfo, matchedBy: 'filesystem' };
            }
        }
    }
    
    return { status: 'new', fileInfo: null };
}

// Scan existing downloads on startup
scanExistingDownloads();

// =============================================================================
// EXPRESS APP INITIALIZATION - Must be BEFORE routes!
// =============================================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
            res.status(404).send(`
                <html>
                <body style="font-family: Arial, sans-serif; padding: 50px; text-align: center;">
                    <h1>⚠️ Frontend Not Found</h1>
                    <p>Could not locate <code>index.html</code></p>
                    <p>Searched in:</p>
                    <ul style="text-align: left; display: inline-block;">
                        ${searchPaths.map(p => `<li><code>${p}</code></li>`).join('')}
                    </ul>
                    <hr>
                    <p><strong>API Status:</strong> <a href="/api/health">Check Health</a></p>
                </body>
                </html>
            `);
        }
    }
});

// =============================================================================
// HEALTH CHECK ENDPOINT
// =============================================================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        downloads: {
            dir: DOWNLOADS_DIR,
            exists: fs.existsSync(DOWNLOADS_DIR),
            fileCount: downloadedVideos.size,
            indexedFiles: downloadedFilesIndex.size
        },
        ffmpeg: FFMPEG_AVAILABLE,
        cookies: isCookiesFileValid()
    });
});

// =============================================================================
// SETTINGS ENDPOINTS - Download folder management
// =============================================================================

app.get('/api/settings', (req, res) => {
    const resolvedPath = toNativePath(DOWNLOADS_DIR);
    let fileCount = 0;
    let recentFiles = [];
    
    try {
        if (fs.existsSync(resolvedPath)) {
            const files = fs.readdirSync(resolvedPath);
            fileCount = files.length;
            recentFiles = files
                .filter(f => f.endsWith('.mp4') || f.endsWith('.webm'))
                .slice(-5)
                .map(f => ({
                    name: f,
                    size: fs.statSync(path.join(resolvedPath, f)).size,
                    modified: fs.statSync(path.join(resolvedPath, f)).mtime
                }));
        }
    } catch (e) {
        console.error('[Settings] Error reading downloads dir:', e);
    }
    
    res.json({
        success: true,
        data: {
            currentDownloadsDir: DOWNLOADS_DIR,
            resolvedPath: resolvedPath,
            dirExists: fs.existsSync(resolvedPath),
            fileCount: fileCount,
            recentFiles: recentFiles,
            downloadedVideosCount: downloadedVideos.size,
            indexedFilesCount: downloadedFilesIndex.size
        }
    });
});

app.put('/api/settings', async (req, res) => {
    const { downloadsDir } = req.body;
    
    if (!downloadsDir) {
        return res.status(400).json({ success: false, error: 'downloadsDir required' });
    }
    
    const newPath = toNativePath(downloadsDir);
    
    try {
        if (!fs.existsSync(newPath)) {
            fs.mkdirSync(newPath, { recursive: true });
        }
        
        // Update global (in production, save to config file)
        process.env.DOWNLOADS_DIR = newPath;
        
        // Re-scan downloads with new path
        // Note: In real implementation, you'd update DOWNLOADS_DIR global
        
        res.json({
            success: true,
            message: `Download folder updated to: ${newPath}`,
            data: { newDir: newPath }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/settings/test-folder', (req, res) => {
    const { folderPath } = req.body;
    
    if (!folderPath) {
        return res.status(400).json({ success: false, error: 'folderPath required' });
    }
    
    const testPath = toNativePath(folderPath);
    
    try {
        // Try to create test file
        const testFile = path.join(testPath, '.write_test_' + Date.now());
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        
        res.json({
            success: true,
            data: {
                canUse: true,
                path: testPath,
                exists: fs.existsSync(testPath)
            }
        });
    } catch (error) {
        res.json({
            success: true,
            data: {
                canUse: false,
                path: testPath,
                error: error.message
            }
        });
    }
});

// =============================================================================
// ⭐ NEW: DOWNLOAD SYNC ENDPOINT - Get list of all downloaded files
// =============================================================================

/**
 * GET /api/downloaded-files
 * Returns comprehensive list of all files in download folder
 * Frontend uses this to sync video status!
 */
app.get('/api/downloaded-files', (req, res) => {
    console.log('\n[Download Sync] GET /api/downloaded-files - Frontend requesting file list');
    
    try {
        // Re-scan to get latest state
        scanExistingDownloads();
        
        // Build comprehensive response
        const files = Array.from(downloadedFilesIndex.values()).map(fileInfo => ({
            filename: fileInfo.filename,
            originalName: fileInfo.originalName,
            size: fileInfo.size,
            sizeMB: fileInfo.sizeMB,
            modified: fileInfo.modified,
            modifiedISO: fileInfo.modified.toISOString(),
            path: fileInfo.path
        }));
        
        // Sort by modification date (newest first)
        files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
        
        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            downloadsDir: DOWNLOADS_DIR,
            summary: {
                totalFiles: files.length,
                totalSizeMB: files.reduce((sum, f) => sum + f.sizeMB, 0).toFixed(2),
                indexedForMatching: downloadedFilesIndex.size
            },
            files: files
        };
        
        console.log(`[Download Sync] Returning ${files.length} files to frontend`);
        console.log(`[Download Sync] Summary: ${response.summary.totalFiles} files, ${response.summary.totalSizeMB} MB`);
        
        res.json(response);
        
    } catch (error) {
        console.error('[Download Sync] Error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get downloaded files: ' + error.message
        });
    }
});

/**
 * POST /api/downloaded-files/check
 * Check specific videos against downloaded files
 * Body: { videos: [{ id, title }] }
 * Returns: { results: [{ id, status, fileInfo }] }
 */
app.post('/api/downloaded-files/check', (req, res) => {
    console.log('\n[Download Sync] POST /api/downloaded-files/check - Batch status check');
    
    try {
        const { videos } = req.body;
        
        if (!videos || !Array.isArray(videos)) {
            return res.status(400).json({
                success: false,
                error: 'videos array required'
            });
        }
        
        console.log(`[Download Sync] Checking ${videos.length} videos against ${downloadedFilesIndex.size} indexed files`);
        
        const results = videos.map(video => {
            const statusResult = getVideoStatus(video.id || video.videoId, video.title);
            
            return {
                id: video.id || video.videoId,
                title: video.title,
                status: statusResult.status,
                fileInfo: statusResult.fileInfo ? {
                    filename: statusResult.fileInfo.filename,
                    sizeMB: statusResult.fileInfo.sizeMB,
                    modified: statusResult.fileInfo.modifiedISO || statusResult.fileInfo.modified?.toISOString()
                } : null,
                matchedBy: statusResult.matchedBy || null,
                similarity: statusResult.similarity || null
            };
        });
        
        // Count statuses
        const summary = {
            total: results.length,
            new: results.filter(r => r.status === 'new').length,
            downloaded: results.filter(r => r.status === 'downloaded').length,
            skipped: results.filter(r => r.status === 'skipped').length
        };
        
        console.log(`[Download Sync] Results: ${summary.downloaded} downloaded, ${summary.new} new, ${summary.skipped} skipped`);
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            summary: summary,
            results: results
        });
        
    } catch (error) {
        console.error('[Download Sync] Check error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check videos: ' + error.message
        });
    }
});

// =============================================================================
// CHANNEL ENDPOINTS
// =============================================================================

/**
 * Fetch channel information using yt-dlp with smart retry
 */
function fetchChannelInfo(channelId, channelUrl) {
    return new Promise((resolve, reject) => {
        console.log('\n[fetchChannelInfo] Starting channel fetch...');
        console.log('[fetchChannelInfo] Channel URL:', channelUrl);
        
        const cmd = `yt-dlp --flat-playlist --print "%(id)s\t%(title)s\t%(duration)s\t%(view_count)s\t%(upload_date)s" "${channelUrl}"`;
        
        console.log('[fetchChannelInfo] Command:', cmd.substring(0, 100) + '...');
        
        const strategies = buildCommandsWithCookieStrategies(cmd, channelUrl);
        
        executeWithRetry(
            strategies,
            0,
            (stdout) => {
                console.log('[fetchChannelInfo] ✅ Successfully fetched channel data');
                
                try {
                    const lines = stdout.trim().split('\n').filter(line => line.trim());
                    const videos = [];
                    const liveVideos = [];
                    
                    lines.forEach((line, index) => {
                        const parts = line.split('\t');
                        if (parts.length >= 2) {
                            const video = {
                                id: parts[0]?.trim() || `video_${index}`,
                                title: parts[1]?.trim() || 'Untitled',
                                duration: parts[2] ? parseInt(parts[2]) : null,
                                views: parts[3] ? parseInt(parts[3]) : null,
                                uploadDate: parts[4]?.trim() || null,
                            };
                            
                            // Filter out very short durations (likely shorts/ads)
                            if (video.duration === null || video.duration >= 60) {
                                videos.push(video);
                            }
                        }
                    });
                    
                    console.log(`[fetchChannelInfo] Parsed ${videos.length} videos`);
                    
                    resolve({
                        videos: videos,
                        liveVideos: liveVideos
                    });
                    
                } catch (parseError) {
                    console.error('[fetchChannelInfo] Error parsing output:', parseError);
                    reject(new Error('Failed to parse channel data'));
                }
            },
            (error) => {
                console.error('[fetchChannelInfo] Failed to fetch channel:', error.message);
                reject(error);
            }
        );
    });
}

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
        const { url, format, quality, title } = req.body;  // ⭐ Added title!
        
        if (!url) {
            return res.status(400).json({ error: 'Video URL required' });
        }

        const downloadId = uuidv4();
        const filename = `video_${downloadId}.mp4`;
        const outputPath = path.join(DOWNLOADS_DIR, filename);

        const download = downloadManager.add({
            id: downloadId,
            url: url,
            title: title || null,  // ⭐ ADD TITLE FOR RENAME!
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
            filename,       // Custom filename
            title           // ⭐ VIDEO TITLE (for rename feature!)
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
        
        // ⭐ ENHANCED: Also check by title (fuzzy match for renamed files!)
        const titleCheck = getVideoStatus(videoId, videoTitle);
        
        if (existingFile.exists || titleCheck.status === 'downloaded') {
            const fileInfo = titleCheck.status === 'downloaded' ? titleCheck.fileInfo : existingFile;
            
            console.log('\n[Download] ⚠️ FILE ALREADY EXISTS - SKIPPING DOWNLOAD');
            console.log('[Download] Matched by:', titleCheck.matchedBy || 'exact_filename');
            if (titleCheck.similarity) {
                console.log('[Download] Similarity:', (titleCheck.similarity * 100).toFixed(0) + '%');
            }
            console.log('[Download] Existing file:', fileInfo?.filename);
            console.log('[Download] File size:', fileInfo?.sizeMB, 'MB');
            console.log('[Download] Last modified:', fileInfo?.modified);
            
            // Mark as downloaded in tracking
            downloadedVideos.add(videoId);
            downloadedVideos.add(fileInfo?.filename);
            
            // Return immediate success with "skipped" status
            return res.status(200).json({
                success: true,
                jobId: downloadId,
                status: 'skipped',
                message: 'File already exists, skipped download',
                download: {
                    id: downloadId,
                    url: videoUrl,
                    filename: fileInfo?.filename,
                    status: 'skipped',
                    progress: 100,
                    size: fileInfo?.sizeMB,
                    sizeMB: fileInfo?.sizeMB,
                    path: fileInfo?.path,
                    reason: 'already_exists',
                    matchedBy: titleCheck.matchedBy || 'filename',
                    similarity: titleCheck.similarity || null,
                    skippedAt: new Date().toISOString()
                }
            });
        }

        const download = downloadManager.add({
            id: downloadId,
            url: videoUrl,
            videoId: videoId,
            channelId: channelId,
            title: title || null,  // ⭐ ADD TITLE FOR RENAME!
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
        setImmediate(() => {
            executeSmartDownload(downloadId, videoUrl, outputPath, title || videoTitle);
        });

        console.log('[Download] 📤 Response sent to frontend (job running in background)');
        console.log('='.repeat(80) + '\n');

        res.status(201).json({
            success: true,
            jobId: downloadId,
            status: 'queued',
            message: 'Download job created',
            download: {
                id: downloadId,
                url: videoUrl,
                filename: outputFilename,
                status: 'queued',
                progress: 0,
                createdAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('[Download] ❌ ERROR creating download job:', error.message);
        console.log('='.repeat(80) + '\n');
        
        res.status(500).json({
            success: false,
            error: 'Failed to create download: ' + error.message,
            suggestion: 'Check server logs for details'
        });
    }
});

// GET /api/channels - Return list of saved channels (FRONTEND COMPATIBLE FORMAT!)
app.get('/api/channels', (req, res) => {
    console.log('\n[Channels] GET /api/channels requested');
    
    const channels = Array.from(savedChannels.values()).map(ch => ({
        ...ch,
        // Recalculate current download status
        videos: (ch.videos || []).map(video => {
            const status = getVideoStatus(video.id, video.title);
            return {
                ...video,
                downloadStatus: status.status,
                ...(status.fileInfo ? { fileSize: status.fileInfo.sizeMB, filePath: status.fileInfo.path } : {})
            };
        })
    }));
    
    res.json({
        success: true,
        channels: channels,
        count: channels.length
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
        // ⭐ SMART URL CLEANUP - Fix doubled/malformed URLs
        let channelUrl = url || `https://www.youtube.com/@${channelId}`;
        
        // Fix common URL issues:
        // 1. Double youtube.com: https://www.youtube.com/www.youtube.com/@user
        // 2. Missing protocol: www.youtube.com/@user
        // 3. Extra slashes: https://www.youtube.com//@user
        
        if (channelUrl) {
            // Remove double youtube.com occurrences
            while (channelUrl.includes('youtube.com/youtube.com/') || 
                   channelUrl.includes('youtube.com/www.youtube.com/')) {
                channelUrl = channelUrl.replace(/youtube\.com\/(www\.)?youtube\.com\//, 'youtube.com/');
                console.log('[Channels] 🔧 Fixed doubled URL');
            }
            
            // Ensure protocol exists
            if (!channelUrl.startsWith('http://') && !channelUrl.startsWith('https://')) {
                channelUrl = 'https://' + channelUrl.replace(/^\/\//, '');
                console.log('[Channels] 🔧 Added missing protocol');
            }
            
            // Remove double slashes (but keep https://)
            channelUrl = channelUrl.replace(/([^:])\/{2,}/g, '$1/');
        }
        
        const channelIdFinal = channelId || channelUrl.split('@').pop().split('/')[0];
        
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
        
        // ⭐ NEW: Add download status to each video using ENHANCED fuzzy matching
        const videosWithStatus = channelData.videos.map(video => {
            const statusResult = getVideoStatus(video.id || video.videoId, video.title);
            
            return {
                ...video,
                downloadStatus: statusResult.status,  // 'new' | 'downloaded' | 'skipped'
                downloadedAt: statusResult.fileInfo?.modified || null,
                fileSize: statusResult.fileInfo?.sizeMB || null,
                filePath: statusResult.fileInfo?.path || null,
                matchedBy: statusResult.matchedBy || null,  // ⭐ NEW: How it was matched
                similarity: statusResult.similarity || null  // ⭐ NEW: Confidence score
            };
        });
        
        // Count statuses for summary
        const newCount = videosWithStatus.filter(v => v.downloadStatus === 'new').length;
        const downloadedCount = videosWithStatus.filter(v => v.downloadStatus === 'downloaded').length;
        
        console.log('\n[Channels] 📊 Video status breakdown (with fuzzy matching):');
        console.log('   ✨ New (not downloaded):', newCount);
        console.log('   ✅ Already downloaded:', downloadedCount);
        console.log('   📁 Indexed files available:', downloadedFilesIndex.size);
        
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
        console.log('[Channels] Returning channel to frontend...');
        
        res.status(201).json({
            success: true,
            message: 'Channel added successfully',
            channel: channel,  // ← Include channel object at top level
            channels: [channel],  // ← Also in array for loadChannelsFromServer()
            videos: channelData.videos,
            liveVideos: channelData.liveVideos,
            totalVideos: channelData.videos.length + channelData.liveVideos.length,
            // ⭐ NEW: Include sync info for frontend
            syncInfo: {
                totalVideos: videosWithStatus.length,
                newVideos: newCount,
                alreadyDownloaded: downloadedCount,
                indexedFiles: downloadedFilesIndex.size,
                matchingMethod: 'fuzzy_title'  // Tell frontend we used fuzzy matching
            }
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
// DOWNLOAD QUEUE ENDPOINTS
// =============================================================================

app.get('/api/download-queue', (req, res) => {
    const active = downloadManager.getActive().map(d => ({
        id: d.id,
        videoId: d.videoId,
        title: d.title,
        filename: d.filename,
        status: d.status,
        progress: d.progress || 0,
        speed: d.speed || null,
        downloaded: d.downloaded || null,
        total: d.total || null,
        startTime: d.startTime,
        url: d.url,
        format: d.format,
        quality: d.quality,
        finalFilename: d.finalFilename || null,
        renamedFrom: d.renamedFrom || null,
        error: d.error || null
    }));
    
    const completed = downloadManager.getCompleted().map(d => ({
        id: d.id,
        videoId: d.videoId,
        title: d.title,
        filename: d.filename,
        status: d.status,
        progress: 100,
        finalFilename: d.finalFilename || d.filename,
        renamedFrom: d.renamedFrom || null,
        completedAt: d.endTime,
        size: d.finalSize || null,
        error: d.error || null
    }));

    res.json({
        success: true,
        queue: {
            active: active,
            completed: completed
        },
        timestamp: new Date().toISOString()
    });
});

app.delete('/api/download-queue', (req, res) => {
    const completed = downloadManager.getCompleted();
    completed.forEach(d => downloadManager.remove(d.id));
    
    res.json({
        success: true,
        message: `Cleared ${completed.length} completed downloads`,
        remaining: downloadManager.getAll().length
    });
});

// =============================================================================
// DOWNLOAD EXECUTION FUNCTIONS
// =============================================================================

function executeSmartDownload(downloadId, videoUrl, outputPath, videoTitle) {
    const download = downloadManager.get(downloadId);
    if (!download) {
        console.error('[Smart Download] Download not found:', downloadId);
        return;
    }

    console.log(`\n[Smart Download] 🎯 Starting SMART download for: ${videoTitle}`);
    console.log(`[Smart Download] ID: ${downloadId}`);

    // Update status
    downloadManager.update(downloadId, { status: 'downloading', startTime: Date.now() });

    // Step 1: Analyze formats
    analyzeVideoFormats(videoUrl)
        .then(formatInfo => {
            console.log(`[Smart Download] 📊 Format analysis complete:`);
            console.log(`   Selected: ${formatInfo.formatId} (${formatInfo.resolution}, ${formatInfo.ext})`);
            console.log(`   Estimated size: ${formatInfo.filesizeMB || 'unknown'} MB`);

            // Store format info
            downloadManager.update(downloadId, {
                selectedFormat: formatInfo
            });

            // Step 2: Download with selected format
            return executeDownloadWithFormat(downloadId, videoUrl, outputPath, formatInfo, videoTitle);
        })
        .then(result => {
            console.log(`[Smart Download] ✅ Download complete!`);
            console.log(`[Smart Download] Output: ${outputPath}`);

            // Step 3: Rename file to video title (if enabled)
            return renameDownloadedFile(download, outputPath);
        })
        .then(renameResult => {
            console.log(`[Smart Download] 📝 Rename result:`, renameResult);

            // Mark as completed
            downloadManager.update(downloadId, {
                status: 'completed',
                progress: 100,
                endTime: Date.now(),
                ...(renameResult.success ? {
                    finalFilename: renameResult.filename,
                    renamedFrom: renameResult.originalFilename,
                    finalSize: renameResult.size
                } : {})
            });

            // Track as downloaded
            downloadedVideos.add(download.videoId || downloadId);
            if (renameResult.filename) {
                downloadedVideos.add(renameResult.filename);
                
                // Update the files index for future matching
                const normalizedName = normalizeForMatch(renameResult.filename.replace(/\.[^.]+$/, ''));
                downloadedFilesIndex.set(normalizedName, {
                    filename: renameResult.filename,
                    path: renameResult.path || outputPath,
                    size: renameResult.size || 0,
                    sizeMB: Math.round((renameResult.size || 0) / 1024 / 1024 * 100) / 100,
                    modified: new Date(),
                    originalName: renameResult.filename.replace(/\.[^.]+$/, '')
                });
            }
        })
        .catch(error => {
            console.error(`[Smart Download] ❌ Error:`, error.message);
            
            downloadManager.update(downloadId, {
                status: 'error',
                error: error.message,
                endTime: Date.now()
            });
        });
}

function executeDownloadWithFormat(downloadId, videoUrl, outputPath, formatInfo, videoTitle) {
    return new Promise((resolve, reject) => {
        const download = downloadManager.get(downloadId);
        if (!download) return reject(new Error('Download not found'));

        console.log(`\n[Execute Download] Starting: ${videoTitle}`);
        console.log(`[Execute Download] Format: ${formatInfo.formatId} (${formatInfo.resolution})`);

        // Build yt-dlp command with selected format
        let cmd = `yt-dlp -f "${formatInfo.formatId}" -o "${outputPath}" --no-playlist`;
        
        // Add merge requirement if format needs it
        if (formatInfo.needsMerge) {
            cmd += ' --merge-output-format mp4';
            if (FFMPEG_AVAILABLE) {
                console.log('[Execute Download] ✅ FFmpeg available for merging');
            } else {
                console.warn('[Execute Download] ⚠️ FFmpeg not available, merge may fail');
            }
        }

        cmd += ` "${videoUrl}"`;

        console.log(`[Execute Download] Command: ${cmd.substring(0, 150)}...`);

        const ytDlpProcess = spawn('yt-dlp', [
            '-f', formatInfo.formatId,
            '-o', outputPath,
            '--no-playlist',
            ...(formatInfo.needsMerge && FFMPEG_AVAILABLE ? ['--merge-output-format', 'mp4'] : []),
            videoUrl
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true
        });

        let stdout = '';
        let stderr = '';

        ytDlpProcess.stdout.on('data', (data) => {
            stdout += data.toString();
            
            // Parse progress from output
            const progressMatch = stdout.match(/(\d+\.?\d*)%/);
            if (progressMatch) {
                const percent = parseFloat(progressMatch[1]);
                downloadManager.update(downloadId, { progress: percent });
                
                // Extract additional info if available
                const speedMatch = stdout.match(/(\d+\.?\d*\s*(?:MiB|KiB|GiB)\/s)/);
                const sizeMatch = stdout.match(/of\s+(\d+\.?\d*\s*(?:MiB|KiB|GiB))/);
                
                if (speedMatch) downloadManager.update(downloadId, { speed: speedMatch[1] });
                if (sizeMatch) downloadManager.update(downloadId, { total: sizeMatch[1] });
            }
        });

        ytDlpProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ytDlpProcess.on('close', (code) => {
            console.log(`[Execute Download] Process exited with code: ${code}`);
            
            if (code === 0) {
                // Check if file exists
                if (fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    console.log(`[Execute Download] ✅ Success! File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                    resolve({ success: true, path: outputPath, size: stats.size });
                } else {
                    // File might be merged with different extension
                    const webmPath = outputPath.replace('.mp4', '.webm');
                    const mkvPath = outputPath.replace('.mp4', '.mkv');
                    
                    if (fs.existsSync(webmPath)) {
                        resolve({ success: true, path: webmPath, ext: 'webm' });
                    } else if (fs.existsSync(mkvPath)) {
                        resolve({ success: true, path: mkvPath, ext: 'mkv' });
                    } else {
                        reject(new Error('Download completed but output file not found'));
                    }
                }
            } else {
                const errorMsg = stderr.substring(stderr.length - 500);
                console.error(`[Execute Download] ❌ Failed: ${errorMsg}`);
                reject(new Error(`yt-dlp exited with code ${code}: ${errorMsg}`));
            }
        });

        ytDlpProcess.on('error', (err) => {
            console.error(`[Execute Download] ❌ Spawn error:`, err);
            reject(err);
        });

        // Timeout after 30 minutes
        setTimeout(() => {
            if (ytDlpProcess && !ytDlpProcess.killed) {
                console.log('[Execute Download] ⏰ Timeout reached, killing process');
                ytDlpProcess.kill();
                reject(new Error('Download timeout (30 minutes)'));
            }
        }, 30 * 60 * 1000);
    });
}

/**
 * ⭐ RENAME FUNCTION - Rename downloaded file to YouTube video title
 */
async function renameDownloadedFile(downloadObj, originalPath) {
    return new Promise((resolve) => {
        console.log('\n[Rename] Starting rename process...');
        console.log('[Rename] Original path:', originalPath);
        
        // Skip if no title available
        if (!downloadObj || !downloadObj.title) {
            console.log('[Rename] ⚠️ No title available, skipping rename');
            resolve({ success: false, reason: 'no_title', filename: null, originalFilename: null });
            return;
        }
        
        const videoTitle = downloadObj.title;
        console.log('[Rename] Target title:', videoTitle);
        
        // Sanitize filename (remove invalid characters)
        let sanitizedTitle = videoTitle
            .replace(/[<>:"/\\|?*]/g, '-')  // Replace invalid chars with hyphen
            .replace(/\s+/g, ' ')             // Collapse multiple spaces
            .trim();
        
        // Limit length (Windows max path is 260 chars, leave room for path)
        const maxTitleLength = 180;
        if (sanitizedTitle.length > maxTitleLength) {
            sanitizedTitle = sanitizedTitle.substring(0, maxTitleLength);
            console.log('[Rename] Title truncated to', maxTitleLength, 'chars');
        }
        
        const newFilename = sanitizedTitle + '.mp4';
        const newPath = path.join(DOWNLOADS_DIR, newFilename);
        
        console.log('[Rename] New filename:', newFilename);
        console.log('[Rename] New path:', newPath);
        
        // Check if source file exists
        if (!fs.existsSync(originalPath)) {
            console.log('[Rename] ⚠️ Original file not found:', originalPath);
            
            // Maybe it was already renamed or has different extension
            const extensions = ['.mp4', '.webm', '.mkv'];
            let foundAlternate = false;
            
            for (const ext of extensions) {
                const altPath = originalPath.replace(/\.[^.]+$/, ext);
                if (fs.existsSync(altPath)) {
                    console.log('[Rename] Found alternate file:', altPath);
                    originalPath = altPath;
                    foundAlternate = true;
                    break;
                }
            }
            
            if (!foundAlternate) {
                resolve({ success: false, reason: 'source_not_found', filename: null, originalFilename: null });
                return;
            }
        }
        
        // Handle duplicate filenames
        let finalNewPath = newPath;
        let finalNewFilename = newFilename;
        let counter = 1;
        
        while (fs.existsSync(finalNewPath)) {
            counter++;
            finalNewFilename = `${sanitizedTitle} (${counter}).mp4`;
            finalNewPath = path.join(DOWNLOADS_DIR, finalNewFilename);
            console.log('[Rename] Duplicate detected, trying:', finalNewFilename);
        }
        
        try {
            // Perform rename
            fs.renameSync(originalPath, finalNewPath);
            
            // Get file stats
            const stats = fs.statSync(finalNewPath);
            
            console.log('[Rename] ✅ Rename successful!');
            console.log('[Rename] From:', path.basename(originalPath));
            console.log('[Rename] To:', finalNewFilename);
            console.log('[Rename] Size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
            
            resolve({
                success: true,
                filename: finalNewFilename,
                originalFilename: path.basename(originalPath),
                path: finalNewPath,
                size: stats.size,
                renamedAt: new Date().toISOString()
            });
            
        } catch (err) {
            console.error('[Rename] ❌ Rename failed:', err.message);
            resolve({ 
                success: false, 
                reason: err.code || 'unknown_error', 
                error: err.message,
                filename: path.basename(originalPath),  // Return original name
                originalFilename: path.basename(originalPath)
            });
        }
    });
}

// =============================================================================
// FORMAT ANALYZER
// =============================================================================

function analyzeVideoFormats(videoUrl) {
    return new Promise((resolve, reject) => {
        console.log('\n[Format Analyzer] Starting analysis for:', videoUrl);
        console.log('[Format Analyzer] Using text-based parsing (reliable method)');
        
        const cmd = 'yt-dlp --list-formats "' + videoUrl + '"';
        
        console.log('[Format Analyzer] Command:', cmd);

        exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.log('[Format Analyzer] ❌ Format listing failed, using default');
                // Return default best format
                resolve({
                    formatId: 'best[ext=mp4]/best',
                    resolution: 'auto',
                    ext: 'mp4',
                    filesize: null,
                    filesizeMB: null,
                    vcodec: 'auto',
                    acodec: 'auto',
                    needsMerge: false
                });
                return;
            }

            console.log('[Format Analyzer] ✅ Got format list, parsing...');

            try {
                const formats = parseFormatsFromText(stdout);
                console.log('[Format Analyzer] Parsed', formats.length, 'formats');

                if (formats.length === 0) {
                    throw new Error('No formats found');
                }

                // Select BEST format (lowest quality for storage efficiency)
                const selected = selectBestFormat(formats);
                
                console.log('[Format Analyzer] 🎯 Selected format:');
                console.log('   ID:', selected.formatId);
                console.log('   Resolution:', selected.resolution);
                console.log('   Size:', selected.filesizeMB || 'unknown', 'MB');
                console.log('   Codec:', selected.vcodec + '/' + selected.acodec);

                resolve(selected);

            } catch (parseError) {
                console.error('[Format Analyzer] Parse error:', parseError.message);
                reject(parseError);
            }
        });
    });
}

function parseFormatsFromText(text) {
    const formats = [];
    const lines = text.split('\n');
    
    // Parse format lines
    // Example: "249 webm audio only tiny 53k , opus 22050Hz 160k, 487.65KiB"
    // Example: "18 mp4 360p  12M , avc1.42001E mp4a.40.2@ 130k, 11.85MiB"
    
    for (const line of lines) {
        // Skip header/footer lines
        if (!line.includes('mp4') && !line.includes('webm') && !line.includes('m4a')) continue;
        if (line.includes('ID') || line.includes('---') || line.includes('ext')) continue;
        
        const parts = line.trim().split(/\s{2,}/); // Split by 2+ spaces
        
        if (parts.length >= 2) {
            const formatId = parts[0].trim();
            const extPart = parts[1].trim();
            
            // Extract extension
            const extMatch = extPart.match(/(mp4|webm|m4a|mkv)/i);
            const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
            
            // Extract resolution
            const resolutionMatch = line.match(/(\d+)x(\d+)|(\d+p)/);
            const resolution = resolutionMatch ? resolutionMatch[0] : 'audio only';
            
            // Extract filesize
            const sizeMatch = line.match(/([\d.]+)\s*(MiB|GiB|KiB)/i);
            let filesize = null;
            let filesizeMB = null;
            
            if (sizeMatch) {
                filesize = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                
                if (unit === 'GiB') filesizeMB = filesize * 1024;
                else if (unit === 'KiB') filesizeMB = filesize / 1024;
                else filesizeMB = filesize;
            }
            
            // Detect audio-only
            const isAudioOnly = line.includes('audio only');
            
            // Extract codec info
            const vcodecMatch = line.match(/avc[\d.]+|vp\d+|av1/i);
            const acodecMatch = line.match(/mp4a\.\d+|opus|aac/i);
            
            const vcodec = vcodecMatch ? vcodecMatch[0] : (isAudioOnly ? null : 'unknown');
            const acodec = acodecMatch ? acodecMatch[0] : (isAudioOnly ? 'opus' : 'unknown');
            
            formats.push({
                formatId: formatId,
                ext: ext,
                resolution: resolution,
                filesize: filesize,
                filesizeMB: filesizeMB ? Math.round(filesizeMB * 100) / 100 : null,
                vcodec: vcodec,
                acodec: acodec,
                isAudioOnly: isAudioOnly,
                needsMerge: false // Will be updated later
            });
        }
    }
    
    // Mark formats that need merging (video without audio or vice versa)
    formats.forEach(f => {
        if (!f.isAudioOnly && f.acodec !== 'unknown' && f.vcodec !== null) {
            // Has both, check if they're separate
            f.needsMerge = line.includes('video only');
        }
    });
    
    return formats;
}

function selectBestFormat(formats) {
    // Filter to video-only formats (not audio only)
    const videoFormats = formats.filter(f => !f.isAudioOnly);
    
    if (videoFormats.length === 0) {
        // Fallback: return first format or default
        return formats[0] || {
            formatId: 'best[ext=mp4]/best',
            resolution: 'auto',
            ext: 'mp4',
            filesize: null,
            filesizeMB: null,
            vcodec: 'auto',
            acodec: 'auto',
            needsMerge: false
        };
    }
    
    // Sort by resolution (ascending - prefer lower quality for storage)
    const sortedByResolution = [...videoFormats].sort((a, b) => {
        const resA = parseInt(a.resolution) || 9999;
        const resB = parseInt(b.resolution) || 9999;
        return resA - resB;
    });
    
    // Prefer formats with smaller file sizes at same resolution
    const lowestRes = sortedByResolution[0];
    const sameResFormats = sortedByResolution.filter(f => 
        parseInt(f.resolution) === parseInt(lowestRes.resolution)
    );
    
    // Pick smallest file among same resolution
    const selected = sameResFormats.sort((a, b) => 
        (a.filesizeMB || 9999) - (b.filesizeMB || 9999)
    )[0];
    
    // Check if we need to merge (video-only format)
    const needsMerge = selected.resolution.includes('only') || 
                       !selected.acodec || 
                       selected.acodec === 'unknown';
    
    return {
        ...selected,
        needsMerge: needsMerge,
        // If merge needed, suggest also getting audio
        ...(needsMerge ? { audioFormatId: findBestAudioFormat(formats) } : {})
    };
}

function findBestAudioFormat(formats) {
    const audioFormats = formats.filter(f => f.isAudioOnly && f.ext === 'm4a');
    
    if (audioFormats.length > 0) {
        // Return smallest audio file
        return audioFormats.sort((a, b) => (a.filesizeMB || 0) - (b.filesizeMB || 0))[0].formatId;
    }
    
    return null; // Will use default audio extraction
}

// =============================================================================
// BATCH DOWNLOAD ENDPOINT
// =============================================================================

app.post('/api/download/batch', async (req, res) => {
    console.log('\n' + '='.repeat(80));
    console.log('📦 [Batch Download] POST /api/download/batch');
    console.log('='.repeat(80));

    try {
        const { videos, format, quality, channelId } = req.body;

        if (!videos || !Array.isArray(videos) || videos.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Videos array required'
            });
        }

        console.log(`[Batch Download] Received ${videos.length} videos for batch download`);
        console.log(`[Batch Download] Format: ${format || 'auto'}, Quality: ${quality || 'auto'}`);

        const results = [];
        let skippedCount = 0;
        let queuedCount = 0;
        let errorCount = 0;

        // Process each video
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            const videoId = video.id || video.videoId;
            const videoTitle = video.title || `Video ${i + 1}`;
            const videoUrl = video.url || `https://www.youtube.com/watch?v=${videoId}`;

            console.log(`\n[Batch Download] Processing [${i + 1}/${videos.length}]: ${videoTitle.substring(0, 50)}...`);

            // ⭐ Check if already downloaded (using enhanced fuzzy matching!)
            const statusCheck = getVideoStatus(videoId, videoTitle);
            
            if (statusCheck.status === 'downloaded') {
                console.log(`[Batch Download] ⏭️ Skipping (already downloaded): ${videoTitle.substring(0, 40)}`);
                skippedCount++;
                results.push({
                    index: i,
                    videoId: videoId,
                    title: videoTitle,
                    status: 'skipped',
                    reason: 'already_downloaded',
                    fileInfo: statusCheck.fileInfo ? {
                        filename: statusCheck.fileInfo.filename,
                        sizeMB: statusCheck.fileInfo.sizeMB
                    } : null
                });
                continue;
            }

            // Create download job
            const downloadId = uuidv4();
            const safeTitle = videoTitle.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
            const outputFilename = `${safeTitle}_${downloadId}.mp4`;
            const outputPath = path.join(DOWNLOADS_DIR, outputFilename);

            // Double-check file doesn't exist
            const existingFile = checkFileExists(outputFilename);
            if (existingFile.exists) {
                console.log(`[Batch Download] ⏭️ Skipping (file exists): ${outputFilename}`);
                skippedCount++;
                results.push({
                    index: i,
                    videoId: videoId,
                    title: videoTitle,
                    status: 'skipped',
                    reason: 'file_exists',
                    fileInfo: existingFile
                });
                continue;
            }

            // Add to download manager
            const download = downloadManager.add({
                id: downloadId,
                url: videoUrl,
                videoId: videoId,
                channelId: channelId,
                title: videoTitle,
                filename: outputFilename,
                outputPath: outputPath,
                format: format || 'best',
                quality: quality || 'lowest',
                status: 'queued',
                progress: 0,
                createdAt: new Date().toISOString()
            });

            queuedCount++;
            results.push({
                index: i,
                videoId: videoId,
                title: videoTitle,
                status: 'queued',
                jobId: downloadId,
                filename: outputFilename
            });

            // Start download in background (sequential to avoid rate limits)
            setTimeout(() => {
                executeSmartDownload(downloadId, videoUrl, outputPath, videoTitle);
            }, i * 2000); // 2-second delay between downloads
        }

        console.log(`\n[Batch Download] ✅ Batch processing complete:`);
        console.log(`   Queued: ${queuedCount}`);
        console.log(`   Skipped (already exist): ${skippedCount}`);
        console.log(`   Errors: ${errorCount}`);

        res.json({
            success: true,
            message: `Batch download initiated: ${queuedCount} queued, ${skippedCount} skipped`,
            summary: {
                total: videos.length,
                queued: queuedCount,
                skipped: skippedCount,
                errors: errorCount
            },
            results: results,
            batchId: uuidv4()
        });

    } catch (error) {
        console.error('[Batch Download] ❌ Error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Batch download failed: ' + error.message
        });
    }
});

// =============================================================================
// SYSTEM STATUS ENDPOINT
// =============================================================================

app.get('/api/system/status', (req, res) => {
    const activeDownloads = downloadManager.getActive();
    const completedDownloads = downloadManager.getCompleted();
    
    res.json({
        success: true,
        system: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            platform: process.platform,
            nodeVersion: process.version
        },
        downloads: {
            dir: DOWNLOADS_DIR,
            exists: fs.existsSync(DOWNLOADS_DIR),
            activeCount: activeDownloads.length,
            completedCount: completedDownloads.length,
            totalCount: downloadManager.getAll().length,
            trackedVideos: downloadedVideos.size,
            indexedFiles: downloadedFilesIndex.size
        },
        channels: {
            saved: savedChannels.size
        },
        tools: {
            ffmpeg: FFMPEG_AVAILABLE,
            cookies: isCookiesFileValid()
        }
    });
});

// =============================================================================
// FILE SERVING ENDPOINT
// =============================================================================

app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => f.endsWith('.mp4') || f.endsWith('.webm'))
            .map(f => {
                const filePath = path.join(DOWNLOADS_DIR, f);
                const stats = fs.statSync(filePath);
                return {
                    name: f,
                    size: stats.size,
                    sizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100,
                    modified: stats.mtime,
                    created: stats.birthtime
                };
            })
            .sort((a, b) => new Date(b.modified) - new Date(a.modified));

        res.json({
            success: true,
            files: files,
            count: files.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/download-file/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOADS_DIR, filename);

    // Security: Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((err, req, res, next) => {
    console.error('\n❌ [Server Error]', err.message);
    console.error('Stack:', err.stack);
    
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
    console.log('   POST  /api/channels');
    console.log('   DELETE /api/channels/:id');
    console.log('   POST  /api/channels/:id/check');
    console.log('   GET  /api/channel/info');
    console.log('   POST  /api/video/info');
    console.log('   POST  /api/download');           // ← MAIN DOWNLOAD ENDPOINT!
    console.log('   POST  /api/download/start');
    console.log('   GET  /api/download/:jobId');     // ← Status check
    console.log('   GET  /api/download/:id');       // Legacy status
    console.log('   POST  /api/download/:id/cancel');
    console.log('   GET  /api/downloads');
    console.log('   POST  /api/download/batch');     // ← Batch with format analysis!
    console.log('   GET  /api/download/list');
    console.log('   GET  /api/download-queue');      // ← Queue status (frontend polls!)
    console.log('   DELETE /api/download-queue');    // ← Clear queue
    console.log('   GET  /api/downloaded-files');    // ← ⭐ NEW: Get downloaded files!
    console.log('   POST  /api/downloaded-files/check'); // ⭐ NEW: Batch check videos!
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
            '/api/downloaded-files',       // ← ⭐ NEW: Download sync!
            '/api/downloaded-files/check', // ⭐ NEW: Batch check!
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
    console.log(`║  📊 Sync Index: ${downloadedFilesIndex.size} files indexed for matching          ║`);
    console.log('║                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  Available API Endpoints:                                   ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  GET    /api/settings          View/change download folder     ║');
    console.log('║  PUT    /api/settings          Update settings                 ║');
    console.log('║  POST   /api/channels          Load channel videos             ║');
    console.log('║  POST   /api/download           Download single video           ║');
    console.log('║  POST   /api/download/batch     Batch download (sequential)     ║');
    console.log('║  GET    /api/downloaded-files   ⭐ List downloaded files        ║');
    console.log('║  POST   /api/downloaded-files/check ⭐ Check video status      ║');
    console.log('║  GET    /api/files              List all downloaded files        ║');
    console.log('║  GET    /api/download-file/:id  Download file by ID            ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('⭐ DOWNLOAD SYNC FEATURE ENABLED');
    console.log('   - Fuzzy title matching for renamed files');
    console.log('   - Automatic skip of already-downloaded videos');
    console.log('   - Real-time status badges (green=done, red=new)');
    console.log('');
});
