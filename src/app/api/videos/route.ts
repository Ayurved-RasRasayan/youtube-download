import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

// Sample video data for demonstration when repo folders are empty
const SAMPLE_VIDEOS = [
  {
    name: "Introduction_to_Ayurveda.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/videos/Introduction_to_Ayurveda.mp4",
    size: "125 MB",
    type: "video"
  },
  {
    name: "Herbal_Remedies_Guide.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/videos/Herbal_Remedies_Guide.mp4",
    size: "98 MB",
    type: "video"
  },
  {
    name: "Daily_Health_Tips.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/videos/Daily_Health_Tips.mp4",
    size: "156 MB",
    type: "video"
  },
  {
    name: "Meditation_Basics.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/videos/Meditation_Basics.mp4",
    size: "87 MB",
    type: "video"
  },
  {
    name: "Yoga_for_Beginners.mp4",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/videos/Yoga_for_Beginners.mp4",
    size: "203 MB",
    type: "video"
  },
  {
    name: "Nutrition_Workshop.mp3",
    downloadUrl: "https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/videos/Nutrition_Workshop.mp3",
    size: "45 MB",
    type: "audio"
  }
];

export async function GET(request: NextRequest) {
  try {
    const zai = await ZAI.create();
    
    // Fetch the GitHub repository tree for videos folder
    const result = await zai.functions.invoke('page_reader', {
      url: 'https://github.com/Ayurved-RasRasayan/youtube-download/tree/main/videos'
    });

    const html = result.data.html;
    
    // Check if page shows "File not found" or similar error
    const isNotFound = html.includes('404') || html.includes('File not found') || html.includes('does not exist');
    
    let videoFiles;
    
    if (isNotFound) {
      // Return sample data for demonstration when folder doesn't exist
      videoFiles = SAMPLE_VIDEOS;
    } else {
      // Parse video files from GitHub page HTML
      videoFiles = parseGitHubFiles(html, 'videos');
      
      // If parsing returned no results, use sample data
      if (videoFiles.length === 0) {
        videoFiles = SAMPLE_VIDEOS;
      }
    }
    
    return NextResponse.json({
      success: true,
      videos: videoFiles,
      count: videoFiles.length,
      source: isNotFound ? 'sample' : 'repository'
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    // Return sample data on error as fallback
    return NextResponse.json({
      success: true,
      videos: SAMPLE_VIDEOS,
      count: SAMPLE_VIDEOS.length,
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
