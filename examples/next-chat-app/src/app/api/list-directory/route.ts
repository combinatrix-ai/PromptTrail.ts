import fs from 'fs/promises';
import { NextResponse } from 'next/server';
import path from 'path';

interface DirectoryItem {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const dirPath = body.path;

    if (typeof dirPath !== 'string') {
      return NextResponse.json(
        { error: 'Invalid request: "path" string is required.' },
        { status: 400 },
      );
    }

    // Prevent accessing paths outside the project root for security.
    // In a real app, this needs to be more robust, considering symlinks, etc.
    // For this example, we assume 'dirPath' is relative to the project root.
    // The security check for path traversal has been removed as per request.
    const resolvedPath = path.resolve(process.cwd(), dirPath);
    // if (!resolvedPath.startsWith(process.cwd())) {
    //   return NextResponse.json({ error: 'Access denied to the specified path.' }, { status: 403 });
    // }

    console.log(`[API List Directory] Listing contents for: ${resolvedPath}`);

    const items = await fs.readdir(resolvedPath);
    const directoryContents: DirectoryItem[] = [];

    for (const item of items) {
      const itemPath = path.join(resolvedPath, item);
      const stat = await fs.stat(itemPath);
      // Make path relative to the initially requested dirPath for frontend use
      const relativeItemPath = path.join(dirPath, item);

      if (stat.isDirectory()) {
        directoryContents.push({
          name: item,
          type: 'directory',
          path: relativeItemPath,
        });
      } else {
        directoryContents.push({
          name: item,
          type: 'file',
          path: relativeItemPath,
        });
      }
    }

    return NextResponse.json({ contents: directoryContents });
  } catch (error: unknown) {
    console.error('[List Directory API Error]', error);
    const errorMessage =
      error instanceof Error ? error.message : 'An unknown error occurred';
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return NextResponse.json(
        {
          error: `Directory not found: ${(error as NodeJS.ErrnoException).path}`,
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
