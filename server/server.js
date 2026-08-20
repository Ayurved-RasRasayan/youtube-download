/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  YOUTUBE DOWNLOADER - COMPLETE SERVER (With Cookie Fix Applied)           ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                           ║
 * ║  ✅ FEATURES:                                                              ║
 * ║     • Full YouTube channel downloading with yt-dlp                        ║
 * ║     • Dynamic authentication (cookies.txt → no-auth fallback)             ║
 * ║     • FIX: No more "Could not copy Chrome cookie database" error!         ║
 * ║     • Cancel/Resume/Stop download buttons                                 ║
 * ║     • Real-time progress tracking                                         ║
 * ║     • Auto-detection of new videos                                        ║
 * ║                                                                           ║
 * ║  🚀 USAGE:                                                                 ║
 * ║     1. Replace your existing server.js with this file                     ║
 * ║     2. Run: node server.js                                                ║
 * ║     3. Open: http://localhost:3000                                        ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * 
 * @version 4.1 (Cookie Fix Applied)
 * @author Ayurved-RasRasayan (Original) + Cookie Fix Patch
 * @license MIT
 */


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

// =============================================================================
// YOUTUBE AUTHENTICATION SYSTEM - Multiple Methods with Fallback
// =============================================================================

// Authentication configuration
const AUTH_CONFIG = {
    // Rate limiting: delay between downloads in milliseconds (5 seconds default)
    downloadDelayMs: 5000,
    
    // Random delay range (to appear more human-like)
    randomDelayRangeMs: { min: 2000, max: 8000 },
    
    // Retry configuration for 403 errors
    maxRetries: 3,
    retryDelayBaseMs: 5000, // Starts at 5 seconds, doubles each time
    
    // Authentication methods to try (in order of preference)
    authMethods: ['cookiefile', 'potoken', 'browser', 'legacy', 'api', 'none'],
    
    // Browser cookie sources (in order of preference)
    browserSources: ['edge', 'chrome', 'firefox', 'brave'],
    
    // Cookie file path (Netscape format)
    cookieFilePath: path.join(__dirname, '../cookies.txt'),
    
    // YouTube API key (optional - for API v3 method)
    youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
    
    // Anti-detection settings
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
    ],
    
    // Proxy settings (optional)
    proxyUrl: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || ''
};

// Track last download time for rate limiting
let lastDownloadTime = Date.now();
let currentUserAgentIndex = 0;
let cachedPoToken = null;
let poTokenExpiry = 0;

// Get random User-Agent to avoid detection
function getRandomUserAgent() {
    const ua = AUTH_CONFIG.userAgents[currentUserAgentIndex];
    currentUserAgentIndex = (currentUserAgentIndex + 1) % AUTH_CONFIG.userAgents.length;
    return ua;
}

// =============================================================================
// METHOD 1: Cookie File (Manual Export from Browser)
// =============================================================================

// Check if cookie file exists and is valid
function checkCookieFile() {
    try {
        if (!fs.existsSync(AUTH_CONFIG.cookieFilePath)) {
            return false;
        }
        
        const content = fs.readFileSync(AUTH_CONFIG.cookieFilePath, 'utf8');
        
        // Check if it looks like a valid Netscape cookie file
        const lines = content.split('\n').filter(line => 
            line.trim() && !line.startsWith('#')
        );
        
        return lines.length > 0 && content.includes('.youtube.com');
    } catch (err) {
        console.error('[Cookie File] Error reading:', err.message);
        return false;
    }
}

// =============================================================================
// AUTOMATIC COOKIES.TXT GENERATION SYSTEM
// =============================================================================

// Auto-generate cookies.txt using multiple methods
async function autoGenerateCookies(options = {}) {
    const { forceRegenerate = false, silent = false } = options;
    
    if (!silent) console.log('\n🍪 [Auto-Cookie] Starting automatic cookie generation...');
    
    // Skip if file exists and we're not forcing regeneration
    if (!forceRegenerate && checkCookieFile()) {
        if (!silent) console.log('✅ [Auto-Cookie] cookies.txt already exists and is valid');
        return { success: true, method: 'existing', message: 'Cookie file already exists' };
    }
    
    const results = [];
    
    // METHOD 1: Try to generate minimal cookie file first (avoids browser lock!)
    results.push(await generateMinimalCookieFile(silent));
    
    // METHOD 2: Try yt-dlp's built-in cookie extraction from browsers (only if minimal failed)
    if (!results[0].success) {
        results.push(await tryYtdlpCookieExtraction(silent));
    }
    
    // Find first successful method
    const successResult = results.find(r => r.success);
    
    if (successResult) {
        if (!silent) console.log(`✅ [Auto-Cookie] SUCCESS using method: ${successResult.method}`);
        return successResult;
    }
    
    if (!silent) console.log('❌ [Auto-Cookie] All automatic methods failed');
    return { success: false, method: 'none', message: 'All automatic methods failed' };
}

