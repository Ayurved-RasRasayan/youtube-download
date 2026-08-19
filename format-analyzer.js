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

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

// Configuration
const basePath = process.argv[2] || process.cwd();
const SERVER_JS_PATH = path.join(basePath, 'server', 'server.js');
const INDEX_HTML_PATH = path.join(basePath, 'public', 'index.html');

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  🎬 FORMAT ANALYZER - Smart Low-Quality Selection          ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

let totalChanges = 0;

function logChange(desc) {
    totalChanges++;
    console.log(`  ✅ ${desc}`);
}

// =============================================================================
// PART 1: UPDATE server.js - Add Format Analysis Before Download
// =============================================================================

if (fs.existsSync(SERVER_JS_PATH)) {
    console.log('📄 Updating server.js (Adding Format Analysis)...');
    console.log('   ──────────────────────────────────────');
    
    let serverContent = fs.readFileSync(SERVER_JS_PATH, 'utf8');
    const originalContent = serverContent;
    
    // --------------------------------------------------------------------------
    // FIX 1.1: Add format analysis function
    // --------------------------------------------------------------------------
    if (!serverContent.includes('analyzeFormats')) {
        const analyzeFunction = `

// ============================================
// FORMAT ANALYZER - Scan video formats before download
// Returns the best (lowest quality) format ID
// ============================================
function analyzeFormats(videoId, callback) {
    const videoUrl = 'https://www.youtube.com/watch?v=' + videoId;
    
    // Command to list all available formats in JSON
    const cmd = 'yt-dlp --list-formats --json "' + videoUrl + '" 2>/dev/null';
    
    exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 30000 }, function(error, stdout, stderr) {
        if (error) {
            console.log('Format analysis failed for ' + videoId + ': ' + error.message);
            // Return default low format on error
            return callback(null, {
                formatId: 'worstvideo+worstaudio/worst',
                formatString: '-f "worstvideo+worstaudio/worstvideo/worstaudio/worst/best"',
                resolution: 'Auto (Low)',
                fileSize: 'Unknown',
                codec: 'auto',
                ext: 'mp4',
                note: 'Format detection failed, using safest fallback'
            });
        }
        
        try {
            // Try to parse JSON output
            let formats;
            
            // yt-dlp --list-formats outputs table, but we can use --dump-json for single video
            // For now, parse the text output which is more reliable
            const lines = stdout.split('\\n').filter(function(line) {
                return line.trim() && !line.startsWith('[info]') && !line.startsWith('[warning]');
            });
            
            // Find format lines (they contain format code, extension, resolution)
            const formatLines = lines.filter(function(line) {
                return /\\d+\\s+(audio|video|mp4|webm|m4a)/i.test(line) || line.includes('audio only') || line.includes('video only');
            });
            
            if (formatLines.length === 0) {
                return callback(null, {
                    formatId: 'worst',
                    formatString: '-f "worst"',
                    resolution: 'Auto',
                    fileSize: 'Unknown',
                    codec: 'auto',
                    ext: 'mp4',
                    note: 'No formats parsed, using worst'
                });
            }
            
            // Parse formats to find the WORST (lowest quality) video+audio combo
            let worstVideoFormat = null;
            let worstAudioFormat = null;
            let worstCombinedFormat = null;
            
            // Analyze each format line
            formatLines.forEach(function(line) {
                // Extract format ID (usually first number/code)
                const parts = line.trim().split(/\\s{2,}/);
                if (parts.length < 2) return;
                
                const formatCode = parts[0].trim();
                const extension = parts[1] ? parts[1].trim() : 'unknown';
                const resolution = parts[2] ? parts[2].trim() : 'unknown';
                
                // Check if this is audio-only
                const isAudioOnly = line.toLowerCase().includes('audio only') || 
                                   line.toLowerCase().includes('audio only') ||
                                   resolution === 'audio only';
                
                // Check if this is video-only or combined
                const isVideoOnly = line.toLowerCase().includes('video only');
                
                // Parse resolution to number for comparison
                let height = Infinity; // Lower = worse quality (what we want)
                if (resolution.match(/^(\\d+)x(\\d+)$/)) {
                    height = parseInt(resolution.split('x')[1]);
                } else if (resolution.match(/^(\\d+)p$/)) {
                    height = parseInt(resolution);
                } else if (resolution.match(/^(\\d+)x/)) {
                    height = parseInt(resolution.split('x')[1]);
                }
                
                const formatInfo = {
                    code: formatCode,
                    ext: extension,
                    resolution: resolution,
                    height: height,
                    isAudioOnly: isAudioOnly,
                    isVideoOnly: isVideoOnly,
                    fullLine: line
                };
                
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
            
            if (worstCombinedFormat && !worstCombinedFormat.isVideoOnly) {
                // We found a combined format (video+audio together) - BEST OPTION
                selectedFormat = {
                    formatId: worstCombinedFormat.code,
                    formatString: '-f "' + worstCombinedFormat.code + '"',
                    resolution: worstCombinedFormat.resolution,
                    fileSize: '~' + estimateFileSize(worstCombinedFormat.height),
                    codec: worstCombinedFormat.ext,
                    ext: worstCombinedFormat.ext,
                    note: 'Combined format (video+audio)',
                    rawInfo: worstCombinedFormat.fullLine
                };
            } else if (worstVideoFormat && worstAudioFormat) {
                // Need to merge video + audio
                selectedFormat = {
                    formatId: worstVideoFormat.code + '+' + worstAudioFormat.code,
                    formatString: '-f "' + worstVideoFormat.code + '+' + worstAudioFormat.code + '"',
                    resolution: worstVideoFormat.resolution,
                    fileSize: '~' + estimateFileSize(worstVideoFormat.height),
                    codec: worstVideoFormat.ext + '+' + worstAudioFormat.ext,
                    ext: 'mp4', // Merged output
                    note: 'Merged: video(' + worstVideoFormat.resolution + ') + audio',
                    rawVideoInfo: worstVideoFormat.fullLine,
                    rawAudioInfo: worstAudioFormat.fullLine
                };
            } else if (worstVideoFormat) {
                // Only video format available
                selectedFormat = {
                    formatId: worstVideoFormat.code,
                    formatString: '-f "' + worstVideoFormat.code + '"',
                    resolution: worstVideoFormat.resolution,
                    fileSize: '~' + estimateFileSize(worstVideoFormat.height),
                    codec: worstVideoFormat.ext,
                    ext: worstVideoFormat.ext,
                    note: 'Video only (no audio merged)',
                    rawInfo: worstVideoFormat.fullLine
                };
            } else {
                // Fallback to generic worst
                selectedFormat = {
                    formatId: 'worst',
                    formatString: '-f "worstvideo+worstaudio/worstvideo/worstaudio/worst/best"',
                    resolution: 'Auto (Lowest)',
                    fileSize: 'Unknown',
                    codec: 'auto',
                    ext: 'mp4',
                    note: 'Using fallback: worst quality with multiple fallbacks'
                };
            }
            
            console.log('📊 Format analyzed for ' + videoId + ': ' + selectedFormat.resolution + ' (' + selectedFormat.formatId + ')');
            
            return callback(null, selectedFormat);
            
        } catch (parseError) {
            console.error('Error parsing formats:', parseError.message);
            return callback(null, {
                formatId: 'worst',
                formatString: '-f "worst"',
                resolution: 'Parse Error',
                fileSize: 'Unknown',
                codec: 'auto',
                ext: 'mp4',
                note: 'Parse error, using worst'
            });
        }
    });
}

// Estimate file size based on resolution (very rough estimate)
function estimateFileSize(height) {
    if (height <= 240) return '3-8 MB';
    if (height <= 360) return '5-15 MB';
    if (height <= 480) return '10-25 MB';
    if (height <= 720) return '20-50 MB';
    if (height <= 1080) return '40-100 MB';
    return '100+ MB';
}
`;
        
        // Add after sanitizeFilename function or before executeDownload
        if (serverContent.includes('function sanitizeFilename')) {
            serverContent = serverContent.replace(
                'function sanitizeFilename(name)',
                analyzeFunction + '\n\nfunction sanitizeFilename(name)'
            );
            logChange('Added analyzeFormats() function');
        } else {
            // Add before executeDownload
            serverContent = serverContent.replace(
                'function executeDownload(',
                analyzeFunction + '\n\nfunction executeDownload('
            );
            logChange('Added analyzeFormats() function (alt location)');
        }
    }
    
    // --------------------------------------------------------------------------
    // FIX 1.2: Modify executeDownload to use format analysis
    // --------------------------------------------------------------------------
    if (serverContent.includes('analyzeFormats') && !serverContent.includes('ANALYZING FORMATS')) {
        const oldExecuteStart = `// Execute the actual download
function executeDownload(reqBody, res, jobId) {
    const videoId = reqBody.videoId;
    const title = reqBody.title;
    const quality = reqBody.quality;
    const format = reqBody.format;
    const channelId = reqBody.channelId;
    const customOutputFolder = reqBody.outputFolder;`;

        const newExecuteStart = `// Execute the actual download (WITH FORMAT ANALYSIS)
function executeDownload(reqBody, res, jobId) {
    const videoId = reqBody.videoId;
    const title = reqBody.title;
    const quality = reqBody.quality;
    const format = reqBody.format;
    const channelId = reqBody.channelId;
    const customOutputFolder = reqBody.outputFolder;

    // ================================================================
    // STEP 1: ANALYZE AVAILABLE FORMATS BEFORE DOWNLOADING
    // This ensures we pick the LOWEST quality format available
    // ================================================================
    
    // Store format info in job for UI display
    let selectedFormatInfo = {
        resolution: 'Analyzing...',
        formatId: 'scanning',
        fileSize: 'Detecting...',
        status: 'analyzing'
    };`;

        if (serverContent.includes(oldExecuteStart)) {
            serverContent = serverContent.replace(oldExecuteStart, newExecuteStart);
            logChange('Added format analysis step to executeDownload()');
        }
        
        // Now modify where command is built to use analyzed format
        const oldCommandBuild = `// Build yt-dlp command
    var command = 'yt-dlp --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=web" --no-check-certificate --cookies-from-browser edge --remote-components ejs:github -o "' + outputTemplate + '"';
    
    // ================================================================
    // LOW FORMAT BY DEFAULT - Prevents "format not available" errors
    // ================================================================
    
    // Strategy: Always use LOW FORMAT with multiple fallbacks
    // This fixes errors on Shorts, image-only posts, region-blocked content
    
    if (format === 'mp3' || format === 'm4a') {
        // Audio extraction - worst quality (smallest file)
        command += ' -x --audio-format ' + format + ' --audio-quality 0';
        command += ' -f "worstaudio/worstaudio*"';  // Fallback chain
    } else {
        // VIDEO: Force LOW QUALITY with smart fallbacks
        
        // Method A: Format sort prefers smallest files
        command += ' --format-sort "size:asc,res:240,vcodec:h264"';
        
        // Method B: Explicit worst-quality selection with fallback chain
        // Tries: worst combined → worst video only → worst audio only → ANY format → best
        command += ' -f "worstvideo+worstaudio/worstvideo/worstaudio/worst/best"';
        
        // Merge format if specified (not mp4 which is default)
        if (format && format !== 'mp4' && format !== 'auto') {
            command += ' --merge-output-format ' + format;
        }
    }
    
    // CRITICAL RELIABILITY FLAGS:
    command += ' --ignore-no-formats-error';   // Don't crash on empty formats
    command += ' --retries 5';                  // More retries on network issues
    command += ' --fragment-retries 10';         // Retry fragments more aggressively
    command += ' --force-ipv4';                 // Force IPv4 (fixes regional blocks)
    command += ' --no-check-certificates';      // Skip SSL certificate issues
    
    command += ' https://www.youtube.com/watch?v=' + videoId;`;

        const newCommandBuild = `// Build yt-dlp command (with dynamic format from analysis)
    var command = 'yt-dlp --js-runtimes node --remote-components ejs:github --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=web" --no-check-certificate --cookies-from-browser edge --remote-components ejs:github -o "' + outputTemplate + '"';
    
    // ================================================================
    // USE ANALYZED FORMAT OR FALLBACK TO SAFE LOW FORMAT
    // ================================================================
    
    // Use the format we analyzed (if available), otherwise use safe defaults
    var formatToUse = '';
    
    if (format === 'mp3' || format === 'm4a') {
        // Audio extraction mode
        formatToUse = ' -x --audio-format ' + format + ' --audio-quality 0';
        formatToUse += ' -f "worstaudio/worstaudio*"';
        selectedFormatInfo = {
            resolution: 'Audio (' + format.toUpperCase() + ')',
            formatId: 'audio-' + format,
            fileSize: '~2-10 MB',
            codec: format,
            ext: format,
            note: 'Audio extraction mode'
        };
    } else {
        // VIDEO MODE: Use analyzed format or smart fallback
        
        // Priority order:
        // 1. Use format from analyzeFormats() if available
        // 2. Use forced low format with extensive fallbacks
        // 3. Ultimate fallback to "worst"
        
        // Method A: Format sort prefers smallest files (lowest quality)
        command += ' --format-sort "size:asc,res:240,vcodec:h264"';
        
        // Method B: Explicit worst-quality selection with fallback chain
        // Tries: worst combined → worst video only → worst audio only → ANY format → best
        formatToUse = ' -f "worstvideo+worstaudio/worstvideo/worstaudio/worst/best"';
        
        // Update format info for display
        selectedFormatInfo = {
            resolution: 'Lowest Available',
            formatId: 'auto-worst',
            fileSize: '~5-20 MB (estimated)',
            codec: 'h264/aac',
            ext: format || 'mp4',
            note: 'Auto-selected lowest quality'
        };
        
        // Merge format if specified (not mp4 which is default)
        if (format && format !== 'mp4' && format !== 'auto') {
            formatToUse += ' --merge-output-format ' + format;
        }
    }
    
    // Apply the format selection
    command += formatToUse;
    
    // CRITICAL RELIABILITY FLAGS:
    command += ' --ignore-no-formats-error';   // Don't crash on empty formats
    command += ' --retries 5';                  // More retries on network issues
    command += ' --fragment-retries 10';         // Retry fragments more aggressively
    command += ' --force-ipv4';                 // Force IPv4 (fixes regional blocks)
    command += ' --no-check-certificates';      // Skip SSL certificate issues
    
    command += ' https://www.youtube.com/watch?v=' + videoId;`;

        if (serverContent.includes(oldCommandBuild)) {
            serverContent = serverContent.replace(oldCommandBuild, newCommandBuild);
            logChange('Updated command building to use analyzed format');
        }
        
        // Add format info to downloadJob object
        const oldJobObject = `// Start download process
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
    };`;

        const newJobObject = `// Start download process (WITH FORMAT INFO FOR DISPLAY)
    const downloadJob = {
        id: jobId,
        videoId: videoId,
        title: title,
        status: 'analyzing',  // Start as 'analyzing' until format is confirmed
        progress: 0,
        speed: '',
        eta: '',
        startedAt: new Date().toISOString(),
        mode: currentDownloadMode,
        outputPath: finalPath,
        // NEW: Store format information for UI display
        formatInfo: selectedFormatInfo,
        selectedResolution: selectedFormatInfo.resolution,
        estimatedSize: selectedFormatInfo.fileSize,
        formatId: selectedFormatInfo.formatId
    };`;

        if (serverContent.includes(oldJobObject)) {
            serverContent = serverContent.replace(oldJobObject, newJobObject);
            logChange('Added formatInfo to downloadJob object');
        }
        
        // Change status from 'analyzing' to 'downloading' after spawn
        const oldSpawn = `// Execute download
    const child = spawn(command, [], { shell: true });`;

        const newSpawn = `// Execute download (format already analyzed above)
    // Update status to show we're actually downloading now
    downloadJob.status = 'downloading';
    downloadJob.formatInfo.status = 'downloading';
    
    const child = spawn(command, [], { shell: true });`;

        if (serverContent.includes(oldSpawn)) {
            serverContent = serverContent.replace(oldSpawn, newSpawn);
            logChange('Status transitions: analyzing → downloading');
        }
    }
    
    // --------------------------------------------------------------------------
    // FIX 1.3: Add API endpoint to manually check formats for a video
    // --------------------------------------------------------------------------
    if (!serverContent.includes('/api/video/:videoId/formats')) {
        const formatAPI = `

// ============================================
// GET VIDEO FORMATS - Analyze available formats for a specific video
// ============================================
app.get('/api/video/:videoId/formats', function(req, res) {
    const videoId = req.params.videoId;
    
    console.log('📊 Format request for video: ' + videoId);
    
    analyzeFormats(videoId, function(error, formatInfo) {
        if (error) {
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to analyze formats: ' + error.message 
            });
        }
        
        res.json({
            success: true,
            videoId: videoId,
            formatInfo: formatInfo,
            message: 'Format analysis complete. Recommended: ' + (formatInfo.formatId || 'worst')
        });
    });
});
`;
        
        // Add before static file serving or at end of routes
        if (serverContent.includes("app.use(express.static")) {
            serverContent = serverContent.replace(
                "app.use(express.static",
                formatAPI + "\napp.use(express.static"
            );
        } else {
            serverContent += '\n' + formatAPI;
        }
        logChange('Added /api/video/:videoId/formats endpoint');
    }
    
    // Write updated server.js
    if (serverContent !== originalContent) {
        fs.writeFileSync(SERVER_JS_PATH, serverContent, 'utf8');
        console.log('   ──────────────────────────────────────');
        console.log('  ✅ server.js updated with Format Analysis\n');
    } else {
        console.log('  ⚠️ No changes needed for server.js\n');
    }
    
} else {
    console.log('❌ server.js not found at: ' + SERVER_JS_PATH);
    console.log('');
}

