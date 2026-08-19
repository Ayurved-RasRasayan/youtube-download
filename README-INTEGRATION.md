# 🎬 YouTube Downloader - Complete Integration Package

## 📦 What's Included

This package contains a **modern Next.js 16 frontend** that integrates with your existing **Express + yt-dlp backend** from `Ayurved-RasRasayan/youtube-download`.

---

## 🚀 Quick Start (Copy & Paste)

### Step 1: Copy to Your Repository

```bash
# Extract this zip to your youtube-download repo root:
youtube-download/
├── next-app/              ← Copy NEXT-APP folder here
│   ├── src/
│   ├── public/
│   ├── package.json
│   ├── next.config.ts
│   ├── tailwind.config.ts
│   └── ...config files
├── server/                ← Your existing Express backend
│   ├── server.js
│   └── package.json
└── README.md
```

### Step 2: Install Dependencies

```bash
# Install Next.js app dependencies
cd next-app
npm install

# Install server dependencies (if not done)
cd ../server
npm install

# Make sure yt-dlp is installed
yt-dlp --version  # Should show version number
```

### Step 3: Start Both Servers

**Terminal 1 - Start Express Backend:**
```bash
cd server
node server.js
# Server runs on http://localhost:3000
```

**Terminal 2 - Start Next.js Frontend:**
```bash
cd next-app
npm run dev
# Frontend runs on http://localhost:3001
```

### Step 4: Open in Browser

Navigate to: **http://localhost:3001**

---

## 📁 File Structure

```
next-app/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Main UI component
│   │   ├── layout.tsx            # Root layout
│   │   ├── globals.css           # Global styles
│   │   └── api/
│   │       ├── channels/route.ts # Channel management API
│   │       ├── download/route.ts # Download handler
│   │       └── health/route.ts   # Health check
│   ├── components/ui/             # shadcn/ui components
│   └── lib/
│       └── utils.ts              # Utility functions
├── public/
│   └── logo.svg
├── package.json
├── next.config.ts                # Proxy config for API
├── tailwind.config.ts
├── tsconfig.json
└── postcss.config.mjs
```

---

## ⚙️ Configuration

### API Proxy Setup (next.config.ts)

The Next.js app is configured to proxy API requests to your Express backend:

```typescript
// next.config.ts
module.exports = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3000/api/:path*',
      },
    ]
  },
}
```

This means:
- Frontend runs on **port 3001**
- Backend API runs on **port 3000**
- All `/api/*` calls are automatically proxied

---

## 🎯 Features

### ✅ Full YouTube Channel Management
- Add any YouTube channel (@handle, /c/, /channel/, /user/)
- View videos and live streams in separate tabs
- Auto-detect new content with "NEW" badges

### ✅ Download Capabilities
- **Individual Downloads**: Click download on any video
- **Batch Download**: Select multiple → "Download Selected"
- **Real Progress**: Speed, percentage, ETA display
- **Quality Selection**: Best, 1080p, 720p, 480p
- **Format Options**: MP4, WebM, MP3, M4A

### ✅ Smart Organization
```
downloads/
└── ChannelName/
    ├── Videos/
    │   ├── Video1.mp4
    │   └── Video2.mp4
    └── Live Streams/
        └── LiveStream1.mp4
```

### ✅ Modern UI
- Dark/Light theme support
- Responsive design (mobile-friendly)
- Smooth animations
- Real-time status updates

---

## 🔌 API Integration Points

| Frontend Action | Backend Endpoint | Description |
|-----------------|------------------|-------------|
| Load channel | `POST /api/channels` | Fetch channel videos |
| Refresh channel | `POST /api/channels/:id/refresh` | Check for new videos |
| Start download | `POST /api/download` | Begin video download |
| Check progress | `GET /api/download/:jobId` | Get download status |
| Get settings | `GET /api/settings` | User preferences |
| Update settings | `POST /api/settings` | Save preferences |

---

## 🛠️ Troubleshooting

### Port Already in Use
```bash
# Change ports if needed:
# Backend: Edit server/server.js -> PORT = 3001
# Frontend: Edit next-app/package.json -> "dev": "next -p 3002"
```

### yt-dlp Not Found
```bash
# Install yt-dlp:
pip install yt-dlp

# Or brew install yt-dlp (macOS)
# Or sudo apt install yt-dlp (Ubuntu)
```

### CORS Issues
The Express backend already has CORS enabled. If you see errors:
```bash
# Check server.js has:
app.use(cors());
```

---

## 📝 Environment Variables (Optional)

Create `.env.local` in the `next-app/` folder:

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=YouTube Downloader
```

---

## 🎨 Customization

### Change Theme Colors
Edit `src/app/globals.css` or use Tailwind classes in components.

### Modify Download Folder
Use the Settings UI or call:
```javascript
POST /api/settings
{ "outputFolder": "/path/to/custom/folder" }
```

---

## 📄 License

MIT License - Same as original repository

---

## 🤝 Support

- Original Repo: https://github.com/Ayurved-RasRasayan/youtube-download
- Issues: Open an issue on GitHub

---

**Built with ❤️ using Next.js 16 + TypeScript + Tailwind CSS + shadcn/ui**
