/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  YouTube CHANNEL Downloader - Cloudflare Worker                          ║
 * ║  Version: 8.0.0 - Download ALL Videos from Any Channel                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * 
 * ✅ FEATURES:
 *    • Paste ANY YouTube channel URL (@handle, /c/, /channel/, /user/)
 *    • Fetch ALL videos from the channel via Invidious API
 *    • Select specific videos or download ALL at once
 *    • Real video file downloads (360p, 720p, 1080p + Audio only)
 *    • Batch download queue with progress tracking
 *    • Smart fallback across multiple Invidious instances
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  VERSION: '8.0.0',
  MAX_CONCURRENT: 3, // Reduced for channel downloads
  MAX_CHANNEL_VIDEOS: 100, // Max videos to fetch per channel
  RETRY_ATTEMPTS: 3,
  INFO_TIMEOUT: 15000,
  DOWNLOAD_TIMEOUT: 300000,
  
  // Invidious API instances (tried in order until one works)
  APIS: [
    'https://yt.lemnoslife.com',
    'https://inv.nadeko.net',
    'https://invidious.fdn.fr',
    'https://vid.puffyan.us',
    'https://invidious.snopyta.org',
    'https://invidious.kavin.rocks'
  ],
  
  YOUTUBE: {
    OEMBED: 'https://www.youtube.com/oembed',
    THUMBNAIL: 'https://img.youtube.com/vi'
  }
};

// =============================================================================
// DOWNLOAD STORE - Manages all download state
// =============================================================================

class DownloadStore {
  constructor() {
    this.downloads = new Map();
    this.active = 0;
    this.queue = [];
    this.startTime = Date.now();
    this.stats = {
      totalDownloads: 0,
      completedDownloads: 0,
      failedDownloads: 0,
      totalBytesServed: 0
    };
  }

