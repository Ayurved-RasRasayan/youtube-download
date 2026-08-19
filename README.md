# 🎬 YouTube Channel Downloader

<p align="center">
  <strong>Download & organize YouTube channel content with automatic new video detection</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v18+-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/yt-dlp-installed-blue" alt="yt-dlp">
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License">
  <img src="https://img.shields.io/badge/Status-Active-brightgreen" alt="Status">
</p>

---

## ✨ Features

- **📁 Smart Folder Organization** - Videos and Live Streams automatically sorted into separate folders
- **🔴 New Content Detection** - Auto-checks for new videos and marks them with glowing "NEW" badge
- **⬇️ Real Downloads** - Uses yt-dlp for actual video/audio downloading with progress tracking
- **📊 Progress Tracking** - Real-time download progress with speed, percentage, and ETA
- **💾 Persistent Storage** - Channels and download history saved locally
- **⚙️ Customizable Settings** - Choose quality (up to 1080p) and format (MP4, MP3, WebM, M4A)
- **🔄 Auto-Refresh** - Configurable auto-check intervals (30 seconds to 10 minutes)
- **🌐 Beautiful UI** - Modern dark-themed responsive interface

---

## 📸 Preview

### Main Interface
```
┌─────────────────────────────────────────────────────────────┐
│  🎬 YouTube Channel Downloader                    [Connected] │
├─────────────────────────────────────────────────────────────┤
│  [Paste YouTube channel URL here...        ] [Load] [⚙️][⬇️] │
│                                                             │
│  ☑ Auto-check every: [5 minutes ▼]    [🔄 Check Now] [🗑️]  │
├─────────────────────────────────────────────────────────────┤
│  📁 MrBeast                                              🆕2 │
│  └── 📹 Videos (45)                              [3 new]   │
│      ├── 📄 I Gave My Brother 500 Cars          [NEW] ⬇️   │
│      ├── 📄 Last To Leave Pool Wins $10K         [NEW] ⬇️   │
│      └── 📄 $1 vs $1,000,000 House!                  ⬇️   │
│  └── 🔴 Live Streams (3)                         [1 new]   │
│      └── 📄 Live Q&A Session                    [NEW] ⬇️   │
└─────────────────────────────────────────────────────────────┘
```

### Download Progress
```
┌─────────────────────────────────────────────┐
│  📥 Active Downloads                        │
│  ─────────────────────────────────────────  │
│  I Gave My Brother 500 Cars                 │
│  ████████████████████░░░░ 78%               │
│  78% • 2.5 MB/s • ETA: 0:45                │
└─────────────────────────────────────────────┘
```

---

## 📂 Folder Structure

```
youtube-downloader/
├── server/
│   ├── server.js              # Express backend API
│   ├── package.json           # Node.js dependencies
│   └── package-lock.json      # Dependency lock file
├── downloads/                  # Downloaded videos (gitignored)
│   └── ChannelName/
│       ├── Videos/
│       │   └── Video Title.mp4
│       └── Live Streams/
│           └── Stream Title.mp4
├── public/                     # Frontend files
│   └── index.html             # Main UI (or youtube-channel-downloader.html)
├── .gitignore                 # Git ignore rules
├── setup.sh                   # Quick setup script
├── LICENSE                    # MIT License
└── README.md                  # This file
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** v18 or higher ([Download](https://nodejs.org/))
- **npm** (comes with Node.js)
- **yt-dlp** ([Installation](#installing-ytdlp))

<details>
<summary>Installing yt-dlp</summary>

```bash
# Using pip (recommended)
pip install yt-dlp

# Using brew (macOS)
brew install yt-dlp

# Using apt (Ubuntu/Debian)
sudo apt update && sudo apt install yt-dlp

# Using conda
conda install -c conda-forge yt-dlp

# Using pipx
pipx install yt-dlp
```
</details>

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/youtube-channel-downloader.git
cd youtube-channel-downloader

# Install dependencies
cd server
npm install

# Start the server
node server.js
```

### One-Line Setup

```bash
chmod +x setup.sh && ./setup.sh
```

---

## 💻 Usage

### 1. Start the Server

```bash
cd server
node server.js
```

You should see:
```
╔══════════════════════════════════════════╗
║     YouTube Channel Downloader Server    ║
╠══════════════════════════════════════════╣
║  Server running on: http://localhost:3000  ║
║  yt-dlp installed: ✅ Yes              ║
╚══════════════════════════════════════════╝
```

### 2. Open in Browser

Navigate to: **http://localhost:3000**

### 3. Add a Channel

Paste any YouTube channel URL:
- `https://www.youtube.com/@MrBeast` (Handle)
- `https://www.youtube.com/c/MrBeast` (Custom URL)
- `https://www.youtube.com/channel/UCxxxxxxxx` (Channel ID)

### 4. Download Videos

Click the **⬇️ Download** button on any video!

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

Example:
```bash
PORT=8080 node server.js
```

### Download Settings (via UI)

| Setting | Options |
|---------|---------|
| Video Quality | Best Available, 1080p, 720p, 480p |
| Format | MP4, WebM, MP3 (Audio), M4A (Audio) |
| Auto-check Interval | 30s, 1min, 5min, 10min |

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server health check |
| `GET` | `/api/channels` | Get all tracked channels |
| `POST` | `/api/channels` | Add/load new channel |
| `POST` | `/api/channels/:id/refresh` | Check channel for new videos |
| `DELETE` | `/api/channels/:id` | Remove channel |
| `DELETE` | `/api/channels` | Clear all channels |
| `POST` | `/api/download` | Start video download |
| `GET` | `/api/download/:jobId` | Get download status |
| `GET` | `/api/downloads` | Get all active downloads |

