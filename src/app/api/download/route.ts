import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { files, folder } = body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No files specified for download' },
        { status: 400 }
      );
    }

    // Generate download URLs for each file
    const downloadLinks = files.map((fileName: string) => {
      const encodedName = encodeURIComponent(fileName);
      return {
        name: fileName,
        url: `https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/${folder || 'videos'}/${encodedName}`
      };
    });

    return NextResponse.json({
      success: true,
      downloads: downloadLinks,
      message: `Prepared ${downloadLinks.length} file(s) for download`
    });
  } catch (error) {
    console.error('Error preparing downloads:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to prepare downloads' },
      { status: 500 }
    );
  }
}

// Handle single file download with redirect
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fileName = searchParams.get('file');
    const folder = searchParams.get('folder') || 'videos';

    if (!fileName) {
      return NextResponse.json(
        { success: false, error: 'File name is required' },
        { status: 400 }
      );
    }

    // Build raw GitHub URL
    const encodedName = encodeURIComponent(fileName);
    const downloadUrl = `https://raw.githubusercontent.com/Ayurved-RasRasayan/youtube-download/main/${folder}/${encodedName}`;

    // Redirect to the actual file URL for browser download
    return NextResponse.redirect(downloadUrl);
  } catch (error) {
    console.error('Error redirecting to download:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to initiate download' },
      { status: 500 }
    );
  }
}
