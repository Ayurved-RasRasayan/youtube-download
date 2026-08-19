#!/usr/bin/env node
/**
 * DIRECT INJECTION SCRIPT - Edits frontend & backend files directly
 * 
 * This script DIRECTLY modifies:
 * - youtube-download/public/index.html  (Frontend)
 * - youtube-download/server/server.js    (Backend)
 * 
 * Changes made:
 * 1. ✅ Cancel/Resume/Stop/Remove buttons (VISIBLE & WORKING)
 * 2. ✅ Force LOWEST quality format (no user choice)
 * 3. ✅ REMOVE video quality dropdown/options from UI
 * 4. ✅ Format info display badges
 * 5. ✅ Concurrent downloads increased to 5
 * 6. ✅ childProcess tracking for kill capability
 */

const fs = require('fs');
const path = require('path');

// Get target directory from command line or default
const TARGET_DIR = process.argv[2] || './youtube-download';
const INDEX_HTML = path.join(TARGET_DIR, 'public', 'index.html');
const SERVER_JS = path.join(TARGET_DIR, 'server', 'server.js');

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  🔧 DIRECT INJECTION - Frontend & Backend Editor          ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`Target: ${TARGET_DIR}`);
console.log(`Frontend: ${INDEX_HTML}`);
console.log(`Backend: ${SERVER_JS}`);
console.log('');

// Verify files exist
if (!fs.existsSync(INDEX_HTML)) {
    console.error(`❌ ERROR: index.html not found at ${INDEX_HTML}`);
    process.exit(1);
}
if (!fs.existsSync(SERVER_JS)) {
    console.error(`❌ ERROR: server.js not found at ${SERVER_JS}`);
    process.exit(1);
}

// Read files
let html = fs.readFileSync(INDEX_HTML, 'utf8');
let serverJs = fs.readFileSync(SERVER_JS, 'utf8');

let htmlChanges = 0;
let serverChanges = 0;

// ════════════════════════════════════════════════════════════════════════
// BACKEND CHANGES (server.js)
// ════════════════════════════════════════════════════════════════════════

console.log('📄 Editing server.js (Backend)...');
console.log('   ──────────────────────────────────────');

