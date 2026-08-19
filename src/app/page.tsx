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
import { 
  Download, 
  Film, 
  Radio, 
  CheckSquare, 
  Square, 
  Loader2,
  FolderOpen,
  ExternalLink,
  FileVideo,
  FileAudio
} from 'lucide-react';

interface VideoFile {
  name: string;
  downloadUrl: string;
  size?: string;
  type: string;
}

interface DownloadState {
  [key: string]: 'idle' | 'downloading' | 'completed' | 'error';
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<'videos' | 'live'>('videos');
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [liveStreams, setLiveStreams] = useState<VideoFile[]>([]);
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [selectedLive, setSelectedLive] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<{ videos: boolean; live: boolean }>({
    videos: true,
    live: true
  });
  const [downloadStates, setDownloadStates] = useState<DownloadState>({});
  const [batchProgress, setBatchProgress] = useState<number>(0);
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  const [dataSource, setDataSource] = useState<{ videos: string; live: string }>({
    videos: 'loading',
    live: 'loading'
  });

  // Fetch videos from API
  const fetchVideos = useCallback(async () => {
    setLoading(prev => ({ ...prev, videos: true }));
    try {
      const response = await fetch('/api/videos');
      const data = await response.json();
      if (data.success) {
        setVideos(data.videos);
        setDataSource(prev => ({ ...prev, videos: data.source || 'repository' }));
      }
    } catch (error) {
      console.error('Error fetching videos:', error);
    } finally {
      setLoading(prev => ({ ...prev, videos: false }));
    }
  }, []);

  // Fetch live streams from API
  const fetchLiveStreams = useCallback(async () => {
    setLoading(prev => ({ ...prev, live: true }));
    try {
      const response = await fetch('/api/live');
      const data = await response.json();
      if (data.success) {
        setLiveStreams(data.videos);
        setDataSource(prev => ({ ...prev, live: data.source || 'repository' }));
      }
    } catch (error) {
      console.error('Error fetching live streams:', error);
    } finally {
      setLoading(prev => ({ ...prev, live: false }));
    }
  }, []);

  // Load data on mount
  useEffect(() => {
    fetchVideos();
    fetchLiveStreams();
  }, [fetchVideos, fetchLiveStreams]);

  // Toggle file selection
  const toggleSelection = (fileName: string, type: 'videos' | 'live') => {
    if (type === 'videos') {
      setSelectedVideos(prev => {
        const newSet = new Set(prev);
        if (newSet.has(fileName)) {
          newSet.delete(fileName);
        } else {
          newSet.add(fileName);
        }
        return newSet;
      });
    } else {
      setSelectedLive(prev => {
        const newSet = new Set(prev);
        if (newSet.has(fileName)) {
          newSet.delete(fileName);
        } else {
          newSet.add(fileName);
        }
        return newSet;
      });
    }
  };

  // Select all files
  const selectAll = (type: 'videos' | 'live') => {
    const fileList = type === 'videos' ? videos : liveStreams;
    if (type === 'videos') {
      setSelectedVideos(new Set(fileList.map(f => f.name)));
    } else {
      setSelectedLive(new Set(fileList.map(f => f.name)));
    }
  };

  // Deselect all files
  const deselectAll = (type: 'videos' | 'live') => {
    if (type === 'videos') {
      setSelectedVideos(new Set());
    } else {
      setSelectedLive(new Set());
    }
  };

  // Download single file
  const downloadSingle = async (file: VideoFile, folder: string) => {
    setDownloadStates(prev => ({ ...prev, [file.name]: 'downloading' }));
    
    try {
      // Create a temporary anchor element to trigger download
      const link = document.createElement('a');
      link.href = file.downloadUrl;
      link.download = file.name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      
      // Trigger download
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Simulate completion after a short delay
      setTimeout(() => {
        setDownloadStates(prev => ({ ...prev, [file.name]: 'completed' }));
        setTimeout(() => {
          setDownloadStates(prev => ({ ...prev, [file.name]: 'idle' }));
        }, 2000);
      }, 1000);
    } catch (error) {
      console.error('Download failed:', error);
      setDownloadStates(prev => ({ ...prev, [file.name]: 'error' }));
      setTimeout(() => {
        setDownloadStates(prev => ({ ...prev, [file.name]: 'idle' }));
      }, 3000);
    }
  };