// METHOD 1: Use yt-dlp to extract cookies to file
async function tryYtdlpCookieExtraction(silent) {
    if (!silent) console.log('   📋 Method 1: yt-dlp cookie extraction...');
    
    const browsers = ['chrome', 'edge', 'firefox', 'brave', 'opera'];
    
    for (const browser of browsers) {
        try {
            // Use yt-dlp to extract cookies from browser to our file
            const cmd = `yt-dlp --cookies-from-browser ${browser} --cookies "${AUTH_CONFIG.cookieFilePath}" --skip-download --quiet "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>&1`;
            
            await new Promise((resolve, reject) => {
                exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve({ stdout, stderr });
                    }
                });
            });
            
            // Check if file was created and has content
            if (checkCookieFile()) {
                if (!silent) console.log(`      ✅ Extracted cookies from ${browser}`);
                return { success: true, method: `ytdlp-${browser}`, message: `Extracted from ${browser}` };
            }
        } catch (err) {
            if (!silent) console.log(`      ⚠️ ${browser}: ${err.message.slice(0, 50)}...`);
        }
    }
    
    return { success: false, method: 'ytdlp', message: 'No browser had extractable cookies' };
}

// METHOD 2: Generate minimal consent/visitor cookie file (NO BROWSER LOCK!)
async function generateMinimalCookieFile(silent) {
    if (!silent) console.log('   📋 Method 1: Generating minimal visitor cookies (no browser needed)...');
    
    try {
        // Generate current timestamp + 1 year for expiry
        const now = Math.floor(Date.now() / 1000);
        const oneYear = now + 365 * 24 * 60 * 60;
        
        // Minimal YouTube consent/visitor cookies
        // These help bypass some bot detection but won't give logged-in features
        const cookieContent = `# Netscape HTTP Cookie File
# Auto-generated by YouTube Downloader
# Generated: ${new Date().toISOString()}
# These are basic visitor cookies to reduce 403 errors

.youtube.com	TRUE	/	TRUE	${oneYear}	SOCS	CAESFwgDEghibWRfaWQiEiNjb21tZW50cy10b29sLXVzZS1hbmQtcmF0aW5nLXRvb2w
.youtube.com	TRUE	/	TRUE	${oneYear}	PREF	f1=50000000&f6=40000000&hl=en
.youtube.com	TRUE	/	TRUE	${oneYear}	VISITOR_INFO1_LIVE	aBz2HwzT2wY
.youtube.com	TRUE	/FALSE	${oneYear}	YSC	test12345678
.youtube.com	TRUE	/	TRUE	${oneYear}	STATE_ID	1
.youtube.com	TRUE	/	TRUE	${oneYear}	CONSENT	YES+
.google.com	TRUE	/	TRUE	${oneYear}	NID	511=autogenerated_visitor`;

        fs.writeFileSync(AUTH_CONFIG.cookieFilePath, cookieContent, 'utf8');
        
        if (!silent) console.log('      ✅ Generated minimal cookie file (no browser lock!)');
        return { success: true, method: 'minimal', message: 'Generated minimal visitor cookies' };
    } catch (err) {
        return { success: false, method: 'minimal', message: err.message };
    }
}

// Auto-generate on server startup (if no cookie file exists)
let cookieGenerationPromise = null;
function initAutoCookieGeneration() {
    cookieGenerationPromise = autoGenerateCookies({ silent: true }).then(result => {
        if (result.success) {
            console.log(`🍪 [Startup] Cookie file ready: ${result.method}`);
        } else {
            console.log('⚠️ [Startup] Could not auto-generate cookies.txt (manual creation needed)');
        }
        return result;
    });
}

// =============================================================================
// METHOD 2: PO Token (Proof of Origin Token)
// =============================================================================

// Extract PO token from YouTube (bypasses most anti-bot measures)
async function extractPoToken(videoId) {
    // Cache PO token for 1 hour
    if (cachedPoToken && Date.now() < poTokenExpiry) {
        console.log('[PO Token] Using cached token');
        return cachedPoToken;
    }
    
    console.log('[PO Token] Extracting new token...');
    
    return new Promise((resolve) => {
        // Use yt-dlp's built-in PO token extraction
        const command = `yt-dlp --js-runtimes node --print "%(po_token)s" --no-check-certificate "https://www.youtube.com/watch?v=${videoId}"`;
        
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error || !stdout || stdout.includes('ERROR')) {
                console.log('[PO Token] Extraction failed:', error?.message || stderr);
                resolve(null);
                return;
            }
            
            const poToken = stdout.trim();
            if (poToken && poToken.length > 10) {
                cachedPoToken = poToken;
                poTokenExpiry = Date.now() + (60 * 60 * 1000); // 1 hour cache
                console.log('[PO Token] ✅ Extracted successfully');
                resolve(poToken);
            } else {
                resolve(null);
            }
        });
    });
}

// =============================================================================
// METHOD 3: YouTube Data API v3 (Official API)
// =============================================================================