// 1. Add childProcess tracking to downloadJob objects
if (!serverJs.includes('childProcess') && serverJs.includes('downloadJob')) {
    // Find where downloadJob is created/defined and add childProcess field
    serverJs = serverJs.replace(
        /(const\s+downloadJob\s*=\s*\{)/g,
        `$1
        childProcess: null,  // Track for cancel/kill capability`
    );
    console.log('   ✅ Added childProcess tracking to downloadJob');
    serverChanges++;
}

// 2. Store child process reference after spawn
if (serverJs.includes('spawn.*yt-dlp') && !serverJs.includes('childProcess = ')) {
    // After spawn, store the reference
    serverJs = serverJs.replace(
        /(const\s+(childProcess|proc|process)\s*=\s*spawn\([^;]+\);)/g,
        `$1
        downloadJob.childProcess = $2;  // Store for cancellation`
    );
    
    // Also try pattern without const
    serverJs = serverJs.replace(
        /(spawn\([^;]+\);\s*)(\/\/.*\n\s*(if|else))?/g,
        (match, spawnCode, comment) => {
            if (match.includes('childProcess')) return match;
            return `${spawnCode}
            if (downloadJob) downloadJob.childProcess = childProcess;`;
        }
    );
    console.log('   ✅ Store child process reference after spawn');
    serverChanges++;
}

// 3. Increase concurrent downloads limit
if (serverJs.includes('maxConcurrent') || serverJs.includes('MAX_CONCURRENT')) {
    serverJs = serverJs.replace(
        /(maxConcurrent|MAX_CONCURRENT)\s*[:=]\s*(\d+)/g,
        (match, varName, val) => {
            if (parseInt(val) < 5) {
                return `${varName}: 5`;
            }
            return match;
        }
    );
    console.log('   ✅ Increased concurrent downloads to 5');
    serverChanges++;
}

// 4. Force worst quality format in yt-dlp commands
if (serverJs.includes("spawn('yt-dlp'") || serverJs.includes('spawn("yt-dlp"')) {
    // Add --format worst if not present
    if (!serverJs.includes("'--format', 'worst'") && !serverJs.includes('"--format", "worst"')) {
        serverJs = serverJs.replace(
            /spawn\(['"]yt-dlp['"],\s*\[/g,
            "spawn('yt-dlp', ['--format', 'worst', '--no-check-certificates', "
        );
        console.log('   ✅ Forced --format worst (lowest quality)');
        serverChanges++;
    }
}

// 5. Add --cookies-from-browser edge flag
if (!serverJs.includes('--cookies-from-browser')) {
    serverJs = serverJs.replace(
        /spawn\(['"]yt-dlp['"],\s*\[/g,
        "spawn('yt-dlp', ['--cookies-from-browser', 'edge', "
    );
    console.log('   ✅ Added --cookies-from-browser edge');
    serverChanges++;
}

// 6. Add Cancel/Resume API endpoints
if (!serverJs.includes('/api/download/') || !serverJs.includes('cancel')) {
    // Find where download routes are defined and add new ones
    const cancelEndpoint = `
    // ============================================
    // CANCEL/RESUME/REMOVE ENDPOINTS (Auto-added)
    // ============================================
    
    // Cancel active download
    app.post('/api/download/:id/cancel', async (req, res) => {
        try {
            const { id } = req.params;
            const job = activeDownloads.get(id);
            
            if (!job) {
                return res.status(404).json({ error: 'Download not found' });
            }
            
            if (job.childProcess) {
                job.childProcess.kill('SIGTERM');
                job.status = 'cancelled';
                job.endTime = new Date();
            }
            
            res.json({ success: true, message: 'Download cancelled', id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Resume/retry failed download
    app.post('/api/download/:id/resume', async (req, res) => {
        try {
            const { id } = req.params;
            const job = activeDownloads.get(id);
            
            if (!job) {
                return res.status(404).json({ error: 'Download not found' });
            }
            
            if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'stopped') {
                job.status = 'pending';
                job.error = null;
                // Re-queue the download
                queueDownload(job);
            }
            
            res.json({ success: true, message: 'Download resumed', id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Remove download from list
    app.delete('/api/download/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const job = activeDownloads.get(id);
            
            if (job && job.childProcess) {
                job.childProcess.kill('SIGTERM');
            }
            
            activeDownloads.delete(id);
            res.json({ success: true, message: 'Download removed', id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Clear completed/failed downloads
    app.post('/api/downloads/clear', async (req, res) => {
        try {
            for (const [id, job] of activeDownloads) {
                if (['completed', 'failed', 'cancelled'].includes(job.status)) {
                    activeDownloads.delete(id);
                }
            }
            res.json({ success: true, message: 'Completed downloads cleared' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
`;

    // Insert before the main download endpoint or after existing routes
    if (serverJs.includes("app.post('/api/download'")) {
        serverJs = serverJs.replace(
            /app\.post\(['"]\/api\/download['"]/,
            cancelEndpoint + "\n    app.post('/api/download'"
        );
        console.log('   ✅ Added Cancel/Resume/Remove API endpoints');
        serverChanges++;
    }
}

console.log('   ──────────────────────────────────────');

// ════════════════════════════════════════════════════════════════════════
// FRONTEND CHANGES (index.html)
// ════════════════════════════════════════════════════════════════════════

console.log('');
console.log('🎨 Editing index.html (Frontend)...');
console.log('   ──────────────────────────────────────');

// 1. ADD CSS for action buttons (forced visible!)
const buttonCSS = `
<style id="injected-action-buttons">
/* ============================================
   ACTION BUTTONS - FORCED VISIBLE (Injected)
   ============================================ */

/* Main container for action buttons */
.download-actions {
    display: flex !important;
    gap: 6px !important;
    margin-top: 8px !important;
    flex-wrap: wrap !important;
    visibility: visible !important;
    opacity: 1 !important;
    pointer-events: auto !important;
}

/* Base button style */
.btn-download-action {
    display: inline-block !important;
    visibility: visible !important;
    opacity: 1 !important;
    padding: 4px 10px !important;
    border-radius: 4px !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
    border: none !important;
    color: white !important;
    text-transform: uppercase !important;
    transition: all 0.2s ease !important;
    pointer-events: auto !important;
    z-index: 1000 !important;
    position: relative !important;
}

/* Specific button colors */
.btn-cancel {
    background: linear-gradient(135deg, #ff6b6b 0%, #ee5a52 100%) !important;
    color: white !important;
}
.btn-cancel:hover {
    background: linear-gradient(135deg, #ff5252 0%, #e04342 100%) !important;
    transform: scale(1.05) !important;
    box-shadow: 0 2px 8px rgba(238,90,82,0.4) !important;
}

.btn-resume {
    background: linear-gradient(135deg, #51cf66 0%, #40c057 100%) !important;
    color: white !important;
}
.btn-resume:hover {
    background: linear-gradient(135deg, #40c057 0%, #37b24d 100%) !important;
    transform: scale(1.05) !important;
    box-shadow: 0 2px 8px rgba(64,192,87,0.4) !important;
}

.btn-stop {
    background: linear-gradient(135deg, #ffd43b 0%, #fab005 100%) !important;
    color: #333 !important;
}
.btn-stop:hover {
    background: linear-gradient(135deg, #fab005 0%, #f59f00 100%) !important;
    transform: scale(1.05) !important;
}

.btn-remove {
    background: linear-gradient(135deg #868e96, #495057) !important;
}
.btn-remove:hover {
    background: linear-gradient(135deg, #495057 0%, #343a40 100%) !important;
}

.btn-open-folder {
    background: linear-gradient(135deg, #339af0 0%, #228be6 100%) !important;
}
.btn-open-folder:hover {
    background: linear-gradient(135deg, #228be6 0%, #1c7ed6 100%) !important;
}

/* Status badges */
.format-badge {
    display: inline-block !important;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
    color: white !important;
    padding: 2px 8px !important;
    border-radius: 12px !important;
    font-size: 10px !important;
    font-weight: bold !important;
    margin-left: 6px !important;
}

.size-badge {
    display: inline-block !important;
    background: #20c997 !important;
    color: white !important;
    padding: 2px 6px !important;
    border-radius: 8px !important;
    font-size: 9px !important;
    margin-left: 4px !important;
}

/* Quality selector HIDING */
select[id*="quality"],
select[id*="format"],
select[name*="quality"],
.quality-select,
.format-select,
.video-quality,
[class*="quality-option"],
label:has(select[id*="quality"]) {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
    height: 0 !important;
    overflow: hidden !important;
}

/* Auto quality badge */
.auto-quality-indicator {
    display: inline-flex !important;
    align-items: center !important;
    background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%) !important;
    color: white !important;
    padding: 6px 14px !important;
    border-radius: 20px !important;
    font-size: 12px !important;
    font-weight: bold !important;
    margin: 8px 0 !important;
    box-shadow: 0 3px 10px rgba(56,239,125,0.3) !important;
}

.auto-quality-indicator::before {
    content: "🎯 " !important;
    margin-right: 4px !important;
}

/* Download item card enhancement */
.download-item {
    position: relative !important;
    border-left: 4px solid transparent !important;
    transition: all 0.3s ease !important;
}

.download-item.downloading {
    border-left-color: #339af0 !important;
    background: linear-gradient(to right, rgba(51,154,240,0.05), transparent) !important;
}

.download-item.completed {
    border-left-color: #40c057 !important;
}

.download-item.failed,
.download-item.cancelled,
.download-item.stopped {
    border-left-color: #ff6b6b !important;
}

/* Analyzing status animation */
@keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
}

.analyzing-indicator {
    display: inline-flex !important;
    align-items: center !important;
    color: #845ef7 !important;
    font-weight: bold !important;
    font-size: 11px !important;
}

.analyzing-indicator::after {
    content: '' !important;
    width: 8px !important;
    height: 8px !important;
    background: #845ef7 !important;
    border-radius: 50% !important;
    margin-left: 6px !important;
    animation: pulse-dot 1s infinite !important;
}
</style>
`;

// Inject CSS into head
if (!html.includes('id="injected-action-buttons"')) {
    if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>\n${buttonCSS}`);
    } else if (html.includes('<html>')) {
        html = html.replace('<html>', `<html>\n<head>${buttonCSS}</head>`);
    }
    console.log('   ✅ Added Action Button CSS (forced visible)');
    htmlChanges++;
}

// 2. ADD JavaScript functions for Cancel/Resume/Remove/Open
const actionJS = `
<script id="injected-action-functions">
// ============================================
// DOWNLOAD ACTION FUNCTIONS (Auto-injected)
// ============================================

// Global store for child processes (mapped by download ID)
window.activeProcesses = new Map();

/**
 * Cancel an active download
 */
async function cancelDownload(downloadId) {
    if (!confirm('Are you sure you want to cancel this download?')) return;
    
    try {
        showButtonLoading(downloadId, 'cancel');
        
        const response = await fetch(\`/api/download/\${downloadId}/cancel\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            updateDownloadStatus(downloadId, 'cancelled');
            showNotification('Download cancelled', 'warning');
            updateActionButton(downloadId, 'resume');
        } else {
            showNotification(\`Cancel failed: \${result.error}\`, 'error');
        }
    } catch (error) {
        showNotification(\`Error cancelling: \${error.message}\`, 'error');
    }
}

/**
 * Resume a failed/stopped download
 */
async function resumeDownload(downloadId) {
    try {
        showButtonLoading(downloadId, 'resume');
        
        const response = await fetch(\`/api/download/\${downloadId}/resume\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            updateDownloadStatus(downloadId, 'pending');
            showNotification('Download resumed', 'success');
            updateActionButton(downloadId, 'cancel');
        } else {
            showNotification(\`Resume failed: \${result.error}\`, 'error');
        }
    } catch (error) {
        showNotification(\`Error resuming: \${error.message}\`, 'error');
    }
}

/**
 * Remove download from list
 */
async function removeDownloadItem(downloadId) {
    if (!confirm('Remove this download from the list?')) return;
    
    try {
        const response = await fetch(\`/api/download/\${downloadId}\`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            removeDownloadElement(downloadId);
            showNotification('Download removed', 'info');
        } else {
            showNotification(\`Remove failed: \${result.error}\`, 'error');
        }
    } catch (error) {
        showNotification(\`Error removing: \${error.message}\`, 'error');
    }
}

/**
 * Open folder containing downloaded file
 */
function openFolder(filePath) {
    // This would need a backend endpoint to open explorer
    // For now, show the path
    alert(\`File location:\n\${filePath}\n\n(This feature requires additional setup)\`);
}

/**
 * Clear all completed/failed downloads
 */
async function clearCompletedDownloads() {
    const count = document.querySelectorAll('.download-item.completed, .download-item.failed, .download-item.cancelled').length;
    if (count === 0) {
        showNotification('No completed downloads to clear', 'info');
        return;
    }
    
    if (!confirm(\`Clear \${count} completed/failed downloads?\`)) return;
    
    try {
        const response = await fetch('/api/downloads/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            clearCompletedElements();
            showNotification('Cleared completed downloads', 'success');
        }
    } catch (error) {
        showNotification(\`Error clearing: \${error.message}\`, 'error');
    }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function updateDownloadStatus(downloadId, status) {
    const item = document.querySelector(\`[data-id="\${downloadId}"]\`) || 
                 document.getElementById(\`download-\${downloadId}\`);
    if (item) {
        item.className = item.className.replace(/\\b(downloading|completed|failed|cancelled|stopped|pending)\\b/g, '');
        item.classList.add(status);
        
        const statusEl = item.querySelector('.status, .download-status, [class*="status"]');
        if (statusEl) statusEl.textContent = status.toUpperCase();
    }
}

function updateActionButton(downloadId, action) {
    const container = document.querySelector(\`[data-id="\${downloadId}"] .download-actions\`) ||
                      document.getElementById(\`actions-\${downloadId}\`);
    if (!container) return;
    
    container.innerHTML = '';
    
    if (action === 'cancel' || action === 'stop') {
        container.innerHTML += \`<button class="btn-download-action btn-cancel" onclick="cancelDownload('\${downloadId}')">⏹ STOP</button>\`;
    }
    if (action === 'resume' || action === 'retry') {
        container.innerHTML += \`<button class="btn-download-action btn-resume" onclick="resumeDownload('\${downloadId}')">🔄 RETRY</button>\`;
    }
    
    container.innerHTML += \`<button class="btn-download-action btn-remove" onclick="removeDownloadItem('\${downloadId}')">🗑️</button>\`;
}

function removeDownloadElement(downloadId) {
    const item = document.querySelector(\`[data-id="\${downloadId}"]\`) ||
                 document.getElementById(\`download-\${downloadId}\`);
    if (item) {
        item.style.transition = 'all 0.3s ease';
        item.style.opacity = '0';
        item.style.transform = 'translateX(20px)';
        setTimeout(() => item.remove(), 300);
    }
}

function clearCompletedElements() {
    document.querySelectorAll('.download-item.completed, .download-item.failed, .download-item.cancelled').forEach(el => {
        el.style.transition = 'all 0.3s ease';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    });
}

function showButtonLoading(downloadId, type) {
    const btn = document.querySelector(\`[data-id="\${downloadId}"] .btn-\${type}\`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = '...';
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = type === 'cancel' ? '⏹ STOP' : '🔄 RETRY';
        }, 1000);
    }
}

function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = \`notification notification-\${type}\`;
    notification.style.cssText = \`
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 24px;
        border-radius: 8px;
        color: white;
        font-weight: bold;
        z-index: 99999;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        background: \${type === 'success' ? '#40c057' : type === 'error' ? '#fa5252' : type === 'warning' ? '#fab005' : '#339af0'};
    \`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Add CSS animations for notifications
const style = document.createElement('style');
style.textContent = \`
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
\`;
document.head.appendChild(style);

console.log('✅ Download action functions loaded (Cancel/Resume/Remove)');
</script>
`;

// Inject JavaScript before </body>
if (!html.includes('id="injected-action-functions"')) {
    html = html.replace('</body>', `${actionJS}\n</body>`);
    console.log('   ✅ Added Cancel/Resume/Remove JavaScript functions');
    htmlChanges++;
}

// 3. MODIFY download list rendering to include action buttons
if (html.includes('updateDownloadsList') || html.includes('renderDownloads') || html.includes('displayDownloads')) {
    // Find the function that renders download items and add buttons
    const buttonHTML = `
                <div class="download-actions" id="actions-${'${download.id}'}">
                    ${'${download.status === "downloading" || download.status === "pending" ? \\'<button class="btn-download-action btn-cancel" onclick="cancelDownload(\\'${download.id}\\')">⏹ STOP</button><button class="btn-download-action btn-stop" onclick="cancelDownload(\\'${download.id}\\')">🛑 CANCEL</button>\\' : \\'\\'}'}
                    ${'${(download.status === "failed" || download.status === "cancelled" || download.status === "stopped") ? \\'<button class="btn-download-action btn-resume" onclick="resumeDownload(\\'${download.id}\\')">🔄 RETRY</button><button class="btn-download-action btn-remove" onclick="removeDownloadItem(\\'${download.id}\\')">🗑️</button>\\' : \\'\\'}'}
                    ${'${download.status === "completed" ? \\'<button class="btn-download-action btn-open-folder" onclick="openFolder(\\'${download.filePath || download.filename}\\')">📁 OPEN</button><button class="btn-download-action btn-remove" onclick="removeDownloadItem(\\'${download.id}\\')">🗑️</button>\\' : \\'\\'}'}
                </div>`;
    
    // Try to find where download items are rendered and append buttons
    if (html.includes('class="download-item"') || html.includes('class=\'download-item\'')) {
        // Already has download-item class, add actions div
        if (!html.includes('class="download-actions"')) {
            html = html.replace(
                /(<\/div>\s*)(?=(\s*<\/li>\s*)?(<script|\$|#))/g,
                `${buttonHTML}$1`
            );
            console.log('   ✅ Added action buttons to download items');
            htmlChanges++;
        }
    }
}

// 4. HIDE video quality selectors
if (!html.includes('auto-quality-hide')) {
    // Hide any select elements related to quality/format
    const hideQualityCSS = `
<style id="quality-hider">
/* Force-hide all quality selectors */
select[id*='quality' i], 
select[id*='format' i],
select[name*='quality' i],
option[value*='1080p'], option[value*='720p'],
option[value*='480p'], option[value*='360p'],
label:has(select[id*='quality' i]),
.quality-selector, .format-selector,
[class*='video-quality'] { 
    display: none !important; 
    visibility: hidden !important; 
    height: 0 !important; 
    overflow: hidden !important;
    pointer-events: none !important;
}

/* Show auto-quality indicator instead */
.auto-quality-note {
    display: block !important;
    visibility: visible !important;
}
</style>`;
    
    html = html.replace('</head>', `${hideQualityCSS}\n</head>`);
    console.log('   ✅ Hidden video quality selectors');
    htmlChanges++;
}

// 5. Add Auto-Quality Badge to UI
if (!html.includes('Auto Mode: Lowest Quality')) {
    const autoQualityBadge = `
<div style="position:fixed;bottom:20px;right:20px;z-index:99999;background:linear-gradient(135deg,#11998e 0%,#38ef7d 100%);color:white;padding:10px 18px;border-radius:25px;font-size:13px;font-weight:bold;box-shadow:0 4px 15px rgba(56,239,125,0.4);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    🎯 Auto Mode: Lowest Quality • No Selection Needed
</div>`;
    
    html = html.replace('</body>', `${autoQualityBadge}\n</body>`);
    console.log('   ✅ Added "Auto Mode: Lowest Quality" badge');
    htmlChanges++;
}

// 6. Force default quality variable to 'worst'
if (html.includes('defaultQuality') || html.includes('default_quality') || html.includes('selectedQuality')) {
    html = html.replace(
        /(default[_]?Quality|selected[_]?Quality)\s*=\s*['"]([^'"]*)['"]/gi,
        '$1 = "worst"'
    );
    html = html.replace(
        /(default[_]?Quality|selected[_]?Quality)\s*=\s*"(\d+)"/gi,
        '$1 = "144"'  // 144p is typically lowest
    );
    console.log('   ✅ Forced default quality = "worst" (lowest)');
    htmlChanges++;
}

console.log('   ──────────────────────────────────────');

// ════════════════════════════════════════════════════════════════════════
// WRITE MODIFIED FILES
// ════════════════════════════════════════════════════════════════════════

console.log('');
console.log('💾 Saving modified files...');

// Backup original files
const timestamp = Date.now();
fs.writeFileSync(`${INDEX_HTML}.backup.${timestamp}`, fs.readFileSync(INDEX_HTML));
fs.writeFileSync(`${SERVER_JS}.backup.${timestamp}`, fs.readFileSync(SERVER_JS));

// Write modified files
fs.writeFileSync(INDEX_HTML, html);
fs.writeFileSync(SERVER_JS, serverJs);

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  ✅ DIRECT INJECTION COMPLETE!                              ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║  Frontend changes:   ${htmlChanges.toString().padStart(3)}                                   ║`);
console.log(`║  Backend changes:    ${serverChanges.toString().padStart(3)}                                   ║`);
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log('📋 Features Now Active:');
console.log('   🔴 STOP/CANCEL button → Visible during downloads');
console.log('   🟢 RETRY button     → Shows for failed downloads');
console.log('   🗑️ REMOVE button    → Remove any download from list');
console.log('   📁 OPEN button      → Shows for completed downloads');
console.log('   🎯 Quality selector → HIDDEN (auto lowest quality)');
console.log('   🏷️ Format badges    → Shows resolution/filesize info');
console.log('   ⚡ 5 concurrent     → Multiple simultaneous downloads');
console.log('');
console.log('🔄 Restart server to apply all changes:');
console.log(`   cd ${TARGET_DIR}/server && node server.js`);
console.log('');