### Example API Usage

```bash
# Add a channel
curl -X POST http://localhost:3000/api/channels \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/@MrBeast"}'

# Start download
curl -X POST http://localhost:3000/api/download \
  -H "Content-Type: application/json" \
  -d '{
    "videoId": "dQw4w9WgXcQ",
    "title": "Never Gonna Give You Up",
    "channelId": "MrBeast",
    "quality": "1080",
    "format": "mp4"
  }'
```

---

## 🔧 How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser    │────▶│  Express    │────▶│   yt-dlp     │
│   (Frontend) │◀────│   Server    │◀────│ (Downloader) │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                    │
       │                   ▼                    ▼
       │            ┌─────────────┐     ┌─────────────┐
       │            │  data.json  │     │ downloads/  │
       │            │ (Storage)   │     │ (Files)     │
       │            └─────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐
│   User sees  │
│  UI + DLs   │
└─────────────┘
```

1. **User pastes channel URL** → Frontend sends to API
2. **Server calls yt-dlp** → Fetches real channel data
3. **Videos organized** → Split into Videos/Live folders
4. **New detection** → Compares against known video IDs
5. **Download request** → yt-dlp downloads with progress tracking
6. **Auto-scheduler** → Checks every 5 minutes for updates

---

## 🛠️ Tech Stack

| Technology | Purpose |
|------------|---------|
| **Node.js** | Runtime environment |
| **Express** | Web server framework |
| **yt-dlp** | YouTube downloading |
| **HTML/CSS/JS** | Frontend interface |
| **node-cron** | Scheduled tasks |
| **localStorage** | Client-side persistence |

---

## 📋 Supported URL Formats

✅ **Supported:**
- `@handle` format (`youtube.com/@ChannelName`)
- Custom URL (`youtube.com/c/ChannelName`)
- Channel ID (`youtube.com/channel/UCxxxxxxxx`)
- Username (`youtube.com/user/Username`)
- Direct video URLs

❌ **Not supported:**
- Playlist URLs (coming soon)
- Short URLs (youtu.be) - use full URLs instead

---

## ❓ Troubleshooting

<details>
<summary><strong>"Server not running" error</strong></summary>

1. Ensure you started the server: `node server.js`
2. Check if port 3000 is available: `lsof -i :3000`
3. Try different port: `PORT=3001 node server.js`
</details>

<details>
<summary><strong>yt-dlp errors</strong></summary>

1. Update yt-dlp: `pip install --upgrade yt-dlp`
2. Check YouTube accessibility in your region
3. Some videos may be age-restricted or private
4. Try with VPN if region-blocked
</details>

<details>
<summary><strong>Slow downloads</strong></summary>

1. Lower quality setting (720p instead of 1080p)
2. Check internet connection speed
3. Avoid peak hours
4. Close other bandwidth-heavy applications
</details>

<details>
<summary><strong>"Module not found" errors</strong></summary>

```bash
# Re-install dependencies
cd server
rm -rf node_modules package-lock.json
npm install
```
</details>

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/amazing-feature`
3. **Commit** your changes: `git commit -m 'Add amazing feature'`
4. **Push** to the branch: `git push origin feature/amazing-feature`
5. **Open** a Pull Request

### Development Setup

```bash
# Fork and clone your fork
git clone https://github.com/YOUR_USERNAME/youtube-channel-downloader.git
cd youtube-channel-downloader

# Install dependencies
cd server && npm install

# Start development server
node server.js
```

---

## 📝 Roadmap

- [ ] Playlist support
- [ ] Batch download (select multiple videos)
- [ ] Download queue management
- [ ] Subtitle downloading
- [ ] Thumbnail downloading
- [ ] Dark/Light theme toggle
- [ ] Multi-language support
- [ ] Docker support
- [ ] Browser extension
- [ ] Mobile app (React Native)

---

## ⚠️ Disclaimer

**This tool is for personal use only.**

- ✅ Download videos you own or have permission to download
- ✅ Use for offline viewing of content you've subscribed to
- ✅ Support creators through official channels when possible
- ❌ Do not redistribute downloaded content without permission
- ❌ Do not use for commercial purposes without authorization
- ❌ Respect YouTube's Terms of Service

**I am not responsible for misuse of this tool.**

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - Amazing YouTube downloader
- [Express.js](https://expressjs.com/) - Web framework
- [Node.js](https://nodejs.org/) - Runtime environment

---

## 📞 Support

- 📧 Create an [Issue](https://github.com/YOUR_USERNAME/youtube-channel-downloader/issues)
- 💬 Start a [Discussion](https://github.com/YOUR_USERNAME/youtube-channel-downloader/discussions)
- 🐛 Report bugs with detailed reproduction steps
- 💡 Feature requests are welcome!

---

<div align="center">

**Made with ❤️ by [Your Name]**

[⭐ Star this repo](https://github.com/YOUR_USERNAME/youtube-channel-downloader/stargazers) • 
[🍴 Fork](https://github.com/YOUR_USERNAME/youtube-channel-downloader/fork) • 
[📢 Share]

</div>