  generateId() {
    return `dl_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  create(url, opts = {}) {
    const id = this.generateId();
    const download = {
      id,
      url,
      status: 'queued',
      progress: 0,
      speed: '0 B/s',
      eta: '--:--',
      
      // Video metadata
      title: opts.title || 'Loading...',
      thumbnail: opts.thumbnail || '',
      author: opts.author || '',
      duration: opts.duration || 0,
      quality: opts.quality || CONFIG.DEFAULT_QUALITY,
      format: opts.format || 'mp4',
      
      // Real download info
      directUrl: null,
      fileSize: null,
      contentType: null,
      downloaded: 0,
      
      // Timestamps
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      
      // Error handling
      retries: 0,
      maxRetries: CONFIG.RETRY_ATTEMPTS,
      error: null,
      
      // Options
      cookie: opts.cookie || ''
    };
    
    this.downloads.set(id, download);
    this.queue.push(id);
    this.stats.totalDownloads++;
    
    return download;
  }

  get(id) {
    return this.downloads.get(id) || null;
  }

  update(id, data) {
    const dl = this.downloads.get(id);
    if (!dl) return null;
    Object.assign(dl, data);
    return dl;
  }

  start(id) {
    if (this.active >= CONFIG.MAX_CONCURRENT) {
      return { ok: false, reason: 'MAX_CONCURRENT_REACHED' };
    }
    
    const dl = this.downloads.get(id);
    if (!dl) return { ok: false, reason: 'NOT_FOUND' };
    if (!['queued', 'paused'].includes(dl.status)) {
      return { ok: false, reason: `INVALID_STATUS: ${dl.status}` };
    }
    
    dl.status = 'downloading';
    dl.startedAt = Date.now();
    this.active++;
    
    return { ok: true, download: dl };
  }

  complete(id, result = {}) {
    const dl = this.downloads.get(id);
    if (!dl) return;
    
    dl.status = 'completed';
    dl.completedAt = Date.now();
    dl.progress = 100;
    
    if (result.fileSize) dl.fileSize = result.fileSize;
    if (result.directUrl) dl.directUrl = result.directUrl;
    
    this.active--;
    this.stats.completedDownloads++;
    this.stats.totalBytesServed += result.fileSize || 0;
    
    this.processQueue();
  }

  fail(id, error) {
    const dl = this.downloads.get(id);
    if (!dl) return;
    
    dl.error = typeof error === 'string' ? error : (error?.message || 'Unknown error');
    dl.retries++;
    
    if (dl.retries < dl.maxRetries) {
      dl.status = 'retrying';
      setTimeout(() => {
        if (dl.status === 'retrying') {
          dl.status = 'queued';
          dl.error = null;
          this.queue.push(id);
          this.processQueue();
        }
      }, 1000 * Math.pow(2, dl.retries));
    } else {
      dl.status = 'failed';
      this.active--;
      this.stats.failedDownloads++;
      this.processQueue();
    }
  }

  cancel(id) {
    const dl = this.downloads.get(id);
    if (!dl) return { ok: false, reason: 'NOT_FOUND' };
    if (['completed', 'cancelled'].includes(dl.status)) {
      return { ok: false, reason: 'ALREADY_DONE' };
    }
    
    const wasActive = dl.status === 'downloading';
    dl.status = 'cancelled';
    dl.cancelledAt = Date.now();
    
    if (wasActive) {
      this.active--;
      this.processQueue();
    }
    
    return { ok: true, download: dl };
  }

  togglePause(id) {
    const dl = this.downloads.get(id);
    if (!dl) return { ok: false, reason: 'NOT_FOUND' };
    
    if (dl.status === 'downloading') {
      dl.status = 'paused';
      this.active--;
      return { ok: true, action: 'paused', download: dl };
    }
    
    if (['paused', 'retrying'].includes(dl.status)) {
      dl.status = 'queued';
      this.queue.push(id);
      this.processQueue();
      return { ok: true, action: 'resumed', download: dl };
    }
    
    return { ok: false, reason: 'CANNOT_PAUSE' };
  }

  retry(id) {
    const dl = this.downloads.get(id);
    if (!dl) return { ok: false, reason: 'NOT_FOUND' };
    if (!['failed', 'cancelled'].includes(dl.status)) {
      return { ok: false, reason: 'NOT_RETRYABLE' };
    }
    
    dl.status = 'queued';
    dl.retries = 0;
    dl.error = null;
    dl.progress = 0;
    this.queue.push(id);
    this.processQueue();
    
    return { ok: true, download: dl };
  }

  list(filters = {}) {
    let downloads = Array.from(this.downloads.values());
    
    if (filters.status) {
      downloads = downloads.filter(d => d.status === filters.status);
    }
    if (filters.limit) {
      downloads = downloads.slice(0, filters.limit);
    }
    
    return downloads.sort((a, b) => b.createdAt - a.createdAt);
  }

  clearCompleted() {
    let cleared = 0;
    for (const [id, dl] of this.downloads) {
      if (['completed', 'failed', 'cancelled'].includes(dl.status)) {
        this.downloads.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  processQueue() {
    while (this.active < CONFIG.MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift();
      const dl = this.downloads.get(id);
      
      if (dl && dl.status === 'queued') {
        const result = this.start(id);
        if (result.ok) {
          this.prepareDownload(id); // Start getting real URL
        }
      }
    }
  }

  /**
   * PREPARE DOWNLOAD - Get real direct video URL from Invidious
   */
  async prepareDownload(id) {
    const dl = this.get(id);
    if (!dl) return;

    try {
      // Update progress to show we're working
      this.update(id, {
        progress: 10,
        speed: 'Preparing...',
        eta: 'Connecting to API...'
      });

      // Extract video ID from URL
      const videoId = extractVideoId(dl.url);
      if (!videoId) throw new Error('Could not extract video ID from URL');

      let directUrl = null;
      let selectedFormat = null;

      // Try each Invidious instance until we get a working URL
      for (let i = 0; i < CONFIG.APIS.length; i++) {
        const apiUrl = `${CONFIG.APIS[i]}/api/v1/videos/${videoId}`;
        
        try {
          this.update(id, {
            progress: 20 + (i * 10),
            eta: `Trying API ${i + 1}/${CONFIG.APIS.length}...`
          });

          const response = await fetch(apiUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0 (compatible; YouTubeDownloader/8.0)'
            },
            signal: AbortSignal.timeout(CONFIG.INFO_TIMEOUT)
          });

          if (response.ok) {
            const videoData = await response.json();
            
            // Update metadata from API
            if (videoData.title) this.update(id, { title: videoData.title });
            if (videoData.author) this.update(id, { author: videoData.author });
            if (videoData.lengthSeconds) this.update(id, { duration: parseInt(videoData.lengthSeconds) });
            if (videoData.videoThumbnails?.[0]?.url) {
              this.update(id, { thumbnail: videoData.videoThumbnails[0].url });
            }

            // Find best format based on user's quality preference
            selectedFormat = this.selectBestFormat(videoData, dl.quality, dl.format);
            
            if (selectedFormat && selectedFormat.url) {
              directUrl = selectedFormat.url;
              
              // Get file size if available
              if (selectedFormat.contentLength) {
                this.update(id, { fileSize: parseInt(selectedFormat.contentLength) });
              }
              
              console.log(`✅ Got URL from ${CONFIG.APIS[i]}`);
              break; // Success! Stop trying other APIs
            }
          }
        } catch (apiError) {
          console.warn(`❌ API ${CONFIG.APIS[i]} failed:`, apiError.message);
          continue; // Try next API
        }
      }

      if (!directUrl) {
        throw new Error(
          'No suitable video format found. The video may be:\n' +
          '- Private or age-restricted\n' +
          '- Not available in your region\n' +
          '- Removed or deleted'
        );
      }

      // Success! Update with real download info
      this.update(id, {
        progress: 80,
        directUrl: directUrl,
        contentType: selectedFormat.type || 'video/mp4',
        speed: 'Ready!',
        eta: 'Click Download File button'
      });

      // Mark as completed with the direct URL
      this.complete(id, {
        directUrl: directUrl,
        fileSize: dl.fileSize || 0
      });

      console.log(`✅ Download ready: ${dl.title}`);

    } catch (error) {
      console.error('❌ Prepare download failed:', error.message);
      this.fail(id, error);
    }
  }

  /**
   * SELECT BEST FORMAT - Find the right video quality
   */
  selectBestFormat(videoData, requestedQuality, requestedFormat) {
    // Combine all available formats
    const allFormats = [
      ...(videoData.adaptiveFormats || []),
      ...(videoData.formatStreams || [])
    ];

    if (allFormats.length === 0) {
      console.warn('No formats available in video data');
      return null;
    }

    // Parse and categorize formats
    const formats = allFormats.map(f => ({
      url: f.url,
      itag: f.itag,
      qualityLabel: f.qualityLabel || f.quality || 'unknown',
      quality: f.qualityLabel || f.quality || 'unknown',
      type: f.type || 'unknown',
      contentLength: f.contentLength,
      encoding: f.encoding,
      resolution: f.resolution,
      isAudio: (f.type || '').toLowerCase().includes('audio'),
      isVideoOnly: (f.type || '').toLowerCase().includes('video') && (f.type || '').includes('only')
    }));

    // Check if audio-only request
    const wantAudio = requestedQuality.includes('audio');

    if (wantAudio) {
      // Return best audio format
      const audioFormats = formats.filter(f => f.isAudio);
      if (audioFormats.length > 0) {
        audioFormats.sort((a, b) => {
          const sizeA = parseInt(a.contentLength) || Infinity;
          const sizeB = parseInt(b.contentLength) || Infinity;
          return sizeA - sizeB;
        });
        return audioFormats[0];
      }
      return null;
    }

    // For video: prefer combined formats (video + audio together)
    const combinedFormats = formats.filter(f => !f.isAudio && !f.isVideoOnly);
    
    if (combinedFormats.length > 0) {
      combinedFormats.sort((a, b) => {
        const qualA = this.parseQualityNumber(a.quality);
        const qualB = this.parseQualityNumber(b.quality);
        
        switch (requestedQuality) {
          case 'worst':
          case 'low':
            return qualA - qualB;
          case 'best':
          case 'high':
            return qualB - qualA;
          default:
            const target = this.parseQualityNumber(requestedQuality);
            const diffA = Math.abs(qualA - target);
            const diffB = Math.abs(qualB - target);
            return diffA - diffB;
        }
      });
      
      return combinedFormats[0];
    }

    // Fallback: use any video format
    const videoFormats = formats.filter(f => f.type.toLowerCase().includes('video'));
    if (videoFormats.length > 0) {
      videoFormats.sort((a, b) => this.parseQualityNumber(a.quality) - this.parseQualityNumber(b.quality));
      return videoFormats[0];
    }

    return formats[0];
  }

  parseQualityNumber(qualityStr) {
    if (!qualityStr) return Infinity;
    
    const match = qualityStr.match(/(\d+)/);
    if (match) return parseInt(match[1], 10);
    
    const qualityMap = {
      'worst': 144,
      'low': 360,
      'medium': 720,
      'high': 1080,
      'best': Infinity
    };
    
    return qualityMap[qualityStr.toLowerCase()] || Infinity;
  }

  getStats() {
    const all = this.list();
    return {
      version: CONFIG.VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      downloads: {
        total: all.length,
        active: this.active,
        queued: all.filter(d => d.status === 'queued').length,
        completed: all.filter(d => d.status === 'completed').length,
        failed: all.filter(d => d.status === 'failed').length,
        paused: all.filter(d => d.status === 'paused').length,
        cancelled: all.filter(d => d.status === 'cancelled').length
      },
      lifetime: this.stats,
      maxConcurrent: CONFIG.MAX_CONCURRENT
    };
  }
}

// Initialize global store
const store = new DownloadStore();

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function isValidYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)/.test(url.trim());
}

function isValidVideoUrl(url) {
  if (!url) return false;
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/|youtube\.com\/embed\/|m\.youtube\.com)/.test(url.trim());
}

function extractVideoId(url) {
  if (!url) return null;
  
  const patterns = [
    /[?&]v=([^&]+)/,
    /youtu\.be\/([^?&]+)/,
    /\/shorts\/([^?&]+)/,
    /\/embed\/([^?&]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * EXTRACT CHANNEL ID/HANDLE from various YouTube URL formats
 * Supports:
 * - youtube.com/@handle
 * - youtube.com/c/ChannelName
 * - youtube.com/channel/UC...
 * - youtube.com/user/Username
 */
function extractChannelInfo(url) {
  if (!url) return null;
  
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    const path = urlObj.pathname;
    
    // @handle format (newest): youtube.com/@SomeChannel
    const handleMatch = path.match(/^\/@([^\/]+)/);
    if (handleMatch) {
      return { type: 'handle', id: handleMatch[1], original: url };
    }
    
    // /c/ format: youtube.com/c/ChannelName
    const cMatch = path.match(/^\/c\/([^\/]+)/i);
    if (cMatch) {
      return { type: 'custom', id: cMatch[1], original: url };
    }
    
    // /channel/ format: youtube.com/channel/UC...
    const channelMatch = path.match(/^\/channel\/(UC[^\/]+)/i);
    if (channelMatch) {
      return { type: 'channel', id: channelMatch[1], original: url };
    }
    
    // /user/ format: youtube.com/user/Username
    const userMatch = path.match(/^\/user\/([^\/]+)/i);
    if (userMatch) {
      return { type: 'user', id: userMatch[1], original: url };
    }
    
    return null;
  } catch (e) {
    return null;
  }
}

function sanitizeFilename(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200)
    .trim() || 'video';
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatNumber(num) {
  if (!num) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// =============================================================================
// CHANNEL API FUNCTIONS - Get channel info and videos
// =============================================================================

/**
 * Resolve channel ID using Invidious API
 * Invidious uses the same ID format as YouTube
 */
async function resolveChannelId(channelInfo) {
  // For handles and custom URLs, we need to search or use the ID directly
  // Invidious accepts: @handle, channel IDs, user names
  
  const searchQueries = [];
  
  if (channelInfo.type === 'handle') {
    searchQueries.push(`@${channelInfo.id}`);
  } else if (channelInfo.type === 'channel') {
    // Direct channel ID - should work directly
    return channelInfo.id;
  } else if (channelInfo.type === 'user') {
    searchQueries.push(channelInfo.id);
  } else if (channelInfo.type === 'custom') {
    searchQueries.push(channelInfo.id);
  }
  
  // Try to find channel by searching
  for (const query of searchQueries) {
    for (const apiBase of CONFIG.APIS) {
      try {
        // Try direct channel lookup first
        const channelUrl = `${apiBase}/api/v1/channels/${query}`;
        const response = await fetch(channelUrl, {
          signal: AbortSignal.timeout(CONFIG.INFO_TIMEOUT)
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.authorId) {
            return data.authorId;
          }
        }
      } catch (e) {
        continue;
      }
    }
  }
  
  // If direct lookup fails, try searching
  for (const query of searchQueries) {
    for (const apiBase of CONFIG.APIS) {
      try {
        const searchUrl = `${apiBase}/api/v1/search?q=${encodeURIComponent(query)}&type=channel`;
        const response = await fetch(searchUrl, {
          signal: AbortSignal.timeout(CONFIG.INFO_TIMEOUT)
        });
        
        if (response.ok) {
          const results = await response.json();
          if (results.length > 0 && results[0].authorId) {
            return results[0].authorId;
          }
        }
      } catch (e) {
        continue;
      }
    }
  }
  
  throw new Error(`Could not resolve channel: ${channelInfo.id}`);
}

/**
 * Get channel information
 */
async function getChannelInfo(channelUrl) {
  const channelInfo = extractChannelInfo(channelUrl);
  if (!channelInfo) throw new Error('Invalid channel URL format');
  
  // Try each API instance
  for (const apiBase of CONFIG.APIS) {
    try {
      // Build channel API URL based on type
      let channelId;
      if (channelInfo.type === 'handle') {
        channelId = `@${channelInfo.id}`;
      } else if (channelInfo.type === 'channel') {
        channelId = channelInfo.id;
      } else if (channelInfo.type === 'user') {
        channelId = channelInfo.id;
      } else {
        channelId = channelInfo.id;
      }
      
      const apiUrl = `${apiBase}/api/v1/channels/${channelId}`;
      const response = await fetch(apiUrl, {
        signal: AbortSignal.timeout(CONFIG.INFO_TIMEOUT)
      });
      
      if (response.ok) {
        const data = await response.json();
        return {
          id: data.authorId,
          name: data.author,
          avatar: data.authorThumbnails?.[2]?.url || data.authorThumbnails?.[0]?.url || '',
          banner: data.authorBanners?.[0]?.url || '',
          description: data.description || '',
          subscriberCount: data.subCount || 0,
          videoCount: data.videoCount || 0,
          viewCount: data.totalViews || 0,
          joined: data.joined || 0,
          videos: [],
          source: apiBase
        };
      }
    } catch (e) {
      console.warn(`Channel info failed on ${apiBase}:`, e.message);
      continue;
    }
  }
  
  throw new Error('Could not fetch channel info from any API');
}

/**
 * Get ALL videos from a channel (with pagination)
 */
async function getChannelVideos(channelId, page = 1, existingVideos = []) {
  const allVideos = [...existingVideos];
  
  for (const apiBase of CONFIG.APIS) {
    try {
      const apiUrl = `${apiBase}/api/v1/channels/${channelId}/videos?page=${page}`;
      const response = await fetch(apiUrl, {
        signal: AbortSignal.timeout(CONFIG.INFO_TIMEOUT)
      });
      
      if (response.ok) {
        const videos = await response.json();
        
        if (!videos || videos.length === 0) {
          return { videos: allVideos, hasMore: false, api: apiBase };
        }
        
        // Parse video data
        const parsedVideos = videos.map(v => ({
          videoId: v.videoId,
          title: v.title,
          thumbnail: v.videoThumbnails?.[2]?.url || v.videoThumbnails?.[0]?.url || 
                       `${CONFIG.YOUTUBE.THUMBNAIL}/${v.videoId}/mqdefault.jpg`,
          author: v.author,
          authorId: v.authorId,
          lengthSeconds: v.lengthSeconds,
          viewCount: v.viewCount,
          publishedText: v.publishedText,
          url: `https://www.youtube.com/watch?v=${v.videoId}`
        }));
        
        allVideos.push(...parsedVideos);
        
        // Check if we have more videos and haven't hit limit
        const hasMore = videos.length >= 30 && allVideos.length < CONFIG.MAX_CHANNEL_VIDEOS;
        
        return { 
          videos: allVideos, 
          hasMore, 
          currentPage: page,
          api: apiBase 
        };
      }
    } catch (e) {
      console.warn(`Channel videos failed on ${apiBase}:`, e.message);
      continue;
    }
  }
  
  return { videos: allVideos, hasMore: false, error: 'All APIs failed' };
}