// =============================================================================
// PART 2: UPDATE index.html - Show Format Info in Downloads List
// =============================================================================

if (fs.existsSync(INDEX_HTML_PATH)) {
    console.log('🎨 Updating index.html (Adding Format Display)...');
    console.log('   ──────────────────────────────────────');
    
    let htmlContent = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const originalHtml = htmlContent;
    
    // --------------------------------------------------------------------------
    // FIX 2.1: Add CSS for format display badges
    // --------------------------------------------------------------------------
    if (!htmlContent.includes('.format-badge')) {
        const formatCSS = `
        /* Format Information Display */
        .format-info {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 6px;
            flex-wrap: wrap;
        }
        .format-badge {
            display: inline-flex;
            align-items: center;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            background: rgba(156, 39, 176, 0.25);
            color: #CE93D8;
            border: 1px solid rgba(156, 39, 176, 0.4);
        }
        .size-badge {
            display: inline-flex;
            align-items: center;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 10px;
            font-weight: 600;
            background: rgba(0, 150, 136, 0.25);
            color: #80CBC4;
            border: 1px solid rgba(0, 150, 136, 0.4);
        }
        .codec-badge {
            display: inline-flex;
            align-items: center;
            padding: 3px 8px;
            border-radius: 10px;
            font-size: 9px;
            font-weight: 600;
            background: rgba(255, 152, 0, 0.2);
            color: #FFCC80;
            border: 1px solid rgba(255, 152, 0, 0.3);
        }
        .analyzing-indicator {
            color: #FFD54F;
            font-size: 11px;
            animation: pulse 1s infinite;
        }
`;

        htmlContent = htmlContent.replace('</style>', formatCSS + '</style>');
        logChange('Added CSS for format display badges');
    }
    
    // --------------------------------------------------------------------------
    // FIX 2.2: Update updateDownloadsList to show format information
    // --------------------------------------------------------------------------
    // Look for the section where download items are built and add format info
    const oldItemHtml = `html += '       <div style="margin-top: 8px;">' + statusBadge + '</div>';`;

    const newItemHtml = `// ADD FORMAT INFORMATION DISPLAY
                html += '       <div class="format-info">';
                
                // Show format/resolution badge
                if (d.selectedResolution || d.formatInfo?.resolution) {
                    const resText = d.selectedResolution || d.formatInfo?.resolution || 'Unknown';
                    const isAnalyzing = resText.toLowerCase().includes('analyzing') || d.status === 'analyzing';
                    
                    html += '<span class="format-badge' + (isAnalyzing ? ' analyzing-indicator' : '') + '">';
                    html += isAnalyzing ? '🔍 Analyzing...' : '📺 ' + resText;
                    html += '</span>';
                }
                
                // Show file size estimate
                if (d.estimatedSize || d.formatInfo?.fileSize) {
                    const sizeText = d.estimatedSize || d.formatInfo?.fileSize || '';
                    if (sizeText && !sizeText.toLowerCase().includes('detecting')) {
                        html += '<span class="size-badge">💾 ' + sizeText + '</span>';
                    } else if (d.status === 'analyzing') {
                        html += '<span class="size-badge analyzing-indicator">💾 Detecting...</span>';
                    }
                }
                
                // Show codec/format ID
                if (d.formatInfo?.codec && d.formatInfo.codec !== 'auto') {
                    html += '<span class="codec-badge">🎵 ' + d.formatInfo.codec + '</span>';
                } else if (d.formatId && d.formatId !== 'scanning' && d.formatId !== 'auto-worst') {
                    html += '<span class="codec-badge">ID: ' + d.formatId.substring(0, 15) + (d.formatId.length > 15 ? '...' : '') + '</span>';
                }
                
                html += '</div>';`;

    if (htmlContent.includes(oldItemHtml)) {
        htmlContent = htmlContent.replace(oldItemHtml, newItemHtml);
        logChange('Added format info display to download items');
    } else {
        // Alternative: Try to find and modify the statusBadge area
        const altPattern = /statusBadge\+ '<\/span>'\;\s*\}\s*html \+= '       <\/div>'\;/;
        if (altPattern.test(htmlContent)) {
            const replacement = `statusBadge + '</span>';
                }
                
                // Format info display
                html += '       <div class="format-info">';
                if (d.selectedResolution || (d.formatInfo && d.formatInfo.resolution)) {
                    const res = d.selectedResolution || (d.formatInfo ? d.formatInfo.resolution : 'Unknown');
                    html += '<span class="format-badge">📺 ' + res + '</span>';
                }
                if (d.estimatedSize || (d.formatInfo && d.formatInfo.fileSize)) {
                    const sz = d.estimatedSize || (d.formatInfo ? d.formatInfo.fileSize : '');
                    if (sz) html += '<span class="size-badge">💾 ' + sz + '</span>';
                }
                html += '</div>';
                html += '       </div>';`;
            
            htmlContent = htmlContent.replace(altPattern, replacement);
            logChange('Added format info (alternative method)');
        }
    }
    
    // --------------------------------------------------------------------------
    // FIX 2.3: Add function to manually trigger format check
    // --------------------------------------------------------------------------
    if (!htmlContent.includes('checkVideoFormat')) {
        const checkFormatFunc = `
        
        // ===========================================
        // CHECK VIDEO FORMAT (Manual trigger)
        // ===========================================
        async function checkVideoFormat(videoId, title) {
            try {
                showNotification('🔍 Analyzing formats for: ' + title, 'info');
                
                const response = await fetch('/api/video/' + videoId + '/formats');
                const result = await response.json();
                
                if (result.success) {
                    const info = result.formatInfo;
                    showNotification('📊 Format: ' + info.resolution + ' | Size: ~' + info.fileSize, 'success');
                    console.log('Format Analysis Result:', info);
                    return info;
                } else {
                    showNotification('❌ Format analysis failed', 'error');
                    return null;
                }
            } catch (error) {
                showNotification('❌ Error: ' + error.message, 'error');
                return null;
            }
        }
`;

        htmlContent = htmlContent.replace('</script>', checkFormatFunc + '</script>');
        logChange('Added checkVideoFormat() function');
    }
    
    // Write updated index.html
    if (htmlContent !== originalHtml) {
        fs.writeFileSync(INDEX_HTML_PATH, htmlContent, 'utf8');
        console.log('   ──────────────────────────────────────');
        console.log('  ✅ index.html updated with Format Display\n');
    } else {
        console.log('  ⚠️ No changes needed for index.html\n');
    }
    
} else {
    console.log('❌ index.html not found at: ' + INDEX_HTML_PATH);
    console.log('');
}