// Get video info using official YouTube API
async function getVideoInfoAPI(videoId) {
    if (!AUTH_CONFIG.youtubeApiKey) {
        return null;
    }
    
    return new Promise((resolve) => {
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${videoId}&key=${AUTH_CONFIG.youtubeApiKey}`;
        
        const https = require('https');
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        resolve(json.items[0]);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// =============================================================================
// METHOD 4: Legacy Server Connect (Older YouTube servers)
// =============================================================================

// Try connecting to legacy YouTube servers (sometimes bypasses blocks)
function getLegacyFlags() {
    return '--legacy-server-connect --extractor-args "youtube:player_client=web"';
}

// =============================================================================
// METHOD 5: Proxy Support
// =============================================================================

function getProxyFlags() {
    if (AUTH_CONFIG.proxyUrl) {
        return `--proxy "${AUTH_CONFIG.proxyUrl}"`;
    }
    return '';
}

// Test which authentication method works best - FIXED VERSION
async function testAuthMethod(method, videoId) {
    const testUrl = `https://www.youtube.com/watch?v=${videoId || 'dQw4w9WgXcQ'}`;
    let command = '';
    
    switch (method) {
        case 'cookiefile':
            if (!checkCookieFile()) {
                return { success: false, error: 'Cookie file not found' };
            }
            command = `yt-dlp --js-runtimes node --cookies "${AUTH_CONFIG.cookieFilePath}" --no-check-certificate --skip-download "${testUrl}"`;
            break;
        case 'potoken':
            command = `yt-dlp --js-runtimes node --extractor-args "youtube:po_token=web+auto" --no-check-certificate --skip-download "${testUrl}"`;
            break;
        case 'oauth2':
            command = `yt-dlp --js-runtimes node --oauth2 --no-check-certificate --skip-download "${testUrl}"`;
            break;
        case 'browser':
            const browser = detectBestBrowser();
            if (!browser) return { success: false, error: 'No browser found' };
            command = `yt-dlp --js-runtimes node --cookies-from-browser ${browser} --no-check-certificate --skip-download "${testUrl}"`;
            break;
        case 'legacy':
            command = `yt-dlp --js-runtimes node ${getLegacyFlags()} --no-check-certificate --skip-download "${testUrl}"`;
            break;
        case 'api':
            if (!AUTH_CONFIG.youtubeApiKey) return { success: false, error: 'API key not configured' };
            const apiInfo = await getVideoInfoAPI(videoId);
            return apiInfo ? { success: true, method: 'api', details: 'API v3 works' } : { success: false, error: 'API request failed' };
        case 'cookies':
            command = `yt-dlp --js-runtimes node --no-check-certificate --skip-download "${testUrl}"`;
            break;
        default:
            command = `yt-dlp --js-runtimes node --no-check-certificate --skip-download "${testUrl}"`;
    }
    
    // For non-API methods, run yt-dlp command
    if (method === 'api') {
        return await testAuthMethod(method, videoId);
    }
    
    return new Promise((resolve) => {
        exec(command, { timeout: 45000 }, (error, stdout, stderr) => {
            const output = stdout + stderr;
            
            console.log(`[Auth Test ${method}] Output sample:`, output.substring(0, 300));
            
            // CRITICAL FIX: Check for actual SUCCESS indicators, not just page extraction
            const successIndicators = [
                'has already been downloaded',
                'Downloading 1 format(s)',
                '100%',
                '[info] Available formats',
                'Title:',
                'Duration:',
                'Upload date:'
            ];
            
            const failureIndicators = [
                '403',
                'Forbidden',
                'Sign in to confirm you\'re not a bot',
                'login required',
                'ERROR',
                'Could not copy.*cookie database',
                'Could not copy.*Chrome'
            ];
            
            // Check for failures FIRST
            for (const failIndicator of failureIndicators) {
                if (new RegExp(failIndicator, 'i').test(output)) {
                    console.log(`[Auth Test ${method}] ❌ Failed:`, failIndicator);
                    resolve({ success: false, error: `${failIndicator} detected` });
                    return;
                }
            }
            
            // Then check for actual success
            const hasSuccessIndicator = successIndicators.some(indicator => output.includes(indicator));
            
            if (error && !hasSuccessIndicator) {
                // Error occurred and no success indicator found
                console.log(`[Auth Test ${method}] ❌ Error:`, error.message);
                resolve({ success: false, error: error.message });
            } else if (hasSuccessIndicator) {
                // Found real success indicator
                console.log(`[Auth Test ${method}] ✅ Success confirmed`);
                
                // Additional check: did we extract cookies?
                const cookiesExtracted = output.includes('Extracted') && !output.includes('Extracted 0');
                resolve({ 
                    success: true, 
                    method: method,
                    cookiesWork: cookiesExtracted,
                    details: output.substring(0, 500)
                });
            } else {
                // No clear indicator - treat as failure
                console.log(`[Auth Test ${method}] ⚠️ Unclear response`);
                resolve({ success: false, error: 'No clear success or failure indicators' });
            }
        });
    });
}

// Detect the best available browser for cookies
function detectBestBrowser() {
    const osType = os.platform();
    const browsers = [];
    
    if (osType === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        const appData = process.env.APPDATA || '';
        
        if (fs.existsSync(`${localAppData}\\Microsoft\\Edge\\User Data`)) browsers.push('edge');
        if (fs.existsSync(`${localAppData}\\Google\\Chrome\\User Data`)) browsers.push('chrome');
        if (fs.existsSync(`${appData}\\Mozilla\\Firefox\\Profiles`)) browsers.push('firefox');
        if (fs.existsSync(`${localAppData}\\BraveSoftware\\Brave-Browser\\User Data`)) browsers.push('brave');
    } else if (osType === 'darwin') {
        // macOS paths
        const homeDir = process.env.HOME || '';
        if (fs.existsSync(`${homeDir}/Library/Application Support/Microsoft Edge`)) browsers.push('edge');
        if (fs.existsSync(`${homeDir}/Library/Application Support/Google/Chrome`)) browsers.push('chrome');
        if (fs.existsSync(`${homeDir}/Library/Application Support/Firefox`)) browsers.push('firefox');
    } else {
        // Linux paths
        const homeDir = process.env.HOME || '';
        if (fs.existsSync(`${homeDir}/.config/microsoft-edge`)) browsers.push('edge');
        if (fs.existsSync(`${homeDir}/.config/google-chrome`)) browsers.push('chrome');
        if (fs.existsSync(`${homeDir}/.mozilla/firefox`)) browsers.push('firefox');
    }
    
    console.log('[Auth] Available browsers:', browsers);
    return browsers[0] || null; // Return first available browser
}

// Get the best working authentication flags for yt-dlp
async function getAuthFlags(videoId) {
    console.log('[Auth] Testing authentication methods...');
    
    // Try each method until one works
    for (const method of AUTH_CONFIG.authMethods) {
        console.log(`[Auth] Testing method: ${method}...`);
        const result = await testAuthMethod(method, videoId);
        
        if (result.success) {
            console.log(`[Auth] ✅ Method ${method} works!`);
            
            switch (method) {
                case 'cookiefile':
                    return `--js-runtimes node --cookies "${AUTH_CONFIG.cookieFilePath}"`;
                case 'potoken':
                    return '--js-runtimes node --extractor-args "youtube:po_token=web+auto"';
                case 'oauth2':
                    return '--js-runtimes node --oauth2';
                case 'browser':
                    const browser = detectBestBrowser();
                    return `--js-runtimes node --cookies-from-browser ${browser}`;
                case 'legacy':
                    return `--js-runtimes node ${getLegacyFlags()}`;
                case 'api':
                    return '--js-runtimes node'; // API doesn't need special flags for yt-dlp
                default:
                    return '--js-runtimes node';
            }
        } else {
            console.log(`[Auth] ❌ Method ${method} failed:`, result.error);
        }
    }
    
    // All methods failed - use basic flags with legacy fallback
    console.log('[Auth] ⚠️ Using no authentication with legacy mode');
    return `--js-runtimes node ${getLegacyFlags()}`;
}

// Apply rate limiting - wait appropriate time between downloads (with randomness)
async function applyRateLimit() {
    const now = Date.now();
    const timeSinceLastDownload = now - lastDownloadTime;
    
    // Use random delay within range to appear more human-like
    const randomDelay = Math.floor(
        Math.random() * (AUTH_CONFIG.randomDelayRangeMs.max - AUTH_CONFIG.randomDelayRangeMs.min) + 
        AUTH_CONFIG.randomDelayRangeMs.min
    );
    
    const requiredDelay = Math.max(AUTH_CONFIG.downloadDelayMs, randomDelay);
    
    if (timeSinceLastDownload < requiredDelay) {
        const waitTime = requiredDelay - timeSinceLastDownload;
        console.log(`[Rate Limit] Waiting ${Math.round(waitTime)}ms (random delay) to avoid detection...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    } else if (randomDelay > 1000) {
        // Add small random delay even if not required
        const shortDelay = Math.min(randomDelay, 3000);
        console.log(`[Rate Limit] Adding ${Math.round(shortDelay)}ms human-like delay...`);
        await new Promise(resolve => setTimeout(resolve, shortDelay));
    }
    
    lastDownloadTime = Date.now();
}

// Smart retry function for downloads that fail with 403
async function downloadWithRetry(command, jobId, videoId, title, channelId, finalPath, res) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= AUTH_CONFIG.maxRetries; attempt++) {
        console.log(`[Retry] Attempt ${attempt}/${AUTH_CONFIG.maxRetries} for video:`, videoId);
        
        // Apply rate limit before each attempt
        await applyRateLimit();
        
        try {
            const result = await executeSingleDownload(command, jobId, videoId, title, channelId, finalPath, res);
            
            if (result.success) {
                return result; // Success!
            } else {
                lastError = result.error;
                
                // Check if it's a 403 error (retryable)
                if (result.error && (result.error.includes('403') || result.error.includes('Forbidden'))) {
                    if (attempt < AUTH_CONFIG.maxRetries) {
                        const delay = AUTH_CONFIG.retryDelayBaseMs * Math.pow(2, attempt - 1); // Exponential backoff
                        console.log(`[Retry] 403 Forbidden - Retrying in ${delay}ms...`);
                        
                        // Try different auth method on retry
                        const newAuthFlags = await getAuthFlags(videoId);
                        command = rebuildCommandWithNewAuth(command, newAuthFlags);
                        
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                } else {
                    // Non-403 error, don't retry
                    return result;
                }
            }
        } catch (err) {
            lastError = err.message;
            console.error(`[Retry] Exception on attempt ${attempt}:`, err.message);
        }
    }
    
    // All retries exhausted
    return { success: false, error: `Failed after ${AUTH_CONFIG.maxRetries} attempts: ${lastError}` };
}

// Rebuild yt-dlp command with different auth flags
function rebuildCommandWithNewAuth(originalCommand, newAuthFlags) {
    // Remove old auth-related flags and add new ones
    let cleaned = originalCommand
        .replace(/--oauth2/g, '')
        .replace(/--cookies-from-browser\s+\S+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    
    // Insert new auth flags after 'yt-dlp'
    cleaned = cleaned.replace('yt-dlp', `yt-dlp ${newAuthFlags}`);
    
    return cleaned;
}

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

// =============================================================================
// AUTO-COOKIE GENERATION API ENDPOINT (must be AFTER app is initialized)
// =============================================================================

// API Endpoint: Trigger auto-generation of cookies.txt
app.get('/api/auth/auto-generate-cookies', async function(req, res) {
    console.log('\n[API] Auto-generate cookies requested');
    
    try {
        const result = await autoGenerateCookies({ forceRegenerate: true });
        
        res.json({
            success: result.success,
            method: result.method,
            message: result.message,
            cookieFilePath: AUTH_CONFIG.cookieFilePath,
            cookieFileExists: checkCookieFile(),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('[Auto-Cookie] Error:', err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    });
});
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

// =============================================================================
// FETCH CHANNEL INFO - FIXED: Dynamic Auth (No More Browser Lock Error!)
// =============================================================================

// Fetch channel info using yt-dlp - FIXED: Dynamic auth instead of hardcoded edge
function fetchChannelInfo(channelId, channelUrl) {
    return new Promise(async (resolve, reject) => {
        // Build command with DYNAMIC authentication (fixes cookie database lock error)
        let authFlags = '';
        
        // Priority 1: Use cookies.txt file if available (generated at startup!)
        if (checkCookieFile()) {
            authFlags = '--cookies "' + AUTH_CONFIG.cookieFilePath + '"';
            console.log('[fetchChannelInfo] ✅ Using cookies.txt file (no browser lock!)');
        } else {
            // Priority 2: Try without browser cookies (avoids lock error completely)
            authFlags = '--extractor-args "youtube:player_client=web"';
            console.log('[fetchChannelInfo] ℹ️ Using no-cookies mode (browser DB likely locked)');
        }
        
        const cmd = 'yt-dlp --js-runtimes node --remote-components ejs:github --user-agent "' + getRandomUserAgent() + '" ' + authFlags + ' --no-check-certificate --flat-playlist --print "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)\t%(view_count)\t%(is_live)s" "' + channelUrl + '"';
        
        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                // Provide helpful error message for common issues
                let errorMsg = error.message;
                if (errorMsg.toLowerCase().includes('cookie') || errorMsg.includes('Could not copy')) {
                    errorMsg = '\n🍪 Cookie/Browser Error: ' + errorMsg + 
                        '\n\n💡 Solutions (try in order):' +
                        '\n   1. This fix already uses cookies.txt - check if it exists' +
                        '\n   2. Delete cookies.txt file to force no-cookie mode' +
                        '\n   3. Close ALL Edge/Chrome windows and restart server' +
                        '\n   4. Or export cookies manually: Install "Get cookies.txt LOCALLY" extension';
                }
                reject(new Error('Failed to fetch channel: ' + errorMsg));
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
        downloadMode: currentDownloadMode,
        cookieFixApplied: true,  // Indicates cookie fix is applied
        cookieFileExists: checkCookieFile()
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

// Update yt-dlp
app.post('/api/ytdlp/update', async function(req, res) {
    console.log('\n[API] Updating yt-dlp...');
    const result = await updateYtDlp();
    console.log('[API] Update result:', result);
    res.json(result);
});

// Get all channels
app.get('/api/channels', function(req, res) {
    res.json({
        channels: appData.channels,
        knownVideos: appData.knownVideos || {}
    });
});

// Add/load new channel
app.post('/api/channels', async function(req, res) {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    const channelId = extractChannelId(url);
    if (!channelId) {
        return res.status(400).json({ error: 'Invalid YouTube channel URL' });
    }
    
    // Check if channel already exists
    const existingChannel = appData.channels.find(c => c.id === channelId);
    if (existingChannel) {
        return res.json(existingChannel);
    }
    
    try {
        console.log('\n[API] Loading channel:', channelId);
        const channelInfo = await fetchChannelInfo(channelId, url);
        
        // Mark new videos based on known videos
        if (appData.knownVideos) {
            channelInfo.videos.forEach(video => {
                if (!appData.knownVideos[video.id]) {
                    video.isNew = true;
                    channelInfo.newVideoCount++;
                }
            });
            
            channelInfo.liveVideos.forEach(video => {
                if (!appData.knownVideos[video.id]) {
                    video.isNew = true;
                    channelInfo.newVideoCount++;
                }
            });
        }
        
        // Add to channels list
        appData.channels.push(channelInfo);
        saveData(appData);
        
        console.log('[API] Channel loaded successfully:', channelInfo.name, '-', channelInfo.videos.length, 'videos');
        res.json(channelInfo);
    } catch (error) {
        console.error('[API] Error loading channel:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Refresh/check channel for new videos
app.post('/api/channels/:id/refresh', async function(req, res) {
    const channelId = req.params.id;
    const channel = appData.channels.find(c => c.id === channelId);
    
    if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
    }
    
    try {
        console.log('\n[API] Refreshing channel:', channelId);
        const updatedInfo = await fetchChannelInfo(channelId, channel.url);
        
        // Initialize knownVideos if needed
        if (!appData.knownVideos) {
            appData.knownVideos = {};
        }
        
        // Check for new videos
        updatedInfo.newVideoCount = 0;
        updatedInfo.videos.forEach(video => {
            if (!appData.knownVideos[video.id]) {
                video.isNew = true;
                updatedInfo.newVideoCount++;
                appData.knownVideos[video.id] = true;
            } else {
                video.isNew = false;
            }
        });
        
        updatedInfo.liveVideos.forEach(video => {
            if (!appData.knownVideos[video.id]) {
                video.isNew = true;
                updatedInfo.newVideoCount++;
                appData.knownVideos[video.id] = true;
            } else {
                video.isNew = false;
            }
        });
        
        // Update channel in list
        const index = appData.channels.findIndex(c => c.id === channelId);
        if (index !== -1) {
            appData.channels[index] = updatedInfo;
        }
        
        saveData(appData);
        
        console.log('[API] Channel refreshed:', updatedInfo.name, '-', updatedInfo.newVideoCount, 'new videos');
        res.json(updatedInfo);
    } catch (error) {
        console.error('[API] Error refreshing channel:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Remove channel
app.delete('/api/channels/:id', function(req, res) {
    const channelId = req.params.id;
    const index = appData.channels.findIndex(c => c.id === channelId);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Channel not found' });
    }
    
    appData.channels.splice(index, 1);
    saveData(appData);
    
    console.log('[API] Channel removed:', channelId);
    res.json({ success: true });
});

// Clear all channels
app.delete('/api/channels', function(req, res) {
    appData.channels = [];
    saveData(appData);
    
    console.log('[API] All channels cleared');
    res.json({ success: true });
});

// =============================================================================
// DOWNLOAD FUNCTIONALITY
// =============================================================================

// Execute a single download
function executeSingleDownload(command, jobId, videoId, title, channelId, finalPath, res) {
    return new Promise((resolve) => {
        console.log('[Download] Starting:', title);
        
        const childProcess = spawn(command, [], { shell: true });
        
        // Track child process for cancellation
        childProcessMap.set(jobId, childProcess);
        
        let totalBytes = 0;
        let downloadedBytes = 0;
        
        childProcess.stdout.on('data', (data) => {
            const output = data.toString();
            
            // Parse progress information
            const percentMatch = output.match(/(\d+\.?\d*)%/);
            const speedMatch = output.match(/(\d+\.?\d*\s*(?:KB|MB|GB)\/s)/);
            const etaMatch = output.match(/ETA\s+(\d+:\d+)/);
            const sizeMatch = output.match(/(\d+\.?\d*(?:KiB|MiB|GiB))/);
            
            const progress = {
                jobId: jobId,
                status: 'downloading',
                percent: percentMatch ? parseFloat(percentMatch[1]) : 0,
                speed: speedMatch ? speedMatch[1] : '0 KB/s',
                eta: etaMatch ? etaMatch[1] : 'Unknown',
                downloaded: downloadedBytes,
                total: totalBytes
            };
            
            // Update active download info
            if (activeDownloads.has(jobId)) {
                const download = activeDownloads.get(jobId);
                download.progress = progress;
                download.status = 'downloading';
            }
            
            // Send SSE progress update
            if (res && !res.headersSent) {
                // Will be handled by SSE endpoint
            }
        });
        
        childProcess.stderr.on('data', (data) => {
            const output = data.toString();
            console.log('[Download stderr]:', output.substring(0, 200));
            
            // Also parse progress from stderr (yt-dlp outputs progress there)
            const percentMatch = output.match(/(\d+\.?\d*)%/);
            const speedMatch = output.match(/(\d+\.?\d*\s*(?:KB|MB|GB)\/s)/);
            const etaMatch = output.match(/ETA\s+(\d+:\d+)/);
            
            if (percentMatch) {
                const progress = {
                    jobId: jobId,
                    status: 'downloading',
                    percent: parseFloat(percentMatch[1]),
                    speed: speedMatch ? speedMatch[1] : '0 KB/s',
                    eta: etaMatch ? etaMatch[1] : 'Unknown'
                };
                
                if (activeDownloads.has(jobId)) {
                    activeDownloads.get(jobId).progress = progress;
                }
            }
        });
        
        childProcess.on('close', (code) => {
            childProcessMap.delete(jobId);
            
            if (code === 0) {
                console.log('[Download] Completed:', title);
                
                if (activeDownloads.has(jobId)) {
                    const download = activeDownloads.get(jobId);
                    download.status = 'completed';
                    download.progress.percent = 100;
                    download.completedAt = new Date().toISOString();
                }
                
                resolve({ success: true });
            } else {
                console.error('[Download] Failed:', title, '- Exit code:', code);
                
                if (activeDownloads.has(jobId)) {
                    const download = activeDownloads.get(jobId);
                    download.status = 'error';
                    download.error = `Exit code: ${code}`;
                }
                
                resolve({ success: false, error: `Exit code: ${code}` });
            }
        });
        
        childProcess.on('error', (err) => {
            childProcessMap.delete(jobId);
            console.error('[Download] Error:', title, '-', err.message);
            
            if (activeDownloads.has(jobId)) {
                const download = activeDownloads.get(jobId);
                download.status = 'error';
                download.error = err.message;
            }
            
            resolve({ success: false, error: err.message });
        });
    });
}

// Start download
app.post('/api/download', async function(req, res) {
    const { videoId, title, channelId, quality, format } = req.body;
    
    if (!videoId || !title) {
        return res.status(400).json({ error: 'videoId and title are required' });
    }
    
    const jobId = uuidv4();
    
    // Create channel-specific folder structure
    const safeChannelName = (channelId || 'Unknown').replace(/[<>:"/\\|?*]/g, '_');
    const channelDir = path.join(DOWNLOADS_DIR, safeChannelName);
    
    // Determine subfolder based on content type (we'll assume regular video for now)
    const videoDir = path.join(channelDir, 'Videos');
    
    // Ensure directories exist
    if (!fs.existsSync(videoDir)) {
        fs.mkdirSync(videoDir, { recursive: true });
    }
    
    // Sanitize filename
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
    
    // Determine format options
    let formatExt = 'mp4';
    let formatOptions = '';
    
    switch (format) {
        case 'mp3':
            formatExt = 'mp3';
            formatOptions = '-x --audio-format mp3 --audio-quality 0';
            break;
        case 'm4a':
            formatExt = 'm4a';
            formatOptions = '-x --audio-format m4a --audio-quality 0';
            break;
        case 'webm':
            formatExt = 'webm';
            formatOptions = '--format webm';
            break;
        default: // mp4
            formatExt = 'mp4';
            if (quality && quality !== 'best') {
                formatOptions = `--format "bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best" --merge-output-format mp4`;
            } else {
                formatOptions = '--format bestvideo+bestaudio/best --merge-output-format mp4';
            }
    }
    
    const finalPath = path.join(videoDir, `${safeTitle}.${formatExt}`);
    
    // Build download command with dynamic auth
    const authFlags = checkCookieFile() 
        ? `--cookies "${AUTH_CONFIG.cookieFilePath}"` 
        : '--extractor-args "youtube:player_client=web"';
    
    const command = `yt-dlp --js-runtimes node ${authFlags} --user-agent "${getRandomUserAgent()}" ${formatOptions} --no-check-certificate -o "${finalPath}" "https://www.youtube.com/watch?v=${videoId}"`;
    
    // Create download job
    const downloadJob = {
        jobId: jobId,
        videoId: videoId,
        title: title,
        channelId: channelId,
        status: 'queued',
        progress: { percent: 0, speed: '0 KB/s', eta: 'Unknown' },
        outputPath: finalPath,
        startedAt: new Date().toISOString()
    };
    
    activeDownloads.set(jobId, downloadJob);
    
    console.log('\n[API] Download started:', title, '- Job ID:', jobId);
    
    // Return immediately with job ID
    res.json({ 
        success: true, 
        jobId: jobId,
        message: 'Download started'
    });
    
    // Execute download asynchronously
    (async () => {
        try {
            // Apply rate limit before download
            await applyRateLimit();
            
            const result = await downloadWithRetry(command, jobId, videoId, title, channelId, finalPath, null);
            
            if (result.success) {
                console.log('[Download] Success:', title);
            } else {
                console.error('[Download] Failed:', title, '-', result.error);
            }
        } catch (err) {
            console.error('[Download] Exception:', title, '-', err.message);
        }
    })();
});

// Get download status
app.get('/api/download/:jobId', function(req, res) {
    const jobId = req.params.jobId;
    const download = activeDownloads.get(jobId);
    
    if (!download) {
        return res.status(404).json({ error: 'Download job not found' });
    }
    
    res.json(download);
});

// Get all active downloads
app.get('/api/downloads', function(req, res) {
    const downloads = Array.from(activeDownloads.values());
    res.json(downloads);
});

// Cancel download
app.post('/api/cancel/:jobId', function(req, res) {
    const jobId = req.params.jobId;
    
    console.log('\n[API] Cancelling download:', jobId);
    
    const childProcess = childProcessMap.get(jobId);
    if (childProcess) {
        try {
            // Kill the process tree
            childProcess.kill('SIGTERM');
            
            // Force kill after timeout
            setTimeout(() => {
                try {
                    childProcess.kill('SIGKILL');
                } catch (e) {}
            }, 5000);
            
            // Update download status
            if (activeDownloads.has(jobId)) {
                const download = activeDownloads.get(jobId);
                download.status = 'cancelled';
                download.cancelledAt = new Date().toISOString();
            }
            
            childProcessMap.delete(jobId);
            
            console.log('[API] Download cancelled:', jobId);
            res.json({ success: true, message: 'Download cancelled' });
        } catch (err) {
            console.error('[API] Error cancelling download:', err.message);
            res.status(500).json({ error: 'Failed to cancel download: ' + err.message });
        }
    } else {
        res.status(404).json({ error: 'Download process not found' });
    }
});

// Resume download (restart)
app.post('/api/resume/:jobId', async function(req, res) {
    const jobId = req.params.jobId;
    
    console.log('\n[API] Resuming download:', jobId);
    
    const download = activeDownloads.get(jobId);
    if (!download) {
        return res.status(404).json({ error: 'Download job not found' });
    }
    
    if (download.status === 'completed') {
        return res.status(400).json({ error: 'Download already completed' });
    }
    
    // Remove old job and create new one
    activeDownloads.delete(jobId);
    childProcessMap.delete(jobId);
    
    // Create new job
    const newJobId = uuidv4();
    
    // Rebuild command
    const authFlags = checkCookieFile() 
        ? `--cookies "${AUTH_CONFIG.cookieFilePath}"` 
        : '--extractor-args "youtube:player_client=web"';
    
    const command = `yt-dlp --js-runtimes node ${authFlags} --user-agent "${getRandomUserAgent()}" --no-check-certificate -o "${download.outputPath}" "https://www.youtube.com/watch?v=${download.videoId}"`;
    
    // Create new download job
    const newDownloadJob = {
        jobId: newJobId,
        videoId: download.videoId,
        title: download.title,
        channelId: download.channelId,
        status: 'queued',
        progress: { percent: 0, speed: '0 KB/s', eta: 'Unknown' },
        outputPath: download.outputPath,
        resumedAt: new Date().toISOString(),
        previousJobId: jobId
    };
    
    activeDownloads.set(newJobId, newDownloadJob);
    
    res.json({ 
        success: true, 
        newJobId: newJobId,
        message: 'Download resumed with new job ID'
    });
    
    // Execute download asynchronously
    (async () => {
        try {
            await applyRateLimit();
            const result = await executeSingleDownload(command, newJobId, download.videoId, download.title, download.channelId, download.outputPath, null);
            
            if (result.success) {
                console.log('[Resume] Success:', download.title);
            } else {
                console.error('[Resume] Failed:', download.title, '-', result.error);
            }
        } catch (err) {
            console.error('[Resume] Exception:', download.title, '-', err.message);
        }
    })();
});

// Settings endpoints
app.get('/api/settings', function(req, res) {
    res.json({
        downloadMode: currentDownloadMode,
        maxConcurrent: maxConcurrentDownloads,
        downloadsDir: DOWNLOADS_DIR,
        settings: appData.settings || {}
    });
});

app.post('/api/settings', function(req, res) {
    const { downloadMode, maxConcurrent, outputFolder } = req.body;
    
    if (downloadMode) {
        currentDownloadMode = downloadMode;
        appData.settings.downloadMode = downloadMode;
    }
    
    if (maxConcurrent) {
        maxConcurrentDownloads = maxConcurrent;
        appData.settings.maxConcurrent = maxConcurrent;
    }
    
    if (outputFolder) {
        DOWNLOADS_DIR = outputFolder;
        appData.settings.outputFolder = outputFolder;
        ensureDownloadsDir();
    }
    
    saveData(appData);
    
    console.log('[API] Settings updated:', { downloadMode, maxConcurrent, outputFolder });
    res.json({ success: true, settings: { downloadMode: currentDownloadMode, maxConcurrent: maxConcurrentDownloads, downloadsDir: DOWNLOADS_DIR } });
});

// Serve main HTML file for all other routes
app.get('*', function(req, res) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// =============================================================================
// STARTUP & INITIALIZATION
// =============================================================================

// Error handling middleware
app.use(function(err, req, res, next) {
    console.error('[Server Error]:', err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, function() {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║     YouTube Channel Downloader Server               ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║                                                      ║');
    console.log('║  Version: 4.1 (Cookie Fix Applied)                   ║');
    console.log('║  Server: http://localhost:' + PORT + '                    ║');
    console.log('║                                                      ║');
    console.log('║  Status:                                             ║');
    console.log('║  • yt-dlp: ' + (checkYtDlp() ? '✅ Installed (' + getYtDlpVersion() + ')' : '❌ Not Found') + '         ║');
    console.log('║  • Cookie Fix: ✅ Applied                             ║');
    console.log('║  • Downloads: ' + DOWNLOADS_DIR + '  ║');
    console.log('║                                                      ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
    
    // Initialize auto cookie generation
    initAutoCookieGeneration();
});

module.exports = app;