/**
 * Fetch ALL pages of channel videos
 */
async function getAllChannelVideos(channelId) {
  let allVideos = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore && allVideos.length < CONFIG.MAX_CHANNEL_VIDEOS) {
    const result = await getChannelVideos(channelId, page, allVideos);
    allVideos = result.videos;
    hasMore = result.hasMore;
    page++;
    
    // Small delay between requests
    if (hasMore) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  return allVideos.slice(0, CONFIG.MAX_CHANNEL_VIDEOS);
}

// =============================================================================
// VIDEO INFO FUNCTIONS (for single video)
// =============================================================================

async function getVideoInfo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL: Could not extract video ID');

  // Try oEmbed first (fastest)
  try {
    const oembedUrl = `${CONFIG.YOUTUBE.OEMBED}?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CONFIG.INFO_TIMEOUT)
    });
    
    if (response.ok) {
      const data = await response.json();
      return {
        id: videoId,
        title: data.title,
        author: data.author_name,
        thumbnail: data.thumbnail_url,
        url,
        duration: null,
        source: 'oEmbed'
      };
    }
  } catch (e) {
    console.warn('oEmbed failed:', e.message);
  }

  // Fallback to Invidious
  for (const apiUrl of CONFIG.APIS) {
    try {
      const response = await fetch(`${apiUrl}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(CONFIG.INFO_TIMEOUT)
      });
      
      if (response.ok) {
        const data = await response.json();
        return {
          id: videoId,
          title: data.title,
          author: data.author,
          thumbnail: data.videoThumbnails?.[0]?.url || 
                     `${CONFIG.YOUTUBE.THUMBNAIL}/${videoId}/maxresdefault.jpg`,
          url,
          duration: parseInt(data.lengthSeconds),
          source: apiUrl
        };
      }
    } catch (e) {
      continue;
    }
  }

  return {
    id: videoId,
    title: `Video (${videoId})`,
    author: 'Unknown',
    thumbnail: `${CONFIG.YOUTUBE.THUMBNAIL}/${videoId}/maxresdefault.jpg`,
    url,
    duration: null,
    source: 'fallback'
  };
}

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({
    error: message,
    timestamp: new Date().toISOString(),
    version: CONFIG.VERSION
  }, status);
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

