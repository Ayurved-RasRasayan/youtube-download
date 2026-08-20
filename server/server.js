
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// =============================================================================
// ROBUST PATH RESOLUTION - Windows/Cygwin Compatible
// =============================================================================

function resolvePublicPath(relativePath) {
    const possiblePaths = [
        // Method 1: Standard relative path
        path.join(__dirname, '../public', relativePath),
        // Method 2: Using process.cwd() 
        path.join(process.cwd(), '..', 'public', relativePath),
        // Method 3: Resolve from script location
        path.resolve(__dirname, '..', 'public', relativePath),
        // Method 4: Try absolute paths based on common locations
        path.join(path.dirname(process.argv[1]), '..', 'public', relativePath),
    ];
    
    // Remove duplicates and check each path
    const uniquePaths = [...new Set(possiblePaths)];
    
    for (const p of uniquePaths) {
        console.log('[Path Resolver] Checking:', p);
        if (fs.existsSync(p)) {
            console.log('[Path Resolver] ✅ FOUND:', p);
            return p;
        }
    }
    
    // Last resort: return first path (will show error)
    console.log('[Path Resolver] ❌ NOT FOUND, using fallback');
    return possiblePaths[0];
}

function findIndexHtml() {
    const possiblePaths = [
        // Primary location
        path.join(__dirname, '../public/index.html'),
        // Alternative locations
        path.join(__dirname, '../../public/index.html'),
        path.join(process.cwd(), '../public/index.html'),
        path.join(process.cwd(), 'public/index.html'),
        path.resolve(__dirname, '..', 'public', 'index.html'),
        // Windows-specific paths
        path.join(__dirname.replace(/\\/g, '/').replace(/\/g, '/'), '../public/index.html'),
    ];
    
    console.log('\n[findIndexHtml] Searching for index.html...');
    
    for (const p of possiblePaths) {
        console.log('   Checking:', p);
        try {
            if (fs.existsSync(p)) {
                console.log('   ✅ FOUND:', p);
                return p;
            }
        } catch(e) {
            console.log('   ❌ Error:', e.message);
        }
    }
    
    console.log('   ⚠️ index.html not found in any location!');
    return null;
}


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
    
    // METHOD 1: Try yt-dlp's built-in cookie extraction from browsers
    results.push(await tryYtdlpCookieExtraction(silent));
    
    // METHOD 2: Try to extract from browser profile directly (Chrome/Edge)
    results.push(await tryDirectBrowserCookieExtraction(silent));
    
    // METHOD 3: Generate minimal cookie file with consent/visitor info
    results.push(await generateMinimalCookieFile(silent));
    
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

// METHOD 2: Direct extraction from browser SQLite databases
async function tryDirectBrowserCookieExtraction(silent) {
    if (!silent) console.log('   📋 Method 2: Direct browser database extraction...');
    
    // Common browser cookie database paths by OS
    const platform = process.platform;
    const homeDir = os.homedir();
    let browserPaths = [];
    
    if (platform === 'win32') {
        browserPaths = [
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies'),
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies'),
        ];
    } else if (platform === 'darwin') {
        browserPaths = [
            path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Network', 'Cookies'),
            path.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Network', 'Cookies'),
        ];
    } else {
        // Linux
        browserPaths = [
            path.join(homeDir, '.config', 'google-chrome', 'Default', 'Network', 'Cookies'),
            path.join(homeDir, '.config', 'microsoft-edge', 'Default', 'Network', 'Cookies'),
        ];
    }
    
    for (const dbPath of browserPaths) {
        if (fs.existsSync(dbPath)) {
            try {
                // Try to read SQLite database (requires sqlite3 or copying)
                if (!silent) console.log(`      Found: ${dbPath}`);
                
                // Create a temporary Python script for extraction
                const pythonScript = `
import sqlite3, os, sys, shutil

db_path = r'''${dbPath}'''
output_path = r'''${AUTH_CONFIG.cookieFilePath}'''

# Copy database to avoid lock issues
temp_db = output_path + '.temp.db'
shutil.copy2(db_path, temp_db)

try:
    conn = sqlite3.connect(temp_db)
    cursor = conn.cursor()
    
    # YouTube domains to extract
    cursor.execute("""
        SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly 
        FROM cookies 
        WHERE host_key LIKE '%.youtube.com' 
           OR host_key LIKE 'youtube.com'
           OR host_key LIKE '%.google.com'
           OR host_key LIKE 'google.com'
    """)
    
    rows = cursor.fetchall()
    
    if len(rows) == 0:
        print('NO_COOKIES')
        sys.exit(0)
    
    # Write Netscape format
    with open(output_path, 'w') as f:
        f.write('# Netscape HTTP Cookie File\\n')
        for row in rows:
            host_key, name, value, path, expires, secure, httponly = row
            expires_unix = int(expires / 1000000 - 11644473600) if expires > 0 else 0
            secure_flag = 'TRUE' if secure else 'FALSE'
            f.write('%s\\tTRUE\\t%s\\t%s\\t%d\\t%s\\t%s\\n' % (
                host_key, path, secure_flag, expires_unix, name, value
            ))
    
    print('EXTRACTED_%d_COOKIES' % len(rows))
finally:
    conn.close()
    os.remove(temp_db)
`;
                
                // Write script to temp file and execute
                const scriptPath = AUTH_CONFIG.cookieFilePath + '_extract.py';
                fs.writeFileSync(scriptPath, pythonScript);
                
                const result = await new Promise((resolve) => {
                    exec(`python3 "${scriptPath}" 2>&1`, { timeout: 15000 }, (error, stdout, stderr) => {
                        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), error });
                    });
                });
                
                // Clean up temp script
                try { fs.unlinkSync(scriptPath); } catch(e) {}
                
                if (result.stdout.includes('EXTRACTED')) {
                    const count = result.stdout.match(/EXTRACTED_(\d+)_COOKIES/)?.[1];
                    if (!silent) console.log(`      ✅ Extracted ${count} cookies`);
                    return { success: true, method: 'direct-sqlite', message: `Extracted ${count} cookies` };
                }
            } catch (err) {
                if (!silent) console.log(`      ⚠️ Direct extraction failed: ${err.message.slice(0, 50)}`);
            }
        }
    }
    
    return { success: false, method: 'direct', message: 'No browser databases found' };
}