  // Batch download selected files
  const batchDownload = async (type: 'videos' | 'live') => {
    const selectedFiles = type === 'videos' ? selectedVideos : selectedLive;
    const fileList = type === 'videos' ? videos : liveStreams;
    
    if (selectedFiles.size === 0) return;

    setIsBatchDownloading(true);
    setBatchProgress(0);

    const filesToDownload = fileList.filter(f => selectedFiles.has(f.name));
    let completed = 0;

    for (const file of filesToDownload) {
      setDownloadStates(prev => ({ ...prev, [file.name]: 'downloading' }));
      
      try {
        // Create download link
        const link = document.createElement('a');
        link.href = file.downloadUrl;
        link.download = file.name;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        setDownloadStates(prev => ({ ...prev, [file.name]: 'completed' }));
      } catch (error) {
        console.error(`Failed to download ${file.name}:`, error);
        setDownloadStates(prev => ({ ...prev, [file.name]: 'error' }));
      }

      completed++;
      setBatchProgress((completed / filesToDownload.length) * 100);
      
      // Small delay between downloads to prevent browser blocking
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    setIsBatchDownloading(false);
    
    // Reset states after completion
    setTimeout(() => {
      setDownloadStates({});
      setBatchProgress(0);
      if (type === 'videos') {
        setSelectedVideos(new Set());
      } else {
        setSelectedLive(new Set());
      }
    }, 3000);
  };

  // Get file icon based on type
  const getFileIcon = (type: string) => {
    switch (type) {
      case 'video':
        return <FileVideo className="h-4 w-4 text-red-500" />;
      case 'audio':
        return <FileAudio className="h-4 w-4 text-green-500" />;
      default:
        return <FolderOpen className="h-4 w-4 text-blue-500" />;
    }
  };

  // Get download status badge
  const getStatusBadge = (fileName: string) => {
    const state = downloadStates[fileName];
    switch (state) {
      case 'downloading':
        return <Badge variant="secondary" className="bg-blue-100 text-blue-700"><Loader2 className="h-3 w-3 animate-spin mr-1" />Downloading</Badge>;
      case 'completed':
        return <Badge variant="secondary" className="bg-green-100 text-green-700"><CheckSquare className="h-3 w-3 mr-1" />Done</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      default:
        return null;
    }
  };

  // Render file list
  const renderFileList = (
    files: VideoFile[], 
    type: 'videos' | 'live', 
    selected: Set<string>,
    onSelect: (name: string) => void
  ) => {
    if (loading[type]) {
      return (
        <div className="flex flex-col items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
          <p className="text-muted-foreground">Loading {type}...</p>
        </div>
      );
    }

    if (files.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12">
          <FolderOpen className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium text-muted-foreground">No files found</p>
          <p className="text-sm text-muted-foreground mt-2">
            No {type} available in this repository
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {/* Selection controls */}
        <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg mb-4">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={selected.size === files.length && files.length > 0}
              onCheckedChange={(checked) => {
                if (checked) selectAll(type);
                else deselectAll(type);
              }}
            />
            <span className="text-sm font-medium">
              Select All ({selected.size}/{files.length})
            </span>
          </div>
          
          <Button
            size="sm"
            disabled={selected.size === 0 || isBatchDownloading}
            onClick={() => batchDownload(type)}
            className="ml-auto"
          >
            {isBatchDownloading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Downloading...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Download Selected ({selected.size})
              </>
            )}
          </Button>
        </div>

        {/* Batch progress */}
        {isBatchDownloading && (
          <div className="mb-4">
            <Progress value={batchProgress} className="h-2" />
            <p className="text-xs text-muted-foreground mt-1 text-center">
              {Math.round(batchProgress)}% complete
            </p>
          </div>
        )}

        {/* File list */}
        <ScrollArea className="max-h-[500px] rounded-md border">
          <div className="p-2">
            {files.map((file) => (
              <div
                key={file.name}
                className={`flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors ${
                  selected.has(file.name) ? 'bg-primary/5 border border-primary/20' : ''
                }`}
              >
                {/* Checkbox */}
                <Checkbox
                  checked={selected.has(file.name)}
                  onCheckedChange={() => toggleSelection(file.name, type)}
                />

                {/* File icon and info */}
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {getFileIcon(file.type)}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate text-sm">{file.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {file.size && (
                        <span className="text-xs text-muted-foreground">{file.size}</span>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {file.type.toUpperCase()}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Status badge */}
                <div className="mr-2">
                  {getStatusBadge(file.name)}
                </div>

                {/* Download button */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadSingle(file, type)}
                  disabled={downloadStates[file.name] === 'downloading'}
                >
                  {downloadStates[file.name] === 'downloading' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </Button>

                {/* External link */}
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                >
                  <a
                    href={file.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open in new tab"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Film className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">YouTube Download Browser</h1>
                <p className="text-sm text-muted-foreground">
                  Browse and download videos from Ayurved-RasRasayan/youtube-download repository
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="container mx-auto px-4 py-8">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'videos' | 'live')}>
          <TabsList className="grid w-full max-w-md mx-auto grid-cols-2">
            <TabsTrigger value="videos" className="flex items-center gap-2">
              <Film className="h-4 w-4" />
              Videos
              {videos.length > 0 && (
                <Badge variant="secondary" className="ml-1">{videos.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="live" className="flex items-center gap-2">
              <Radio className="h-4 w-4" />
              Live Streams
              {liveStreams.length > 0 && (
                <Badge variant="secondary" className="ml-1">{liveStreams.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="videos" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Film className="h-5 w-5 text-red-500" />
                    Videos Folder
                    {dataSource.videos === 'sample' && (
                      <Badge variant="outline" className="ml-2 bg-amber-50 text-amber-700 border-amber-200">
                        Sample Data
                      </Badge>
                    )}
                  </CardTitle>
                  <Badge variant="secondary">{videos.length} files</Badge>
                </div>
                <CardDescription>
                  Browse and download video files from the repository&apos;s videos directory.
                  Files will be saved to your default Downloads folder.
                  {dataSource.videos === 'sample' && (
                    <span className="block mt-2 text-xs text-amber-600 bg-amber-50 p-2 rounded">
                      Showing sample data - the videos folder may not exist in the repository yet.
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {renderFileList(videos, 'videos', selectedVideos, (name) => toggleSelection(name, 'videos'))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="live" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Radio className="h-5 w-5 text-red-500" />
                    Live Streams Folder
                    {dataSource.live === 'sample' && (
                      <Badge variant="outline" className="ml-2 bg-amber-50 text-amber-700 border-amber-200">
                        Sample Data
                      </Badge>
                    )}
                  </CardTitle>
                  <Badge variant="secondary">{liveStreams.length} files</Badge>
                </div>
                <CardDescription>
                  Browse and download live stream recordings from the repository&apos;s live directory.
                  Files will be saved to your default Downloads folder.
                  {dataSource.live === 'sample' && (
                    <span className="block mt-2 text-xs text-amber-600 bg-amber-50 p-2 rounded">
                      Showing sample data - the live folder may not exist in the repository yet.
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {renderFileList(liveStreams, 'live', selectedLive, (name) => toggleSelection(name, 'live'))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Info section */}
        <Card className="mt-8 bg-muted/30">
          <CardHeader>
            <CardTitle className="text-lg">How to Use</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <div className="flex items-center gap-2 font-medium">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">1</span>
                  Browse Files
                </div>
                <p className="text-sm text-muted-foreground">
                  Switch between Videos and Live Streams tabs to view all available files in each category.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 font-medium">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">2</span>
                  Select Files
                </div>
                <p className="text-sm text-muted-foreground">
                  Use checkboxes to select individual files or click &quot;Select All&quot; to choose multiple files at once.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 font-medium">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">3</span>
                  Download
                </div>
                <p className="text-sm text-muted-foreground">
                  Click the download button on individual files or use &quot;Download Selected&quot; for batch downloads.
                </p>
              </div>
            </div>
            
            <Separator className="my-4" />
            
            <div className="bg-blue-50 dark:bg-blue-950/20 p-4 rounded-lg">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                <strong>Note:</strong> Files are downloaded directly from GitHub. Your browser will save them to your default Downloads folder automatically.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Footer */}
      <footer className="border-t mt-auto">
        <div className="container mx-auto px-4 py-4">
          <p className="text-center text-sm text-muted-foreground">
            Data source:{' '}
            <a
              href="https://github.com/Ayurved-RasRasayan/youtube-download"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Ayurved-RasRasayan/youtube-download
            </a>
            {' '}on GitHub
          </p>
        </div>
      </footer>
    </div>
  );
}