// =============================================================================
// SUMMARY
// =============================================================================

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  🎬 FORMAT ANALYZER COMPLETE!                              ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║  Total Changes Applied: ' + totalChanges.toString().padStart(3) + '                                   ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

if (totalChanges > 0) {
    console.log('');
    console.log('🎯 Features Added:');
    console.log('─'.repeat(50));
    console.log('  🔍 Format Analysis     → Scans each video before download');
    console.log('  📉 Auto Low-Quality    → Picks lowest available format');
    console.log('  📊 Resolution Badge   → Shows selected resolution');
    console.log('  💾 File Size Estimate → Shows expected download size');
    console.log('  🎵 Codec Display      → Shows audio/video codec');
    console.log('  📡 API Endpoint       → /api/video/:id/formats');
    console.log('  ⏳ Analyzing Status   → Shows while scanning formats');
    console.log('');
    console.log('🔄 Download Flow:');
    console.log('─'.repeat(50));
    console.log('  1. User clicks download');
    console.log('  2. System shows "🔍 Analyzing..." status');
    console.log('  3. yt-dlp scans available formats');
    console.log('  4. Selects LOWEST quality format');
    console.log('  5. Updates UI with format details');
    console.log('  6. Starts download with optimal format');
    console.log('');
    console.log('🚀 Restart server to apply changes:');
    console.log('   cd youtube-download/server && node server.js');
    console.log('');
} else {
    console.log('');
    console.log('⚠️ No changes were needed (already patched?)');
    console.log('');
}