/**
 * STREAM VIDEO FILE - Proxy and stream actual video to client
 */
async function streamVideoFile(download) {
  if (!download) {
    return errorResponse('Download not found', 404);
  }
  
  if (download.status !== 'completed') {
    return errorResponse(`Download not ready yet (status: ${download.status})`, 400);
  }
  
  if (!download.directUrl) {
    return errorResponse('No download URL available. Please try again.', 500);
  }

  try {
    console.log(`📥 Streaming video: ${download.title}`);
    console.log(`   Source: ${download.directUrl.substring(0, 50)}...`);

    const videoResponse = await fetch(download.directUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com'
      },
      signal: AbortSignal.timeout(CONFIG.DOWNLOAD_TIMEOUT)
    });

    if (!videoResponse.ok) {
      throw new Error(`Video source returned: ${videoResponse.status} ${videoResponse.statusText}`);
    }

    const contentType = videoResponse.headers.get('content-type') || 
                       download.contentType || 
                       'video/mp4';
    const contentLength = videoResponse.headers.get('content-length');
    
    const ext = contentType.includes('mp4') ? 'mp4' : 
                 contentType.includes('webm') ? 'webm' : 
                 download.format || 'mp4';
    const filename = `${sanitizeFilename(download.title)}.${ext}`;

    console.log(`   Content-Type: ${contentType}`);
    console.log(`   Size: ${contentLength ? formatBytes(parseInt(contentLength)) : 'unknown'}`);
    console.log(`   Filename: ${filename}`);

    return new Response(videoResponse.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': contentLength || '',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'X-Content-Duration': download.duration?.toString(),
        'X-Video-Title': encodeURIComponent(download.title)
      }
    });

  } catch (error) {
    console.error('❌ Stream error:', error);
    
    let errorMessage = error.message;
    if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
      errorMessage = 'Download timed out. The video may be too large or the server is slow.';
    } else if (error.message.includes('403')) {
      errorMessage = 'Access denied. This video may be region-restricted.';
    } else if (error.message.includes('404')) {
      errorMessage = 'Video not found. It may have been deleted.';
    }
    
    return errorResponse(`Download failed: ${errorMessage}`, 500);
  }
}

// =============================================================================
// FRONTEND HTML - Beautiful UI for Channel Downloads
// =============================================================================

function getFrontendHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🎬 YouTube Channel Downloader - Download All Videos</title>
  <meta name="description" content="Download all videos from any YouTube channel for free">
  <style>
    :root{
      --primary:#667eea;--secondary:#764ba2;--success:#11998e;--danger:#eb3349;
      --warning:#f093fb;--bg:#0f0f23;--bg2:#1a1a3e;--bg3:#252550;--tx:#fff;
      --tx2:#a0aec0;--border:rgba(255,255,255,.1);--r:12px;--sh:0 4px 15px rgba(0,0,0,.3)
    }
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,var(--bg),#1a1a3e);color:var(--tx);min-height:100vh;line-height:1.6}
    .container{max-width:1100px;margin:0 auto;padding:20px}
    
    /* Header */
    .header{text-align:center;padding:40px 30px;background:var(--bg2);border-radius:var(--r);box-shadow:var(--sh);margin-bottom:25px;border:1px solid var(--border)}
    .header h1{font-size:2.5rem;background:linear-gradient(135deg,#667eea,#764ba2,#f093fb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:10px}
    .header p{color:var(--tx2);font-size:1.1rem}
    .badge{display:inline-block;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:700;margin:5px;text-transform:uppercase;letter-spacing:.5px}
    .badge-channel{background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff}
    .badge-real{background:linear-gradient(135deg,var(--success),#38ef7d);color:#fff}
    
    /* Input Section */
    .input-section{background:var(--bg2);padding:30px;border-radius:var(--r);box-shadow:var(--sh);margin-bottom:25px;border:1px solid var(--border)}
    .input-label{font-weight:600;margin-bottom:12px;color:var(--tx2);text-transform:uppercase;letter-spacing:1px;font-size:.85rem}
    .input-group{display:flex;gap:12px;flex-wrap:wrap}
    .url-input{flex:1;min-width:300px;padding:16px 20px;border:2px solid var(--border);border-radius:var(--r);background:rgba(255,255,255,.05);color:var(--tx);font-size:16px;transition:.3s}
    .url-input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 20px rgba(102,126,234,.3)}
    .btn{padding:16px 32px;border:none;border-radius:var(--r);font-size:16px;font-weight:600;cursor:pointer;transition:.3s;text-transform:uppercase;letter-spacing:1px}
    .btn-primary{background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff}
    .btn-primary:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 25px rgba(102,126,234,.4)}
    .btn-primary:disabled{opacity:.6;cursor:not-allowed}
    .btn-success{background:linear-gradient(135deg,var(--success),#38ef7d);color:#fff}
    .btn-success:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 25px rgba(17,153,142,.4)}
    .quality-select{padding:16px 20px;border:2px solid var(--border);border-radius:var(--r);background:rgba(255,255,255,.05);color:var(--tx);font-size:16px;cursor:pointer}
    
    /* Error Messages */
    .error-msg{background:rgba(235,51,73,.15);border:1px solid var(--danger);color:var(--danger);padding:14px 18px;border-radius:8px;margin-top:15px;display:none}
    .error-msg.show{display:block;animation:slideIn .3s ease}
    .success-msg{background:rgba(17,153,142,.15);border:1px solid var(--success);color:var(--success);padding:14px 18px;border-radius:8px;margin-top:15px;display:none}
    .success-msg.show{display:block;animation:slideIn .3s ease}
    @keyframes slideIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
    
    /* Channel Info Card */
    .channel-info{display:none;background:var(--bg2);border-radius:var(--r);box-shadow:var(--sh);padding:25px;margin-bottom:25px;border:1px solid var(--border);animation:fadeIn .4s ease}
    .channel-info.show{display:block}
    @keyframes fadeIn{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
    .channel-header{display:flex;align-items:center;gap:20px;margin-bottom:20px}
    .channel-avatar{width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid var(--primary)}
    .channel-details h2{font-size:1.6rem;margin-bottom:5px}
    .channel-stats{display:flex;gap:20px;flex-wrap:wrap}
    .channel-stat{text-align:center;padding:10px 20px;background:var(--bg3);border-radius:8px}
    .channel-stat-value{font-size:1.3rem;font-weight:700;color:var(--primary)}
    .channel-stat-label{font-size:.8rem;color:var(--tx2);text-transform:uppercase}
    
    /* Toolbar */
    .toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;margin-bottom:20px;padding:15px 20px;background:var(--bg3);border-radius:8px}
    .toolbar-left{display:flex;align-items:center;gap:15px}
    .toolbar-right{display:flex;gap:10px}
    .select-all{cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;color:var(--tx2)}
    .select-all input{width:18px;height:18px;accent-color:var(--primary)}
    .selected-count{color:var(--primary);font-weight:600}
    
    /* Video Grid */
    .videos-container{display:none}
    .videos-container.show{display:block}
    .videos-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
    .video-card{background:var(--bg2);border-radius:var(--r);overflow:hidden;border:1px solid var(--border);transition:.3s;position:relative}
    .video-card:hover{transform:translateY(-4px);box-shadow:0 8px 25px rgba(102,126,234,.2);border-color:var(--primary)}
    .video-card.selected{border-color:var(--success);box-shadow:0 0 0 2px rgba(17,153,142,.3)}
    .video-thumb-wrap{position:relative;aspect-ratio:16/9;overflow:hidden}
    .video-thumb{width:100%;height:100%;object-fit:cover;transition:.3s}
    .video-card:hover .video-thumb{transform:scale(1.05)}
    .video-duration{position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.85);color:#fff;padding:3px 8px;border-radius:4px;font-size:.8rem;font-weight:600}
    .video-checkbox{position:absolute;top:10px;left:10px;width:24px;height:24px;accent-color:var(--success);cursor:pointer;z-index:10}
    .video-info{padding:15px}
    .video-title{font-weight:600;font-size:.95rem;line-height:1.4;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:44px}
    .video-meta{display:flex;justify-content:space-between;font-size:.8rem;color:var(--tx2)}
    
    /* Loading */
    .loading{text-align:center;padding:60px 20px}
    .spinner{display:inline-block;width:40px;height:40px;border:4px solid rgba(255,255,255,.1);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .loading-text{margin-top:15px;color:var(--tx2)}
    
    /* Downloads Section */
    .downloads-section{background:var(--bg2);border-radius:var(--r);box-shadow:var(--sh);margin-top:25px;border:1px solid var(--border);overflow:hidden}
    .downloads-header{padding:20px 25px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
    .downloads-list{list-style:none;max-height:500px;overflow-y:auto}
    .download-item{padding:18px 25px;border-bottom:1px solid rgba(255,255,255,.03);transition:.2s}
    .download-item:hover{background:rgba(255,255,255,.02)}
    .download-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
    .download-info{flex:1;min-width:0}
    .download-title{font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .download-meta{font-size:.85rem;color:var(--tx2)}
    .status-badge{padding:4px 12px;border-radius:20px;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
    .status-queued{background:rgba(240,147,251,.2);color:var(--warning)}
    .status-downloading{background:rgba(102,126,234,.2);color:var(--primary)}
    .status-completed{background:rgba(17,153,142,.2);color:var(--success)}
    .status-failed{background:rgba(235,51,73,.2);color:var(--danger)}
    .status-cancelled{background:rgba(160,160,160,.2);color:var(--tx2)}
    .status-retrying{background:rgba(240,147,251,.2);color:var(--warning)}
    .progress-container{margin-top:10px}
    .progress-bar{height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden}
    .progress-fill{height:100%;background:linear-gradient(90deg,var(--primary),var(--secondary));border-radius:3px;transition:.3s}
    .progress-info{display:flex;justify-content:space-between;margin-top:6px;font-size:.8rem;color:var(--tx2)}
    .action-buttons{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .action-btn{padding:6px 14px;font-size:.8rem;border-radius:8px;border:1px solid currentColor;cursor:pointer;transition:.2s;background:transparent;color:inherit}
    .action-btn:hover{transform:translateY(-1px)}
    .btn-download{color:var(--success)}.btn-download:hover{background:rgba(17,153,142,.2)}
    .btn-cancel{color:var(--danger)}.btn-cancel:hover{background:rgba(235,51,73,.2)}
    .btn-retry{color:var(--primary)}.btn-retry:hover{background:rgba(102,126,234,.2)}
    .btn-remove{color:var(--tx2)}.btn-remove:hover{background:rgba(160,160,160,.2)}
    
    /* Empty State */
    .empty-state{text-align:center;padding:50px 20px;color:var(--tx2)}
    .empty-icon{font-size:3rem;margin-bottom:15px;opacity:.5}
    
    /* Stats Bar */
    .stats-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:15px;margin-bottom:25px}
    .stat-card{background:var(--bg2);padding:18px;border-radius:var(--r);text-align:center;box-shadow:var(--sh);border:1px solid var(--border)}
    .stat-value{font-size:1.8rem;font-weight:700;background:linear-gradient(135deg,var(--primary),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .stat-label{font-size:.8rem;color:var(--tx2);margin-top:5px;text-transform:uppercase}
    
    /* Responsive */
    @media(max-width:768px){
      .header h1{font-size:1.8rem}.input-group{flex-direction:column}.url-input{min-width:100%}
      .channel-header{flex-direction:column;text-align:center}.channel-avatar{width:60px;height:60px}
      .videos-grid{grid-template-columns:1fr}.toolbar{flex-direction:column;text-align:center}
    }
  </style>
</head>
<body>
<div class="container">
  <!-- Header -->
  <header class="header">
    <h1>🎬 YouTube Channel Downloader</h1>
    <p>Paste a channel URL & download ALL videos at once</p>
    <span class="badge badge-channel">v${CONFIG.VERSION}</span>
    <span class="badge badge-real">✓ Real Downloads</span>
  </header>

  <!-- Input Section -->
  <section class="input-section">
    <div class="input-label">📺 Enter YouTube Channel URL</div>
    <div class="input-group">
      <input type="url" class="url-input" id="channelInput" placeholder="youtube.com/@channelName OR youtube.com/c/ChannelName OR youtube.com/channel/UC..." autocomplete="off">
      <select class="quality-select" id="qualitySelect">
        <option value="low">360p (Fast)</option>
        <option value="medium" selected>720p (Recommended)</option>
        <option value="high">1080p (HD)</option>
        <option value="audio-m4a">🎵 Audio Only</option>
      </select>
      <button class="btn btn-primary" id="fetchBtn" onclick="fetchChannel()">🔍 Load Channel</button>
    </div>
    <div class="error-msg" id="errorMsg"></div>
    <div class="success-msg" id="successMsg"></div>
  </section>

  <!-- Channel Info (shown after fetch) -->
  <section class="channel-info" id="channelInfo">
    <div class="channel-header">
      <img class="channel-avatar" id="channelAvatar" alt="" onerror="this.style.display='none'">
      <div class="channel-details">
        <h2 id="channelName">Channel Name</h2>
        <div style="color:var(--tx2)" id="channelDesc"></div>
      </div>
    </div>
    <div class="channel-stats">
      <div class="channel-stat"><div class="channel-stat-value" id="subCount">-</div><div class="channel-stat-label">Subscribers</div></div>
      <div class="channel-stat"><div class="channel-stat-value" id="videoCount">-</div><div class="channel-stat-label">Videos</div></div>
      <div class="channel-stat"><div class="channel-stat-value" id="viewCount">-</div><div class="channel-stat-label">Total Views</div></div>
    </div>
  </section>

  <!-- Videos Container -->
  <section class="videos-container" id="videosContainer">
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="select-all">
          <input type="checkbox" id="selectAll" onchange="toggleSelectAll()">
          <span>Select All (<span id="totalVideos">0</span>)</span>
        </label>
        <span class="selected-count"><span id="selectedCount">0</span> selected</span>
      </div>
      <div class="toolbar-right">
        <button class="btn btn-success" onclick="downloadSelected()" id="downloadSelectedBtn" disabled>⬇️ Download Selected</button>
      </div>
    </div>
    <div class="videos-grid" id="videosGrid"></div>
  </section>

  <!-- Loading State -->
  <div class="loading" id="loadingState" style="display:none">
    <div class="spinner"></div>
    <div class="loading-text" id="loadingText">Fetching channel...</div>
  </div>

  <!-- Stats -->
  <section class="stats-bar" id="statsBar" style="display:none">
    <div class="stat-card"><div class="stat-value" id="statTotal">0</div><div class="stat-label">Total</div></div>
    <div class="stat-card"><div class="stat-value" id="statActive">0</div><div class="stat-label">Active</div></div>
    <div class="stat-card"><div class="stat-value" id="statCompleted">0</div><div class="stat-label">Done</div></div>
    <div class="stat-card"><div class="stat-value" id="statFailed">0</div><div class="stat-label">Failed</div></div>
  </section>

  <!-- Downloads List -->
  <section class="downloads-section" id="downloadsSection" style="display:none">
    <div class="downloads-header">
      <span style="font-size:1.2rem;font-weight:600">📥 Download Queue</span>
      <button class="action-btn btn-remove" onclick="clearCompleted()">Clear Done</button>
    </div>
    <ul class="downloads-list" id="downloadsList">
      <li class="empty-state">
        <div class="empty-icon">📭</div>
        <p>No downloads yet</p>
      </li>
    </ul>
  </section>
</div>

<script>
let channelVideos=[];
let selectedVideos=new Set();

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('channelInput').addEventListener('keypress',e=>{
    if(e.key==='Enter')fetchChannel();
  });
});

// ========== CHANNEL FUNCTIONS ==========

async function fetchChannel(){
  const url=document.getElementById('channelInput').value.trim();
  const btn=document.getElementById('fetchBtn');
  
  if(!url)return showError('Please enter a YouTube channel URL');
  if(!isValidChannelUrl(url))return showError('Invalid YouTube channel URL. Use @handle, /c/, /channel/, or /user/ format');
  
  btn.disabled=true;
  btn.innerHTML='<span class="spinner"></span>';
  hideMessages();
  showLoading(true,'Resolving channel...');
  hideChannelInfo();
  hideVideos();
  
  try{
    // Step 1: Get channel info
    showLoading(true,'Fetching channel info...');
    const infoRes=await api('/api/channel/info',{url});
    if(!infoRes.ok)throw new Error(infoRes.error||'Failed to fetch channel');
    
    const channel=infoRes.data;
    showChannelInfo(channel);
    
    // Step 2: Get all videos
    showLoading(true,'Loading '+(channel.videoCount||'all')+' videos...');
    const videosRes=await api('/api/channel/videos',{channelId:channel.id});
    if(!videosRes.ok)throw new Error(videosRes.error||'Failed to fetch videos');
    
    channelVideos=videosRes.videos||[];
    showVideos(channelVideos);
    showSuccess('Loaded '+channelVideos.length+' videos from '+channel.name);
    document.getElementById('statsBar').style.display='grid';
    
  }catch(e){
    showError(e.message||'An error occurred');
  }finally{
    btn.disabled=false;
    btn.innerHTML='🔍 Load Channel';
    showLoading(false);
  }
}

function isValidChannelUrl(u){
  return u.includes('youtube.com/@')||u.includes('youtube.com/c/')||
         u.includes('youtube.com/channel/')||u.includes('youtube.com/user/');
}

function showChannelInfo(c){
  document.getElementById('channelAvatar').src=c.avatar||'';
  document.getElementById('channelName').textContent=c.name||'Unknown Channel';
  document.getElementById('channelDesc').textContent=(c.description||'').substring(0,150)+(c.description&&c.description.length>150?'...':'');
  document.getElementById('subCount').textContent=formatNum(c.subscriberCount);
  document.getElementById('videoCount').textContent=formatNum(c.videoCount);
  document.getElementById('viewCount').textContent=formatNum(c.viewCount);
  document.getElementById('channelInfo').classList.add('show');
}

function hideChannelInfo(){
  document.getElementById('channelInfo').classList.remove('show');
}

function showVideos(videos){
  const grid=document.getElementById('videosGrid');
  document.getElementById('totalVideos').textContent=videos.length;
  
  grid.innerHTML=videos.map((v,i)=>'<div class="video-card" id="card-'+i+'">'+
    '<input type="checkbox" class="video-checkbox" value="'+i+'" onchange="toggleVideo('+i+')">'+
    '<div class="video-thumb-wrap">'+
      '<img class="video-thumb" src="'+esc(v.thumbnail)+'" alt="" loading="lazy" onerror="this.src=\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 320 180%22><rect fill=%22%23252550%22 width=%22320%22 height=%22180%22/><text fill=%22%23666%22 x=%2250%%22 y=%2250%%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22>No Image</text></svg>\'">'+
      '<span class="video-duration">'+fmtTime(v.lengthSeconds)+'</span>'+
    '</div>'+
    '<div class="video-info">'+
      '<div class="video-title">'+esc(v.title)+'</div>'+
      '<div class="video-meta">'+
        '<span>'+formatNum(v.viewCount)+' views</span>'+
        '<span>'+esc(v.publishedText)+'</span>'+
      '</div>'+
    '</div>'+
  '</div>').join('');
  
  document.getElementById('videosContainer').classList.add('show');
}

function hideVideos(){
  document.getElementById('videosContainer').classList.remove('show');
  channelVideos=[];
  selectedVideos.clear();
  updateSelectedCount();
}

function toggleVideo(index){
  if(selectedVideos.has(index)){
    selectedVideos.delete(index);
    document.getElementById('card-'+index).classList.remove('selected');
  }else{
    selectedVideos.add(index);
    document.getElementById('card-'+index).classList.add('selected');
  }
  updateSelectedCount();
}

function toggleSelectAll(){
  const checked=document.getElementById('selectAll').checked;
  channelVideos.forEach((_,i)=>{
    if(checked){
      selectedVideos.add(i);
      document.getElementById('card-'+i)?.classList.add('selected');
    }else{
      selectedVideos.delete(i);
      document.getElementById('card-'+i)?.classList.remove('selected');
    }
  });
  updateSelectedCount();
}

function updateSelectedCount(){
  document.getElementById('selectedCount').textContent=selectedVideos.size;
  document.getElementById('downloadSelectedBtn').disabled=selectedVideos.size===0;
  document.getElementById('selectAll').checked=selectedVideos.size===channelVideos.length&&channelVideos.length>0;
}

// ========== DOWNLOAD FUNCTIONS ==========

async function downloadSelected(){
  if(selectedVideos.size===0)return;
  
  const quality=document.getElementById('qualitySelect').value;
  const btn=document.getElementById('downloadSelectedBtn');
  const videosToDownload=[...selectedVideos].map(i=>channelVideos[i]).filter(Boolean);
  
  btn.disabled=true;
  btn.innerHTML='<span class="spinner"></span> Starting...';
  hideMessages();
  document.getElementById('downloadsSection').style.display='block';
  
  let success=0;
  let failed=0;
  
  for(const video of videosToDownload){
    try{
      const res=await api('/api/download',{
        url:video.url,
        q:quality,
        t:video.title,
        th:video.thumbnail,
        a:video.author,
        d:video.lengthSeconds,
        f:quality.includes('audio')?'m4a':'mp4'
      });
      
      if(res.success||res.ok)success++;
      else failed++;
    }catch(e){
      failed++;
    }
  }
  
  showSuccess('Queued '+success+' videos for download'+(failed>0?' ('+failed+' failed)':''));
  btn.disabled=false;
  btn.innerHTML='⬇️ Download Selected';
  
  // Start refreshing download list
  if(typeof refreshInterval!=='undefined')clearInterval(refreshInterval);
  refreshList();
  refreshInterval=setInterval(refreshList,3000);
}

// ========== DOWNLOAD LIST FUNCTIONS ==========

let refreshInterval=null;

async function refreshList(){
  try{
    const response=await fetch('/api/list');
    const data=await response.json();
    renderDownloads(data.downloads||[]);
    updateStats(data.stats||{});
    if(data.downloads&&data.downloads.length>0){
      document.getElementById('downloadsSection').style.display='block';
    }
  }catch(e){}
}

function renderDownloads(downloads){
  const list=document.getElementById('downloadsList');
  
  if(!downloads.length){
    list.innerHTML='<li class="empty-state"><div class="empty-icon">📭</div><p>No active downloads</p></li>';
    return;
  }
  
  list.innerHTML=downloads.map(d=>{
    const isActive=['downloading','queued','retrying'].includes(d.status);
    const isComplete=d.status==='completed'&&d.directUrl;
    
    return '<li class="download-item" id="dl-'+d.id+'">'+
      '<div class="download-header">'+
        '<div class="download-info">'+
          '<div class="download-title">'+esc(d.title)+'</div>'+
          '<div class="download-meta">'+(d.author||'')+' • '+timeAgo(d.createdAt)+'</div>'+
        '</div>'+
        '<span class="status-badge status-'+d.status+'">'+d.status+'</span>'+
      '</div>'+
      
      (isActive?
        '<div class="progress-container">'+
          '<div class="progress-bar"><div class="progress-fill" style="width:'+(d.progress||0)+'%"></div></div>'+
          '<div class="progress-info">'+
            '<span>'+(d.progress||0)+'%</span>'+
            '<span>'+(d.speed||'')+'</span>'+
            '<span>'+(d.eta||'')+'</span>'+
          '</div>'+
        '</div>'
      :'')+
      
      (d.error?'<div style="color:var(--danger);font-size:.85rem;margin-top:8px">❌ '+esc(d.error)+'</div>':'')+
      
      '<div class="action-buttons">'+
        (isComplete?
          '<a href="/api/download-file/'+d.id+'" class="action-btn btn-download" target="_blank">💾 Download File</a>'+
          '<button class="action-btn btn-remove" onclick="sendAction(\'/api/cancel/'+d.id+'\')">Remove</a>'
        :'')+
        
        (isActive?
          '<button class="action-btn btn-cancel" onclick="sendAction(\'/api/cancel/'+d.id+'\')">Cancel</button>'
        :'')+
        
        (d.status==='failed'?
          '<button class="action-btn btn-retry" onclick="sendAction(\'/api/retry/'+d.id+'\')">Retry</button>'
        :'')+
        
        (['cancelled','failed'].includes(d.status)&&!isComplete?
          '<button class="action-btn btn-remove" onclick="sendAction(\'/api/cancel/'+d.id+'\')">Remove</button>'
        :'')+
      '</div>'+
    '</li>';
  }).join('');
}

function updateStats(s){
  document.getElementById('statTotal').textContent=s.total||0;
  document.getElementById('statActive').textContent=(s.active||0)+(s.queued||0);
  document.getElementById('statCompleted').textContent=s.completed||0;
  document.getElementById('statFailed').textContent=s.failed||0;
}

async function sendAction(url){
  try{
    await fetch(url,{method:'POST'});
    refreshList();
  }catch(e){}
}

async function clearCompleted(){
  try{
    await fetch('/api/clear',{method:'DELETE'});
    refreshList();
  }catch(e){}
}

// ========== UTILITY FUNCTIONS ==========

async function api(endpoint,body){
  const response=await fetch(endpoint,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  return response.json();
}

function showLoading(show,text){
  document.getElementById('loadingState').style.display=show?'block':'none';
  if(text)document.getElementById('loadingText').textContent=text;
}

function showError(m){
  document.getElementById('errorMsg').textContent=m;
  document.getElementById('errorMsg').classList.add('show');
}

function showSuccess(m){
  document.getElementById('successMsg').textContent=m;
  document.getElementById('successMsg').classList.add('show');
}

function hideMessages(){
  document.getElementById('errorMsg').classList.remove('show');
  document.getElementById('successMsg').classList.remove('show');
}

function formatNum(n){
  if(!n)return'0';
  if(n>=1000000)return(n/1000000).toFixed(1)+'M';
  if(n>=1000)return(n/1000).toFixed(1)+'K';
  return n.toString();
}

function fmtTime(s){
  if(!s)return'--:--';
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  return h?h+':'+m.toString().padStart(2,'0')+':'+sec.toString().padStart(2,'0'):m+':'+sec.toString().padStart(2,'0');
}

function timeAgo(t){
  if(!t)return'';
  const d=Date.now()-t,m=Math.floor(d/60000);
  return m<1?'Just now':m<60?m+'m ago':Math.floor(m/60)<24?Math.floor(m/60)+'h ago':Math.floor(m/86400)+'d ago';
}

function esc(t){
  const d=document.createElement('div');
  d.textContent=t;
  return d.innerHTML;
}
</script>
</body></html>`;
}

// =============================================================================
// MAIN WORKER HANDLER
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse();
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      console.log(`📥 [${new Date().toISOString()}] ${request.method} ${pathname}`);

      // Serve frontend
      if (pathname === '/') {
        return new Response(getFrontendHTML(), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }

      // Health check endpoint
      if (pathname === '/api/health') {
        return jsonResponse({
          status: 'ok',
          version: CONFIG.VERSION,
          timestamp: new Date().toISOString(),
          uptime: Math.floor((Date.now() - store.startTime) / 1000),
          stats: store.getStats()
        });
      }

      // ===========================
      // CHANNEL ENDPOINTS
      // ===========================

      // Get channel info
      if (pathname === '/api/channel/info') {
        const { url: channelUrl } = await request.json();
        if (!channelUrl) return errorResponse('Channel URL is required');
        
        const channelInfo = extractChannelInfo(channelUrl);
        if (!channelInfo) return errorResponse('Invalid channel URL format. Use: @handle, /c/, /channel/, or /user/');
        
        const info = await getChannelInfo(channelUrl);
        return jsonResponse({ ok: true, data: info });
      }

      // Get all videos from channel
      if (pathname === '/api/channel/videos') {
        const { channelId } = await request.json();
        if (!channelId) return errorResponse('Channel ID is required');
        
        const videos = await getAllChannelVideos(channelId);
        return jsonResponse({ 
          ok: true, 
          videos, 
          count: videos.length,
          message: `Found ${videos.length} videos`
        });
      }

      // ===========================
      // VIDEO ENDPOINTS
      // ===========================

      // Get video information
      if (pathname === '/api/info') {
        const { url: videoUrl } = await request.json();
        if (!videoUrl) return errorResponse('URL is required');
        if (!isValidYouTubeUrl(videoUrl)) return errorResponse('Invalid YouTube URL');
        
        const info = await getVideoInfo(videoUrl);
        return jsonResponse({ ok: true, data: info });
      }

      // Start download (prepare/get direct URL)
      if (pathname === '/api/download') {
        const { url: videoUrl, q, t, th, a, d, f, cookie } = await request.json();
        
        if (!videoUrl) return errorResponse('URL is required');
        if (!isValidYouTubeUrl(videoUrl)) return errorResponse('Invalid YouTube URL');

        // Check for duplicate active downloads
        if (store.list({ status: 'downloading' }).find(x => x.url === videoUrl)) {
          return errorResponse('This video is already being prepared', 409);
        }

        // Create new download entry
        const dl = store.create(videoUrl, {
          quality: q || 'medium',
          format: f || 'mp4',
          title: t,
          thumbnail: th,
          author: a,
          duration: d,
          cookie
        });

        // Fetch metadata in background if not provided
        if (!t || !th) {
          ctx.waitUntil(
            getVideoInfo(videoUrl)
              .then(info => {
                store.update(dl.id, {
                  title: info.title,
                  thumbnail: info.thumbnail,
                  author: info.author,
                  duration: info.duration
                });
              })
              .catch(err => console.warn('Background metadata fetch failed:', err.message))
          );
        }

        console.log(`✅ Download created: ${dl.id} for ${videoUrl}`);

        return jsonResponse({
          success: true,
          data: {
            id: dl.id,
            status: dl.status,
            position: store.queue.indexOf(dl.id) + 1
          }
        });
      }

      // STREAM VIDEO FILE - This is the real download!
      if (pathname.startsWith('/api/download-file/')) {
        const id = pathname.split('/').pop();
        const dl = store.get(id);
        
        console.log(`📥 Download file requested: ${id}`);
        
        return streamVideoFile(dl);
      }

      // Get single download status
      if (pathname.startsWith('/api/status/')) {
        const id = pathname.split('/').pop();
        const dl = store.get(id);
        if (!dl) return errorResponse('Download not found', 404);
        return jsonResponse({ ok: true, data: dl });
      }

      // Cancel or pause download
      if (pathname.startsWith('/api/cancel/')) {
        const id = pathname.split('/').pop();
        const body = request.method === 'POST' 
          ? await request.json().catch(() => ({})) 
          : {};
        
        // Check for pause/toggle action
        if (body.action === 'pause' || body.action === 'toggle') {
          const result = store.togglePause(id);
          if (!result.ok) return errorResponse(result.reason, 400);
          return jsonResponse({ ok: true, data: result.download });
        }

        // Default: cancel
        const result = store.cancel(id);
        if (!result.ok) return errorResponse(result.reason, 400);
        return jsonResponse({ ok: true, data: result.download });
      }

      // Retry failed download
      if (pathname.startsWith('/api/retry/')) {
        const id = pathname.split('/').pop();
        const result = store.retry(id);
        if (!result.ok) return errorResponse(result.reason, 400);
        return jsonResponse({ ok: true, data: result.download });
      }

      // List all downloads
      if (pathname === '/api/list') {
        const downloads = store.list();
        const stats = store.getStats();
        return jsonResponse({
          ok: true,
          data: downloads,
          stats: stats.downloads,
          info: {
            version: CONFIG.VERSION,
            maxConcurrent: CONFIG.MAX_CONCURRENT
          }
        });
      }

      // Clear completed downloads
      if (pathname === '/api/clear') {
        const cleared = store.clearCompleted();
        return jsonResponse({
          ok: true,
          cleared,
          message: `Cleared ${cleared} item(s)`
        });
      }

      // 404 for unknown routes
      return errorResponse('Not Found', 404);

    } catch (error) {
      console.error('❌ Worker error:', error);
      return errorResponse(`Internal Server Error: ${error.message}`, 500);
    }
  }
};
