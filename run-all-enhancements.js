/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  RUN ALL ENHANCEMENTS - Complete YouTube Downloader Setup                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * 
 * This script runs ALL enhancements in the correct order:
 *   1. MEGA ENHANCEMENT (Cancel/Resume buttons, Low Format, Limits)
 *   2. FORMAT ANALYZER (Smart format detection, UI display)
 * 
 * Usage:
 *   node run-all-enhancements.js [path-to-youtube-download-folder]
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  🚀 RUNNING ALL ENHANCEMENTS                                ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

// Get the target directory (where youtube-download folder is)
const basePath = process.argv[2] || process.cwd();
const scriptDir = path.dirname(__filename);

console.log('📁 Target directory: ' + basePath);
console.log('📁 Scripts location: ' + scriptDir);
console.log('');

let successCount = 0;
let failCount = 0;

function runScript(name, scriptPath) {
    console.log('─'.repeat(60));
    console.log('📦 Running: ' + name);
    console.log('   Script: ' + scriptPath);
    console.log('─'.repeat(60));
    
    try {
        const result = execSync('node "' + scriptPath + '" "' + basePath + '"', {
            encoding: 'utf8',
            stdio: 'inherit',
            timeout: 60000
        });
        successCount++;
        console.log('\n✅ ' + name + ' completed successfully!\n');
        return true;
    } catch (error) {
        failCount++;
        console.error('\n❌ ' + name + ' failed: ' + error.message + '\n');
        return false;
    }
}

// Run enhancements in order
console.log('📋 Enhancement Order:');
console.log('   1. Mega Enhancement (Buttons, Limits, Low Format)');
console.log('   2. Format Analyzer (Smart Detection, Display)');
console.log('');

// Step 1: Mega Enhancement
const megaEnhancementPath = path.join(scriptDir, 'mega-enhancement.js');
if (require('fs').existsSync(megaEnhancementPath)) {
    runScript('MEGA ENHANCEMENT', megaEnhancementPath);
} else {
    console.log('⚠️ mega-enhancement.js not found, skipping...');
}

// Step 2: Format Analyzer
const formatAnalyzerPath = path.join(scriptDir, 'format-analyzer.js');
if (require('fs').existsSync(formatAnalyzerPath)) {
    runScript('FORMAT ANALYZER', formatAnalyzerPath);
} else {
    console.log('⚠️ format-analyzer.js not found, skipping...');
}

// Summary
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  📊 ALL ENHANCEMENTS COMPLETE!                              ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║  ✅ Successful: ' + successCount.toString().padStart(3) + '                                         ║');
if (failCount > 0) {
    console.log('║  ❌ Failed:     ' + failCount.toString().padStart(3) + '                                         ║');
}
console.log('╚══════════════════════════════════════════════════════════════╝');

console.log('');
console.log('🎯 Total Features Applied:');
console.log('─'.repeat(50));
console.log('  From MEGA ENHANCEMENT:');
console.log('    🔴 Cancel/Resume/Stop/Retry/Remove buttons');
console.log('    ⚡ Sequential mode: 3 concurrent downloads');
console.log('    📉 Forced low quality format');
console.log('    🔄 Auto-retry & error resilience');
console.log('');
console.log('  From FORMAT ANALYZER:');
console.log('    🔍 Pre-scan each video for available formats');
console.log('    📉 Auto-select LOWEST quality format');
console.log('    📊 Show resolution badge in UI');
console.log('    💾 Show estimated file size');
console.log('    🎵 Show codec information');
console.log('    📡 API endpoint for manual format check');
console.log('');

if (successCount === 2) {
    console.log('🚀 READY! Restart your server:');
    console.log('   cd youtube-download/server && node server.js');
    console.log('');
} else if (successCount > 0) {
    console.log('⚠️ Partial success. Some enhancements may need manual review.');
    console.log('');
}
