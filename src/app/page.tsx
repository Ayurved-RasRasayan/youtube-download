'use client';

import { useState, useEffect, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { 
  Download, 
  Film, 
  Radio, 
  CheckSquare, 
  Loader2,
  FolderOpen,
  ExternalLink,
  FileVideo,
  FileAudio,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
  Search,
  Clock,
  Eye
} from 'lucide-react';

// Types matching Express backend API
interface Video {
  id: string;
  title: string;
  duration: string;
  views: string;
  viewCount: number;
  publishedAt: string;
  isLive: boolean;
  isNew: boolean;
  url: string;
  thumbnail: string;
}

interface Channel {
  id: string;
  name: string;
  url: string;
  avatar: string;
  videos: Video[];
  liveVideos: Video[];
  lastChecked: string;
  newVideoCount: number;
}

interface DownloadJob {
  id: string;
  videoId: string;
  title: string;
  status: 'pending' | 'downloading' | 'completed' | 'error' | 'cancelled';
  progress: number;
  speed?: string;
  eta?: string;
  error?: string;
}

interface ServerHealth {
  status: string;
  ytDlpInstalled: boolean;
  channels: number;
  activeDownloads: number;
  downloadsDir: string;
}

export default function Home() {
  // State management
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [channelInput, setChannelInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  
  // Selection state
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [selectedLive, setSelectedLive] = useState<Set<string>>(new Set());
  
  // Download state
  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [batchProgress, setBatchProgress] = useState(0);
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);

  // Check server health on mount
  useEffect(() => {
    checkServerHealth();
    const interval = setInterval(checkServerHealth, 30000); // Every 30s
    return () => clearInterval(interval);
  }, []);

  // Poll for download updates
  useEffect(() => {
    if (downloads.some(d => d.status === 'downloading')) {
      const interval = setInterval(fetchDownloads, 2000);
      return () => clearInterval(interval);
    }
  }, [downloads]);

  const checkServerHealth = async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        setServerHealth(data);
        setIsOnline(true);
      } else {
        setIsOnline(false);
      }
    } catch (error) {
      console.error('Health check failed:', error);
      setIsOnline(false);
    }
  };

  const fetchDownloads = async () => {
    try {
      const res = await fetch('/api/downloads');
      if (res.ok) {
        const data = await res.json();
        setDownloads(data.downloads || []);
      }
    } catch (error) {
      console.error('Failed to fetch downloads:', error);
    }
  };

  // Add channel
  const addChannel = async () => {
    if (!channelInput.trim()) return;
    
    setLoading(true);
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: channelInput.trim() })
      });
      
      if (res.ok) {
        const newChannel = await res.json();
        setChannels(prev => [...prev, newChannel]);
        setActiveChannel(newChannel);
        setChannelInput('');
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to add channel');
      }
    } catch (error) {
      alert('Error adding channel: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Refresh channel
  const refreshChannel = async (channelId: string) => {
    try {
      const res = await fetch(`/api/channels/${channelId}/refresh`, {
        method: 'POST'
      });
      
      if (res.ok) {
        const updatedChannel = await res.json();
        setChannels(prev => prev.map(c => c.id === channelId ? updatedChannel : c));
        if (activeChannel?.id === channelId) {
          setActiveChannel(updatedChannel);
        }
      }
    } catch (error) {
      console.error('Refresh failed:', error);
    }
  };

  // Delete channel
  const deleteChannel = async (channelId: string) => {
    try {
      await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
      setChannels(prev => prev.filter(c => c.id !== channelId));
      if (activeChannel?.id === channelId) {
        setActiveChannel(null);
      }
    } catch (error) {
      console.error('Delete failed:', error);
    }
  };

  // Download single video
  const downloadVideo = async (video: Video, isLive: boolean = false) => {
    if (!activeChannel) return;

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: video.id,
          title: video.title,
          channelId: activeChannel.id,
          quality: 'best',
          format: 'mp4'
        })
      });

      if (res.ok) {
        const job = await res.json();
        setDownloads(prev => [...prev, job]);
        // Start polling
        fetchDownloads();
      }
    } catch (error) {
      console.error('Download failed:', error);
    }
  };

  // Batch download selected videos
  const batchDownload = async (videos: Video[], isLive: boolean = false) => {
    const selected = isLive ? selectedLive : selectedVideos;
    if (selected.size === 0 || !activeChannel) return;

    setIsBatchDownloading(true);
    setBatchProgress(0);

    const videosToDownload = videos.filter(v => selected.has(v.id));
    
    for (let i = 0; i < videosToDownload.length; i++) {
      await downloadVideo(videosToDownload[i], isLive);
      setBatchProgress(((i + 1) / videosToDownload.length) * 100);
      await new Promise(r => setTimeout(r, 500)); // Delay between downloads
    }

    setIsBatchDownloading(false);
    setTimeout(() => {
      setBatchProgress(0);
      if (isLive) setSelectedLive(new Set());
      else setSelectedVideos(new Set());
    }, 3000);
  };

  // Toggle selection
  const toggleSelection = (videoId: string, isLive: boolean) => {
    if (isLive) {
      setSelectedLive(prev => {
        const next = new Set(prev);
        if (next.has(videoId)) next.delete(videoId);
        else next.add(videoId);
        return next;
      });
    } else {
      setSelectedVideos(prev => {
        const next = new Set(prev);
        if (next.has(videoId)) next.delete(videoId);
        else next.add(videoId);
        return next;
      });
    }
  };

  // Select all
  const selectAll = (videos: Video[], isLive: boolean) => {
    if (isLive) setSelectedLive(new Set(videos.map(v => v.id)));
    else setSelectedVideos(new Set(videos.map(v => v.id)));
  };

  // Get download status for a video
  const getDownloadStatus = (videoId: string): DownloadJob | undefined => {
    return downloads.find(d => d.videoId === videoId);
  };

  // Render video list
  const renderVideoList = (videos: Video[], isLive: boolean, selected: Set<string>) => {
    if (!activeChannel) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Search className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">No Channel Selected</p>
          <p className="text-sm mt-2">Add a YouTube channel above to get started</p>
        </div>
      );
    }

    if (videos.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <FolderOpen className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">No {isLive ? 'Live Streams' : 'Videos'} Found</p>
          <p className="text-sm mt-2">This channel has no {isLive ? 'live streams' : 'videos'} yet</p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {/* Selection controls */}
        <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg">
          <Checkbox
            checked={selected.size === videos.length && videos.length > 0}
            onCheckedChange={(checked) => checked && selectAll(videos, isLive)}
          />
          <span className="text-sm font-medium">
            Select All ({selected.size}/{videos.length})
          </span>
          
          <Button
            size="sm"
            disabled={selected.size === 0 || isBatchDownloading}
            onClick={() => batchDownload(videos, isLive)}
            className="ml-auto"
          >
            {isBatchDownloading ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin />Downloading...</>
            ) : (
              <><Download className="h-4 w-4 mr-2" />Download Selected ({selected.size})</>
            )}
          </Button>
        </div>

        {/* Batch progress */}
        {isBatchDownloading && (
          <Progress value={batchProgress} className="h-2" />
        )}

        {/* Video cards */}
        <ScrollArea className="max-h-[600px] rounded-md border">
          <div className="p-3 space-y-3">
            {videos.map((video) => {
              const download = getDownloadStatus(video.id);
              const isSelected = selected.has(video.id);
              
              return (
                <div
                  key={video.id}
                  className={`flex gap-4 p-4 rounded-lg border transition-all hover:bg-muted/50 ${
                    isSelected ? 'bg-primary/5 border-primary/30' : 'bg-card'
                  }`}
                >
                  {/* Thumbnail */}
                  <div className="relative flex-shrink-0 w-32 h-20 rounded-md overflow-hidden bg-muted">
                    <img
                      src={video.thumbnail}
                      alt={video.title}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = '/placeholder.png';
                      }}
                    />
                    {video.isNew && (
                      <Badge className="absolute top-1 left-1 text-xs bg-red-500">NEW</Badge>
                    )}
                    <span className="absolute bottom-1 right-1 text-xs bg-black/80 px-1 rounded">
                      {video.duration}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelection(video.id, isLive)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-sm line-clamp-2">{video.title}</h4>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Eye className="h-3 w-3" />{video.views}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(video.publishedAt).toLocaleDateString()}
                          </span>
                          {video.isLive && (
                            <Badge variant="outline" className="text-xs text-red-500">LIVE</Badge>
                          )}
                        </div>
                        
                        {/* Download progress */}
                        {download?.status === 'downloading' && (
                          <div className="mt-2 space-y-1">
                            <Progress value={download.progress} className="h-1.5" />
                            <p className="text-xs text-muted-foreground">
                              {download.progress}% • {download.speed || ''} {download.eta ? `• ETA: ${download.eta}` : ''}
                            </p>
                          </div>
                        )}
                        
                        {download?.status === 'completed' && (
                          <Badge variant="secondary" className="mt-2 bg-green-100 text-green-700">
                            <CheckSquare className="h-3 w-3 mr-1" />Completed
                          </Badge>
                        )}
                        
                        {download?.status === 'error' && (
                          <Badge variant="destructive" className="mt-2">
                            Error: {download.error}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => downloadVideo(video, isLive)}
                      disabled={download?.status === 'downloading'}
                    >
                      {download?.status === 'downloading' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={video.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Film className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold">YouTube Downloader</h1>
                <p className="text-xs text-muted-foreground">
                  {isOnline ? (
                    <span className="flex items-center gap-1 text-green-600">
                      <Wifi className="h-3 w-3" /> Connected to server
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-red-500">
                      <WifiOff className="h-3 w-3" /> Server offline
                    </span>
                  )}
                </p>
              </div>
            </div>
            
            {serverHealth && (
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{serverHealth.channels} channels</span>
                <span>{serverHealth.activeDownloads} downloading</span>
                <Badge variant={serverHealth.ytDlpInstalled ? "secondary" : "destructive"}>
                  yt-dlp: {serverHealth.ytDlpInstalled ? '✓' : '✗'}
                </Badge>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Add Channel Section */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex gap-3">
              <Input
                placeholder="Paste YouTube channel URL (@handle, /c/, /channel/, /user/)..."
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addChannel()}
                className="flex-1"
              />
              <Button onClick={addChannel} disabled={loading || !channelInput.trim()}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add Channel
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Channels List & Content */}
        <div className="grid lg:grid-cols-4 gap-6">
          {/* Sidebar - Channels */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  Channels ({channels.length})
                  {activeChannel && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => refreshChannel(activeChannel.id)}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[500px]">
                  <div className="space-y-1 p-2">
                    {channels.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No channels added yet
                      </p>
                    ) : (
                      channels.map((channel) => (
                        <button
                          key={channel.id}
                          onClick={() => setActiveChannel(channel)}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors ${
                            activeChannel?.id === channel.id
                              ? 'bg-primary/10 border border-primary/20'
                              : 'hover:bg-muted'
                          }`}
                        >
                          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center font-bold text-primary">
                            {channel.avatar}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm truncate">{channel.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {channel.videos.length} videos • {channel.liveVideos.length} live
                              {channel.newVideoCount > 0 && (
                                <Badge className="ml-1 text-xs bg-red-500">+{channel.newVideoCount}</Badge>
                              )}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteChannel(channel.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </button>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Main Content - Videos/Live */}
          <div className="lg:col-span-3">
            {activeChannel ? (
              <Tabs defaultValue="videos">
                <TabsList className="grid w-full max-w-md grid-cols-2">
                  <TabsTrigger value="videos" className="flex items-center gap-2">
                    <Film className="h-4 w-4" />
                    Videos
                    <Badge variant="secondary">{activeChannel.videos.length}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="live" className="flex items-center gap-2">
                    <Radio className="h-4 w-4" />
                    Live Streams
                    <Badge variant="secondary">{activeChannel.liveVideos.length}</Badge>
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="videos" className="mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Videos</CardTitle>
                      <CardDescription>
                        {activeChannel.videos.length} videos from {activeChannel.name}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {renderVideoList(activeChannel.videos, false, selectedVideos)}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="live" className="mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Live Streams</CardTitle>
                      <CardDescription>
                        {activeChannel.liveVideos.length} live streams from {activeChannel.name}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {renderVideoList(activeChannel.liveVideos, true, selectedLive)}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            ) : (
              <Card>
                <CardContent className="py-16">
                  <div className="flex flex-col items-center justify-center text-center">
                    <Film className="h-16 w-16 text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-semibold mb-2">Select or Add a Channel</h3>
                    <p className="text-muted-foreground max-w-sm">
                      Add a YouTube channel URL above to browse and download videos. 
                      Videos will be organized into Videos and Live Streams automatically.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Active Downloads */}
        {downloads.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Download className="h-5 w-5" />
                Active Downloads ({downloads.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {downloads.map((job) => (
                  <div key={job.id} className="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{job.title}</p>
                      {job.status === 'downloading' && (
                        <div className="mt-2 space-y-1">
                          <Progress value={job.progress} className="h-2" />
                          <p className="text-xs text-muted-foreground">
                            {job.progress}% • {job.speed || ''} {job.eta ? `• ETA: ${job.eta}` : ''}
                          </p>
                        </div>
                      )}
                    </div>
                    <Badge 
                      variant={
                        job.status === 'completed' ? 'secondary' :
                        job.status === 'error' ? 'destructive' : 'outline'
                      }
                    >
                      {job.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t mt-8">
        <div className="container mx-auto px-4 py-4 text-center text-sm text-muted-foreground">
          <p>
            Powered by{' '}
            <a 
              href="https://github.com/Ayurved-RasRasayan/youtube-download" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Ayurved-RasRasayan/youtube-download
            </a>
            {' '}• Built with Next.js 16
          </p>
        </div>
      </footer>
    </div>
  );
}
