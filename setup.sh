#!/bin/bash

# YouTube Channel Downloader - Setup Script
# This script sets up the complete environment for downloading YouTube videos

set -e

echo "╔══════════════════════════════════════════════════════╗"
echo "║     YouTube Channel Downloader Setup                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed!"
    echo "   Please install Node.js from https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed!"
    exit 1
fi

echo "✅ npm version: $(npm --version)"

# Navigate to server directory
cd /home/z/my-project/youtube-downloader/server

# Install Node.js dependencies
echo ""
echo "📦 Installing Node.js dependencies..."
npm install

# Check if yt-dlp is installed
echo ""
if command -v yt-dlp &> /dev/null; then
    echo "✅ yt-dlp is already installed: $(yt-dlp --version)"
else
    echo "⚠️  yt-dlp is not installed. Installing..."
    
    # Try pip installation
    if command -v pip3 &> /dev/null; then
        pip3 install yt-dlp
        echo "✅ yt-dlp installed via pip3"
    elif command -v pip &> /dev/null; then
        pip install yt-dlp
        echo "✅ yt-dlp installed via pip"
    else
        echo "⚠️  Could not find pip. Please install yt-dlp manually:"
        echo "   pip install yt-dlp"
        echo "   Or: brew install yt-dlp (macOS)"
        echo "   Or: sudo apt install yt-dlp (Ubuntu)"
    fi
fi

# Create downloads directory
mkdir -p /home/z/my-project/youtube-downloader/downloads

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║                    SETUP COMPLETE!                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "🚀 To start the server, run:"
echo ""
echo "   cd /home/z/my-project/youtube-downloader/server"
echo "   node server.js"
echo ""
echo "Then open your browser to: http://localhost:3000"
echo ""
echo "📁 Downloaded videos will be saved to:"
echo "   /home/z/my-project/youtube-downloader/downloads/"
echo "   └── ChannelName/"
echo "       ├── Videos/"
echo "       └── Live Streams/"
echo ""

# Ask if user wants to start the server now
read -p "Start the server now? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "Starting server..."
    node server.js
fi
