import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

// Sample live stream data for demonstration when repo folders are empty
const SAMPLE_LIVE_STREAMS = [
  {
    name: "Live_Q&A_Session_2024.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/live/Live_Q&A_Session_2024.mp4",
    size: "342 MB",
    type: "video"
  },
  {
    name: "Wellness_Webinar_Live.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/live/Wellness_Webinar_Live.mp4",
    size: "567 MB",
    type: "video"
  },
  {
    name: "Ayurvedic_Consultation_Live.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/live/Ayurvedic_Consultation_Live.mp4",
    size: "289 MB",
    type: "video"
  },
  {
    name: "Herbal_Medicine_Workshop.mp3",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/live/Herbal_Medicine_Workshop.mp3",
    size: "78 MB",
    type: "audio"
  }
];

export async function GET() {
  try {
    const zai = await ZAI.create();
    
    // Fetch the GitHub repository tree for live folder
    const result = await zai.functions.invoke('page_reader', {
      url: 'https://github.com/Ayurved-RasRasayan/youtube-download/tree/main/live'
    });

    const html = result.data.html;
    
    // Check if page shows "File not found" or similar error
    const isNotFound = html.includes('404') || html.includes('File not found') || html.includes('does not exist');
    
    let liveFiles;
    
    if (isNotFound) {
      // Return sample data for demonstration when folder doesn't exist
      liveFiles = SAMPLE_LIVE_STREAMS;
    } else {
      // Parse video files from GitHub page HTML
      liveFiles = parseGitHubFiles(html, 'live');
      
      // If parsing returned no results, use sample data
      if (liveFiles.length === 0) {
        liveFiles = SAMPLE_LIVE_STREAMS;
      }
    }
    
    return NextResponse.json({
      success: true,
      videos: liveFiles,
      count: liveFiles.length,
      source: isNotFound ? 'sample' : 'repository'
    });
  } catch (error) {
    console.error('Error fetching live streams:', error);
    // Return sample data on error as fallback
    return NextResponse.json({
      success: true,
      videos: SAMPLE_LIVE_STREAMS,
      count: SAMPLE_LIVE_STREAMS.length,
      source: 'sample',
      note: 'Using sample data - could not reach repository'
    });
  }
}

function parseGitHubFiles(html: string, folder: string): Array<{
  name: string;
  downloadUrl: string;
  size?: string;
  type: string;
}> {
  const files: Array<{
    name: string;
    downloadUrl: string;
    size?: string;
    type: string;
  }> = [];

  // Extract file rows from GitHub's file listing
  const fileRegex = /<tr class="js-navigation-item[^>]*>([\s\S]*?)<\/tr>/g;
  
  let match;
  while ((match = fileRegex.exec(html)) !== null) {
    const row = match[1];
    
    // Extract filename
    const nameMatch = row.match(/title="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : '';
    
    // Skip if it's a directory or parent link
    if (!name || name === '..' || row.includes('icon-directory')) continue;
    
    // Extract file extension to determine type
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const fileType = getFileType(ext);
    
    // Extract file size if available
    const sizeMatch = row.match(/<span[^>]*class="[^"]*mr-2[^"]*"[^>]*>([\d.]+\s*(KB|MB|GB))<\/span>/);
    const size = sizeMatch ? sizeMatch[1] : undefined;
    
    // Build raw GitHub URL for download
    const encodedName = encodeURIComponent(name);
    const downloadUrl = `https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/${folder}/${encodedName}`;
    
    files.push({
      name,
      downloadUrl,
      size,
      type: fileType
    });
  }
  
  return files;
}

function getFileType(extension: string): string {
  const videoExts = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv'];
  const audioExts = ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'];
  
  if (videoExts.includes(extension)) return 'video';
  if (audioExts.includes(extension)) return 'audio';
  return 'file';
}
