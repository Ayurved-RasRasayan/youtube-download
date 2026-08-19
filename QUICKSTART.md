# 🚀 Quick Start Guide - 3 Steps to Run

## Step 1: Extract Files
```bash
# Copy the contents of this folder to your youtube-download repo:
cp -r next-app/* /path/to/youtube-download/
```

## Step 2: Install & Run Backend
```bash
cd /path/to/youtube-download/server
npm install
node server.js
# → Server running on http://localhost:3000
```

## Step 3: Install & Run Frontend
```bash
cd /path/to/youtube-download/next-app
npm install
npm run dev
# → Frontend running on http://localhost:3001
```

## 🎉 Open Browser!
Go to **http://localhost:3001**

---

## ✅ Requirements Checklist

- [ ] Node.js v18+ installed
- [ ] npm or bun package manager
- [ ] yt-dlp installed (`pip install yt-dlp`)
- [ ] Port 3000 available (backend)
- [ ] Port 3001 available (frontend)

---

## 🔧 Troubleshooting

**Port 3000 already in use?**
Edit `server/server.js` and change `PORT = 3001`

**Port 3001 already in use?**
Run `npm run dev -- -p 3002` instead

**yt-dlp not found?**
```bash
pip install yt-dlp
# or
brew install yt-dlp  # macOS
# or  
sudo apt install yt-dlp  # Ubuntu
```

**CORS errors?**
Make sure backend is running before starting frontend.

---

## 📱 Features You Get

✅ Add any YouTube channel (@handle, /c/, /channel/, /user/)  
✅ Browse Videos & Live Streams in tabs  
✅ Select individual or multiple videos  
✅ Download with progress tracking  
✅ Real-time server status  
✅ Responsive design (mobile-friendly)  
✅ Dark/Light theme support  

---

**Need help? Check README-INTEGRATION.md for full documentation!**