// METHOD 3: Generate minimal consent/visitor cookie file
async function generateMinimalCookieFile(silent) {
    if (!silent) console.log('   📋 Method 3: Generating minimal visitor cookies...');
    
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

.youtube.com    TRUE    /       TRUE    ${oneYear}      SOCS    CAESFwgDEghibWRfaWQiEiNjb21tZW50cy10b29sLXVzZS1hbmQtcmF0aW5nLXRvb2w
.youtube.com    TRUE    /       TRUE    ${oneYear}      PREF    f1=50000000&f6=40000000&hl=en
.youtube.com    TRUE    /       TRUE    ${oneYear}      VISITOR_INFO1_LIVE      aBz2HwzT2wY
.youtube.com    TRUE    /       FALSE   ${oneYear}      YSC     test12345678
.youtube.com    TRUE    /       TRUE    ${oneYear}      STATE_ID        1
.youtube.com    TRUE    /       TRUE    ${oneYear}      CONSENT YES+
.google.com     TRUE    /       TRUE    ${oneYear}      NID     511=autogenerated_visitor`;

        fs.writeFileSync(AUTH_CONFIG.cookieFilePath, cookieContent, 'utf8');
        
        if (!silent) console.log('      ✅ Generated minimal cookie file');
        return { success: true, method: 'minimal', message: 'Generated minimal visitor cookies' };
    } catch (err) {
        return { success: false, method: 'minimal', message: err.message };
    }
}

// Auto-generate on server startup (if no cookie file exists)
// NOTE: API endpoint registered AFTER app is initialized (see below)
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

// Generate instructions for creating cookie file
function getCookieFileInstructions() {
    return `
╔══════════════════════════════════════════════════════════════╗
║           HOW TO CREATE COOKIES.TXT FILE                     ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  STEP 1: Install "Get cookies.txt" browser extension         ║
║          • Chrome/Edge: Search "Get cookies.txt LOCALLY"     ║
║          • Or visit: https://chrome.google.com/webstore      ║
║                                                              ║
║  STEP 2: Go to youtube.com in your browser                   ║
║          • Make sure you're LOGGED IN                        ║
║          • Go to any video page                              ║
║                                                              ║
║  STEP 3: Click the extension icon                            ║
║          • Select "Export" or "Current Site"                 ║
║          • Save as "cookies.txt"                             ║
║                                                              ║
║  STEP 4: Place the file in:                                  ║
║          ${AUTH_CONFIG.cookieFilePath}
║                                                              ║
║  OR use the API endpoint below to upload directly!            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`;
}

// =============================================================================
// METHOD 2: PO Token (Proof of Origin Token) - NEW!
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
            // API method doesn't use yt-dlp for testing
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
        return await testAuthMethod(method, videoId); // Already handled above
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
                'ERROR'
            ];
            
            // Check for failures FIRST
            for (const failIndicator of failureIndicators) {
                if (output.includes(failIndicator)) {
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
// SKIP ALREADY DOWNLOADED FILES SYSTEM
// =============================================================================

// Check if a video file already exists in the output folder
function checkIfAlreadyDownloaded(videoId, title, channelId, outputFolder) {
    const effectiveDownloadsDir = outputFolder || DOWNLOADS_DIR;
    const safeTitle = sanitizeFilename(title.replace(/[^a-z0-9]/gi, '_').substring(0, 100));
    const channelFolder = sanitizeFilename(channelId || 'general');
    
    // DEBUG: Log what we're checking
    console.log(`\n[Skip-Check DEBUG]`);
    console.log(`   Video ID: ${videoId}`);
    console.log(`   Title: ${title}`);
    console.log(`   Safe Title: ${safeTitle}`);
    console.log(`   Channel ID: ${channelId}`);
    console.log(`   Channel Folder: ${channelFolder}`);
    console.log(`   Downloads Dir: ${effectiveDownloadsDir}`);
    
    // Possible locations: Videos folder or Live Streams folder
    const possiblePaths = [
        path.join(effectiveDownloadsDir, channelFolder, 'Videos'),
        path.join(effectiveDownloadsDir, channelFolder, 'Live Streams'),
        effectiveDownloadsDir, // Also check root downloads dir
        path.join(effectiveDownloadsDir, channelFolder) // Check channel root
    ];
    
    console.log(`   Checking paths:`);
    possiblePaths.forEach((p, i) => {
        const exists = fs.existsSync(p);
        console.log(`     [${i+1}] ${p} - ${exists ? 'EXISTS' : 'NOT FOUND'}`);
        if (exists) {
            try {
                const files = fs.readdirSync(p);
                console.log(`         Files found: ${files.length}`);
                if (files.length > 0) {
                    console.log(`         First 5 files: ${files.slice(0, 5).join(', ')}`);
                }
            } catch (e) {
                console.log(`         Error reading: ${e.message}`);
            }
        }
    });
    
    // Common video file extensions to check
    const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.flv', '.m4a', '.mp3'];
    
    for (const dirPath of possiblePaths) {
        try {
            if (!fs.existsSync(dirPath)) continue;
            
            const files = fs.readdirSync(dirPath);
            
            for (const file of files) {
                const fileName = path.basename(file, path.extname(file));
                const ext = path.extname(file).toLowerCase();
                
                // Check 1: Exact title match (with sanitized filename)
                if (fileName === safeTitle && videoExtensions.includes(ext)) {
                    console.log(`   ✅ MATCH (exact-title): ${file}`);
                    return {
                        exists: true,
                        filePath: path.join(dirPath, file),
                        fileName: file,
                        matchType: 'exact-title'
                    };
                }
                
                // Check 2: Video ID in filename (yt-dlp sometimes adds it)
                if (fileName.includes(videoId) && videoExtensions.includes(ext)) {
                    console.log(`   ✅ MATCH (video-id): ${file}`);
                    return {
                        exists: true,
                        filePath: path.join(dirPath, file),
                        fileName: file,
                        matchType: 'video-id'
                    };
                }
                
                // Check 3: Partial title match (handles slight variations)
                const safeTitleShort = safeTitle.substring(0, 30);
                if (fileName.includes(safeTitleShort) && videoExtensions.includes(ext)) {
                    console.log(`   ✅ MATCH (partial-title): ${file}`);
                    return {
                        exists: true,
                        filePath: path.join(dirPath, file),
                        fileName: file,
                        matchType: 'partial-title'
                    };
                }
            }
        } catch (err) {
            console.error(`[Skip-Check] Error checking ${dirPath}:`, err.message);
        }
    }
    
    console.log(`   ❌ NO MATCH FOUND`);
    return { exists: false, filePath: null, fileName: null, matchType: null };
}

// Get file info (size, modification date) for already downloaded files
function getFileInfo(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return {
            size: stats.size,
            sizeFormatted: formatFileSize(stats.size),
            modifiedAt: stats.mtime.toISOString(),
            modifiedAgo: getTimeAgo(stats.mtime)
        };
    } catch (err) {
        return { size: 0, sizeFormatted: 'Unknown', modifiedAt: null, modifiedAgo: 'Unknown' };
    }
}

// Format file size in human-readable format
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Get relative time string (e.g., "2 hours ago")
function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    const intervals = [
        { label: 'year', seconds: 31536000 },
        { label: 'month', seconds: 2592000 },
        { label: 'week', seconds: 604800 },
        { label: 'day', seconds: 86400 },
        { label: 'hour', seconds: 3600 },
        { label: 'minute', seconds: 60 }
    ];
    
    for (const interval of intervals) {
        const count = Math.floor(seconds / interval.seconds);
        if (count >= 1) {
            return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
        }
    }
    return 'just now';
}

// API Endpoint: Debug skip-check system (shows what's happening)
app.get('/api/debug/skip-check', function(req, res) {
    const testVideoId = req.query.videoId || 'test123';
    const testTitle = req.query.title || 'Test Video';
    const testChannelId = req.query.channelId || 'GoldRasayan';
    
    console.log('\n[DEBUG] === SKIP CHECK DEBUG INFO ===');
    
    // Show system configuration
    const debugInfo = {
        timestamp: new Date().toISOString(),
        systemConfig: {
            DOWNLOADS_DIR: DOWNLOADS_DIR,
            DEFAULT_DOWNLOADS_DIR: DEFAULT_DOWNLOADS_DIR,
            osHomedir: os.homedir(),
            platform: process.platform
        },
        testParameters: {
            videoId: testVideoId,
            title: testTitle,
            channelId: testChannelId,
            safeTitle: sanitizeFilename(testTitle.replace(/[^a-z0-9]/gi, '_').substring(0, 100)),
            channelFolder: sanitizeFilename(testChannelId)
        },
        pathsChecked: [],
        filesFound: []
    };
    
    // Check and list actual paths
    const channelFolder = sanitizeFilename(testChannelId);
    const pathsToCheck = [
        path.join(DOWNLOADS_DIR, channelFolder, 'Videos'),
        path.join(DOWNLOADS_DIR, channelFolder, 'Live Streams'),
        DOWNLOADS_DIR,
        path.join(DOWNLOADS_DIR, channelFolder)
    ];
    
    pathsToCheck.forEach(p => {
        const exists = fs.existsSync(p);
        const pathInfo = { path: p, exists: exists };
        
        if (exists) {
            try {
                const files = fs.readdirSync(p);
                pathInfo.fileCount = files.length;
                pathInfo.sampleFiles = files.slice(0, 10); // First 10 files
                
                // Get file details for first few
                pathInfo.fileDetails = files.slice(0, 5).map(f => {
                    const filePath = path.join(p, f);
                    try {
                        const stats = fs.statSync(filePath);
                        return {
                            name: f,
                            size: formatFileSize(stats.size),
                            modified: stats.mtime.toISOString()
                        };
                    } catch(e) {
                        return { name: f, error: e.message };
                    }
                });
                
                debugInfo.filesFound.push(...files);
            } catch (e) {
                pathInfo.error = e.message;
            }
        }
        
        debugInfo.pathsChecked.push(pathInfo);
    });
    
    // Run actual check
    const checkResult = checkIfAlreadyDownloaded(testVideoId, testTitle, testChannelId, null);
    debugInfo.checkResult = checkResult;
    
    if (checkResult.exists) {
        debugInfo.fileInfo = getFileInfo(checkResult.filePath);
    }
    
    console.log('[DEBUG] === END DEBUG INFO ===\n');
    
    res.json(debugInfo);
});

// API Endpoint: Check if specific video is already downloaded
app.get('/api/check-downloaded/:videoId', function(req, res) {
    const videoId = req.params.videoId;
    const title = req.query.title || videoId;
    const channelId = req.query.channelId || '';
    const outputFolder = req.query.outputFolder || null;
    
    const result = checkIfAlreadyDownloaded(videoId, title, channelId, outputFolder);
    
    if (result.exists) {
        const fileInfo = getFileInfo(result.filePath);
        res.json({
            exists: true,
            ...result,
            fileInfo: fileInfo,
            message: `File already exists: ${result.fileName}`,
            action: 'skip'
        });
    } else {
        res.json({
            exists: false,
            message: 'File not found - ready to download',
            action: 'download'
        });
    }
});

// API Endpoint: Batch check multiple videos and return which ones are already downloaded
app.post('/api/batch-check-downloaded', function(req, res) {
    const videos = req.body.videos; // Array of { videoId, title, channelId }
    const outputFolder = req.body.outputFolder || null;
    
    if (!videos || !Array.isArray(videos)) {
        return res.status(400).json({ error: 'videos array is required' });
    }
    
    const results = {
        total: videos.length,
        alreadyDownloaded: [],
        needDownload: [],
        summary: {}
    };
    
    videos.forEach(function(video) {
        const checkResult = checkIfAlreadyDownloaded(
            video.videoId, 
            video.title || video.videoId, 
            video.channelId || '', 
            outputFolder
        );
        
        if (checkResult.exists) {
            results.alreadyDownloaded.push({
                ...video,
                ...checkResult,
                fileInfo: getFileInfo(checkResult.filePath)
            });
        } else {
            results.needDownload.push({
                ...video,
                ...checkResult
            });
        }
    });
    
    results.summary = {
        total: videos.length,
        alreadyDownloaded: results.alreadyDownloaded.length,
        needDownload: results.needDownload.length,
        skippedPercent: ((results.alreadyDownloaded.length / videos.length) * 100).toFixed(1) + '%'
    };
    
    res.json(results);
});

// API Endpoint: Open file location in system file explorer
app.post('/api/open-file', function(req, res) {
    const filePath = req.body.path;
    
    if (!filePath) {
        return res.status(400).json({ error: 'File path is required' });
    }
    
    console.log(`[Open File] Request to open: ${filePath}`);
    
    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found: ' + filePath });
        }
        
        // Use platform-appropriate command to open file location
        let command;
        const platform = process.platform;
        
        if (platform === 'win32') {
            // Windows: Open in Explorer and select file
            command = `explorer /select,"${filePath}"`;
        } else if (platform === 'darwin') {
            // macOS: Open in Finder and select file
            command = `open -R "${filePath}"`;
        } else {
            // Linux: Open containing folder
            const dirPath = path.dirname(filePath);
            command = `xdg-open "${dirPath}"`;
        }
        
        exec(command, function(error) {
            if (error) {
                console.error('[Open File] Error:', error.message);
                return res.status(500).json({ 
                    success: false, 
                    error: 'Failed to open file: ' + error.message 
                });
            }
            
            console.log(`[Open File] ✅ Opened: ${filePath}`);
            res.json({ 
                success: true, 
                message: 'File location opened',
                path: filePath
            });
        });
        
    } catch (err) {
        console.error('[Open File] Exception:', err.message);
        res.status(500).json({ 
            success: false, 
            error: err.message 
        });
    }
});

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
    }
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
        console.log('\n[Channel] Loading channel:', channelId);
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
        
        // =========================================================================
        // AUTO-SYNC: Check all videos against existing files in output folder
        // =========================================================================
        console.log(`[Channel Sync] Checking ${channelData.videos.length + channelData.liveVideos.length} videos against existing files...`);
        
        let alreadyDownloadedCount = 0;
        let needDownloadCount = 0;
        
        // Check regular videos
        channelData.videos.forEach(function(video) {
            const existingFile = checkIfAlreadyDownloaded(video.id, video.title, channelId, DOWNLOADS_DIR);
            if (existingFile.exists) {
                video.alreadyDownloaded = true;  // Mark for frontend
                video.existingFile = existingFile.fileName;
                video.existingFilePath = existingFile.filePath;
                video.fileInfo = getFileInfo(existingFile.filePath);
                video.matchType = existingFile.matchType;
                alreadyDownloadedCount++;
                console.log(`   ✅ Already downloaded: ${video.title}`);
            } else {
                video.alreadyDownloaded = false;
                needDownloadCount++;
            }
        });
        
        // Check live videos
        channelData.liveVideos.forEach(function(video) {
            const existingFile = checkIfAlreadyDownloaded(video.id, video.title, channelId, DOWNLOADS_DIR);
            if (existingFile.exists) {
                video.alreadyDownloaded = true;
                video.existingFile = existingFile.fileName;
                video.existingFilePath = existingFile.filePath;
                video.fileInfo = getFileInfo(existingFile.filePath);
                video.matchType = existingFile.matchType;
                alreadyDownloadedCount++;
                console.log(`   ✅ Already downloaded (live): ${video.title}`);
            } else {
                video.alreadyDownloaded = false;
                needDownloadCount++;
            }
        });
        
        // Add sync stats to response
        channelData.syncStats = {
            totalVideos: channelData.videos.length + channelData.liveVideos.length,
            alreadyDownloaded: alreadyDownloadedCount,
            needDownload: needDownloadCount,
            skipPercent: ((alreadyDownloadedCount / (channelData.videos.length + channelData.liveVideos.length)) * 100).toFixed(1) + '%'
        };
        
        console.log(`[Channel Sync] Complete: ${alreadyDownloadedCount} already downloaded, ${needDownloadCount} need download`);
        console.log(`[Channel Sync] Skip rate: ${channelData.syncStats.skipPercent}`);

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
            message: `Channel loaded! Found ${newCount} new videos, ${alreadyDownloadedCount} already downloaded`,
            channel: channelData,
            syncStats: channelData.syncStats
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
async function getBestLowQualityFormat(videoId) {
    return new Promise(async (resolve, reject) => {
        console.log('[Format Analyzer] Analyzing formats for video:', videoId);
        
        // Get best authentication flags
        const authFlags = await getAuthFlags(videoId);
        
        // CRITICAL: Use detected auth flags - REQUIRED for YouTube as of 2024+
        const listCmd = `yt-dlp ${authFlags} --list-formats --no-check-certificate "https://www.youtube.com/watch?v=${videoId}"`;
        
        // Increased timeout to 60 seconds (some videos take longer to analyze)
        exec(listCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('[Format Analyzer] Error listing formats:', error.message);
                console.error('[Format Analyzer] Using fallback: format 18 (360p pre-merged MP4)');
                // Fallback to format 18 - most reliable pre-merged MP4 with audio
                resolve('18');
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

// Execute the actual download (single attempt - returns Promise)
function executeSingleDownload(command, jobId, videoId, title, channelId, finalPath) {
    return new Promise((resolve) => {
        console.log('[Download] ✅ SPAWNING DOWNLOAD PROCESS for:', videoId, '-', title);
        
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
            console.log('[Download stdout]', data.toString().trim().substring(0, 200));
            parseProgress(output, jobId);
        });

        child.stderr.on('data', function(data) {
            errorOutput += data.toString();
            console.log('[Download stderr]', data.toString().trim().substring(0, 200));
            parseProgress(errorOutput, jobId);
        });

        child.on('close', function(code) {
            console.log('[Download] ❗ PROCESS CLOSED - Exit code:', code, 'for video:', videoId);
            
            if (code === 0) {
                console.log('[Download] ✅ SUCCESS - Video downloaded:', title);
                resolve({ success: true });
                
                // Update job status
                const job = activeDownloads.get(jobId);
                if (job) {
                    job.status = 'completed';
                    job.progress = 100;
                    markAsDownloaded(channelId, videoId);
                    job.completedAt = new Date().toISOString();
                    childProcessMap.delete(jobId);
                }
            } else if (code === null) {
                console.log('[Download] ⛔ CANCELLED - Video:', title);
                resolve({ success: false, error: 'Cancelled' });
                
                const job = activeDownloads.get(jobId);
                if (job) {
                    job.status = 'cancelled';
                    job.error = 'Download cancelled by user';
                    job.completedAt = new Date().toISOString();
                    childProcessMap.delete(jobId);
                }
            } else {
                console.error('[Download] ❌ FAILED - Video:', title);
                console.error('[Download] Error output:', errorOutput.substring(0, 1000));
                resolve({ success: false, error: errorOutput.substring(0, 500) });
                
                const job = activeDownloads.get(jobId);
                if (job) {
                    job.status = 'error';
                    job.error = errorOutput.substring(0, 500);
                    job.completedAt = new Date().toISOString();
                    childProcessMap.delete(jobId);
                }
            }
            
            // Process next in queue after completion
            processDownloadQueue();
        });

        child.on('error', function(err) {
            console.error('[Download] 💥 SPAWN ERROR for video:', videoId, '-', err.message);
            resolve({ success: false, error: err.message });
            
            const job = activeDownloads.get(jobId);
            if (job) {
                job.status = 'error';
                job.error = err.message;
            }
            processDownloadQueue();
        });
    });
}

// Main download execution function with auth, rate limiting, and retries
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
    
    // =========================================================================
    // SKIP CHECK: Check if file already exists BEFORE starting download
    // =========================================================================
    console.log(`[Skip-Check] Checking if "${title}" is already downloaded...`);
    const existingFile = checkIfAlreadyDownloaded(videoId, title, channelId, effectiveDownloadsDir);
    
    if (existingFile.exists) {
        const fileInfo = getFileInfo(existingFile.filePath);
        console.log(`[Skip-Check] ✅ File ALREADY EXISTS: ${existingFile.fileName}`);
        console.log(`[Skip-Check] 📁 Path: ${existingFile.filePath}`);
        console.log(`[Skip-Check] 📊 Size: ${fileInfo.sizeFormatted}, Modified: ${fileInfo.modifiedAgo}`);
        
        // Mark as "already_downloaded" and return success (skip download)
        const skippedJob = {
            id: jobId,
            videoId: videoId,
            title: title,
            status: 'already_downloaded', // Special status for skipped files
            progress: 100,
            speed: 'Skipped',
            eta: '',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            mode: currentDownloadMode,
            outputPath: existingFile.filePath,
            skipReason: `File already exists: ${existingFile.fileName}`,
            fileInfo: fileInfo,
            matchType: existingFile.matchType
        };
        
        activeDownloads.set(jobId, skippedJob);
        
        // Log to console with visual indicator
        console.log('\n' + '='.repeat(60));
        console.log('⏭️  SKIPPED - File Already Downloaded');
        console.log('='.repeat(60));
        console.log(`   Title: ${title}`);
        console.log(`   File: ${existingFile.fileName}`);
        console.log(`   Size: ${fileInfo.sizeFormatted}`);
        console.log(`   Location: ${existingFile.filePath}`);
        console.log('='.repeat(60) + '\n');
        
        // Return success response (file already exists)
        if (res && !res.headersSent) {
            res.json({ 
                success: true, 
                jobId: jobId,
                skipped: true,
                message: 'File already downloaded - skipped',
                file: existingFile.fileName,
                path: existingFile.filePath,
                fileInfo: fileInfo
            });
        }
        
        return; // EXIT - Don't proceed with download
    }
    
    console.log(`[Skip-Check] ❌ File not found - proceeding with download...`);
    
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
        
        // STEP 2: Get best authentication flags
        console.log('[Auth] Getting authentication flags...');
        const authFlags = await getAuthFlags(videoId);
        console.log('[Auth] Using flags:', authFlags);
        
        // Update job status to downloading
        analyzingJob.status = 'downloading';
        analyzingJob.speed = '';
        
        // STEP 3: Build yt-dlp command with detected format and auth
        const userAgent = getRandomUserAgent();  // Rotate User-Agent
        var command = `yt-dlp ${authFlags}`;
        
        // Add essential anti-detection flags
        command += ' --no-check-certificate';                    // Skip SSL verification issues
        command += ` --user-agent "${userAgent}"`;               // Rotating browser UA
        command += ' --add-header "Accept-Language:en-US,en;q=0.9"';  // Language header
        command += ' --add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"';  // Accept header
        
        // Add the auto-detected format (format 18 = pre-merged 360p MP4 with audio)
        command += ` -f "${formatString}"`;
        
        // Only add merge flag if format string contains "+" (video+audio merge needed)
        if (formatString.includes('+')) {
            command += ' --merge-output-format mp4';
        }
        
        // Add output template
        command += ` -o "${outputTemplate}"`;

        command += ` "https://www.youtube.com/watch?v=${videoId}"`;
        
        console.log('[Download] Final command:', command);
        console.log('[Anti-Detect] Using UA:', userAgent.substring(0, 50) + '...');
        
        // STEP 4: Execute download with retry logic and rate limiting
        const result = await downloadWithRetry(command, jobId, videoId, title, channelId, finalPath, res);
        
        if (!result.success && res && !res.headersSent) {
            res.status(500).json({ 
                error: 'Download failed', 
                details: result.error,
                message: 'Video may be private, restricted, or YouTube is blocking automated downloads'
            });
        } else if (res && !res.headersSent) {
            res.json({ success: true, jobId: jobId });
        }

    } catch (err) {
        console.error('[Download] ❌ EXCEPTION:', err.message);
        const job = activeDownloads.get(jobId);
        if (job) {
            job.status = 'error';
            job.error = err.message;
        }
        
        if (res && !res.headersSent) {
            res.status(500).json({ error: 'Download failed', details: err.message });
        }
        
        processDownloadQueue();
    }
}

// =============================================================================
// AUTHENTICATION API ENDPOINTS
// =============================================================================

// Test authentication methods and return the best one
app.get('/api/auth/test', async function(req, res) {
    const videoId = req.query.videoId || 'dQw4w9WgXcQ';
    
    console.log('[API] Testing authentication methods...');
    
    const results = {};
    
    for (const method of AUTH_CONFIG.authMethods) {
        try {
            const result = await testAuthMethod(method, videoId);
            results[method] = result;
        } catch (err) {
            results[method] = { success: false, error: err.message };
        }
    }
    
    // Detect available browsers
    results.availableBrowsers = [];
    const browsers = ['edge', 'chrome', 'firefox', 'brave'];
    for (const browser of browsers) {
        if (detectBestBrowser() === browser || 
            (detectBestBrowser() && detectBestBrowser().includes(browser))) {
            results.availableBrowsers.push(browser);
        }
    }
    
    // Check cookie file status
    results.cookieFileExists = checkCookieFile();
    
    res.json({
        status: 'Authentication test complete',
        bestMethod: Object.keys(results).find(key => 
            results[key] && results[key].success === true && key !== 'availableBrowsers' && key !== 'cookieFileExists'
        ) || 'none',
        methods: results,
        config: {
            downloadDelayMs: AUTH_CONFIG.downloadDelayMs,
            maxRetries: AUTH_CONFIG.maxRetries,
            hasApiKey: !!AUTH_CONFIG.youtubeApiKey,
            hasProxy: !!AUTH_CONFIG.proxyUrl
        }
    });
});

// Get current authentication status
app.get('/api/auth/status', function(req, res) {
    res.json({
        status: 'OK',
        authConfig: {
            ...AUTH_CONFIG,
            youtubeApiKey: AUTH_CONFIG.youtubeApiKey ? '[SET]' : '[NOT SET]',
            proxyUrl: AUTH_CONFIG.proxyUrl || '[NOT SET]',
            cookieFilePath: AUTH_CONFIG.cookieFilePath
        },
        lastDownloadTime: lastDownloadTime,
        timeSinceLastDownload: Date.now() - lastDownloadTime,
        nextDownloadAvailableAt: new Date(lastDownloadTime + AUTH_CONFIG.downloadDelayMs).toISOString(),
        detectedBrowser: detectBestBrowser(),
        cookieFileExists: checkCookieFile(),
        poTokenCached: cachedPoToken ? true : false
    });
});

// Get instructions for creating cookies.txt file
app.get('/api/auth/cookie-instructions', function(req, res) {
    res.json({
        status: 'Instructions',
        instructions: getCookieFileInstructions(),
        cookieFilePath: AUTH_CONFIG.cookieFilePath,
        cookieFileExists: checkCookieFile()
    });
});

// Upload cookie file directly
app.post('/api/auth/upload-cookies', function(req, res) {
    if (!req.body.cookies) {
        return res.status(400).json({ error: 'No cookies data provided' });
    }
    
    try {
        fs.writeFileSync(AUTH_CONFIG.cookieFilePath, req.body.cookies, 'utf8');
        
        console.log('[Auth] Cookie file uploaded successfully');
        
        res.json({
            success: true,
            message: 'Cookie file saved successfully',
            path: AUTH_CONFIG.cookieFilePath,
            size: req.body.cookies.length
        });
    } catch (err) {
        console.error('[Auth] Error saving cookie file:', err.message);
        res.status(500).json({ error: 'Failed to save cookie file: ' + err.message });
    }
});

// Set YouTube API key
app.post('/api/auth/set-api-key', function(req, res) {
    if (!req.body.apiKey) {
        return res.status(400).json({ error: 'No API key provided' });
    }
    
    AUTH_CONFIG.youtubeApiKey = req.body.apiKey;
    
    console.log('[Auth] YouTube API key set');
    
    res.json({
        success: true,
        message: 'YouTube API key configured successfully'
    });
});

// Set proxy URL
app.post('/api/auth/set-proxy', function(req, res) {
    if (!req.body.proxyUrl) {
        return res.status(400).json({ error: 'No proxy URL provided' });
    }
    
    AUTH_CONFIG.proxyUrl = req.body.proxyUrl;
    
    console.log('[Auth] Proxy set:', req.body.proxyUrl);
    
    res.json({
        success: true,
        message: 'Proxy configured successfully',
        proxyUrl: AUTH_CONFIG.proxyUrl
    });
});

// Update authentication configuration
app.post('/api/auth/config', function(req, res) {
    if (req.body.downloadDelayMs) {
        AUTH_CONFIG.downloadDelayMs = Math.max(1000, Math.min(60000, req.body.downloadDelayMs)); // 1-60 seconds
    }
    if (req.body.maxRetries) {
        AUTH_CONFIG.maxRetries = Math.max(1, Math.min(10, req.body.maxRetries)); // 1-10 retries
    }
    
    console.log('[Auth] Config updated:', AUTH_CONFIG);
    
    res.json({
        success: true,
        message: 'Configuration updated',
        config: AUTH_CONFIG
    });
});

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

// Serve the HTML frontend (with robust path resolution)
app.get('/', function(req, res) {
    console.log('\n[Root Route] Serving index.html...');
    console.log('[Root Route] __dirname:', __dirname);
    console.log('[Root Route] process.cwd():', process.cwd());
    
    const htmlPath = findIndexHtml();
    
    if (htmlPath && fs.existsSync(htmlPath)) {
        console.log('[Root Route] ✅ Sending file:', htmlPath);
        res.sendFile(htmlPath, function(err) {
            if (err) {
                console.error('[Root Route] Error sending file:', err.message);
                sendFallbackPage(res);
            } else {
                console.log('[Root Route] ✅ File sent successfully!');
            }
        });
    } else {
        console.error('[Root Route] ❌ index.html not found!');
        sendFallbackPage(res);
    }
});

// Fallback page when index.html is missing
function sendFallbackPage(res) {
    res.status(500).send('<!DOCTYPE html><html><head><title>YouTube Downloader - Error</title>' +
        '<style>body{font-family:Arial,sans-serif;max-width:800px;margin:50px auto;padding:20px;}' +
        '.error{color:#d32f2f;background:#ffebee;padding:15px;border-radius:8px;margin:20px 0;}' +
        '.info{background:#e3f2fd;padding:15px;border-radius:8px;margin:20px 0;}' +
        'code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:14px;}</style></head>' +
        '<body><h1>⚠️ YouTube Downloader - Frontend Not Found</h1>' +
        '<div class="error"><strong>Error:</strong> The frontend file (index.html) could not be found.</div>' +
        '<div class="info"><h3>🔧 How to Fix:</h3>' +
        '<p>Make sure the folder structure is:</p>' +
        '<pre>youtube-download/' +
        '├── server/' +
        '│   ├── server.js  ← Server running here' +
        '│   └── package.json' +
        '├── public/' +
        '│   └── index.html  ← FRONTEND FILE MISSING!' +
        '└── cookies.txt</pre>' +
        '<h3>Quick Fixes:</h3>' +
        '<ol><li>Check that <code>public/index.html</code> exists</li>' +
        '<li>Try copying index.html to the server folder</li>' +
        '<li>Check file permissions</li></ol>' +
        '<p><strong>Debug Info:</strong></p>' +
        '<ul><li>__dirname: <code>' + __dirname + '</code></li>' +
        '<li>Platform: <code>' + process.platform + '</code></li>' +
        '<li>Node version: <code>' + process.version + '</code></li></ul>' +
        '</div></body></html>');
}

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
    
    // Auto-generate cookies.txt on startup if needed
    initAutoCookieGeneration();
    
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
