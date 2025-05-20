import fs from 'fs/promises'; // Changed from readFile to fs for readdir and stat
import { NextResponse } from 'next/server';
import path from 'path';

// Define the expected request body structure
interface LoadContextRequest {
  paths?: string[];
  directoryPaths?: string[];
  extensions?: string[]; // Optional: list of extensions to filter by
}

// Helper function to recursively get all file paths in a directory
async function getAllFilePaths(
  dirPath: string,
  baseDir: string = dirPath,
  extensions?: string[],
): Promise<string[]> {
  let files: string[] = [];
  const items = await fs.readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      files = files.concat(
        await getAllFilePaths(fullPath, baseDir, extensions),
      );
    } else {
      const relativeFilePath = path.relative(baseDir, fullPath);
      if (extensions && extensions.length > 0) {
        if (extensions.some((ext) => relativeFilePath.endsWith(ext))) {
          files.push(relativeFilePath);
        }
      } else {
        // If no extensions filter, include all files
        files.push(relativeFilePath);
      }
    }
  }
  return files;
}

export async function POST(req: Request) {
  try {
    const body: LoadContextRequest = await req.json();
    const requestedFilePaths = body.paths || [];
    const requestedDirectoryPaths = body.directoryPaths || [];
    const filterExtensions = body.extensions || [];

    if (
      requestedFilePaths.length === 0 &&
      requestedDirectoryPaths.length === 0
    ) {
      return NextResponse.json(
        {
          error:
            'Invalid request: "paths" or "directoryPaths" array is required.',
        },
        { status: 400 },
      );
    }

    let combinedContext = '';
    const errors: string[] = [];
    const allFilePathsToLoad: {
      absolutePath: string;
      relativePathLabel: string;
    }[] = [];

    // Process individual file paths
    for (const relativePath of requestedFilePaths) {
      const absolutePath = path.resolve(process.cwd(), relativePath);
      // Apply extension filter for explicitly listed paths
      if (
        filterExtensions.length > 0 &&
        !filterExtensions.some((ext) => relativePath.endsWith(ext))
      ) {
        continue; // Skip if extension doesn't match
      }
      allFilePathsToLoad.push({
        absolutePath,
        relativePathLabel: relativePath,
      });
    }

    // Process directory paths
    for (const dirRelativePath of requestedDirectoryPaths) {
      const dirAbsolutePath = path.resolve(process.cwd(), dirRelativePath);
      // Removed security check: if (!dirAbsolutePath.startsWith(process.cwd())) ...
      try {
        console.log(
          `Listing files in directory: ${dirAbsolutePath} with extensions: ${filterExtensions.join(', ')}`,
        );
        // Get file paths relative to the directory itself, applying extension filter
        const filesInDir = await getAllFilePaths(
          dirAbsolutePath,
          dirAbsolutePath,
          filterExtensions,
        );
        for (const fileInDir of filesInDir) {
          // fileInDir is already relative to dirAbsolutePath and filtered by extension
          // Construct the full absolute path for reading
          // And the full relative path (from project root) for labeling
          const fullAbsolutePathForFile = path.join(dirAbsolutePath, fileInDir);
          const fullRelativePathForLabel = path.join(
            dirRelativePath,
            fileInDir,
          );
          allFilePathsToLoad.push({
            absolutePath: fullAbsolutePathForFile,
            relativePathLabel: fullRelativePathForLabel,
          });
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(
          `Error listing directory ${dirRelativePath}:`,
          errorMessage,
        );
        errors.push(
          `Failed to list directory ${dirRelativePath}: ${errorMessage}`,
        );
      }
    }

    // Deduplicate file paths in case a file is both explicitly listed and in a directory
    const uniqueFilePathsToLoad = Array.from(
      new Set(allFilePathsToLoad.map((p) => p.absolutePath)),
    ).map((absPath) => {
      return allFilePathsToLoad.find((p) => p.absolutePath === absPath)!;
    });

    for (const { absolutePath, relativePathLabel } of uniqueFilePathsToLoad) {
      try {
        console.log(
          `Reading file for context: ${absolutePath} (Label: ${relativePathLabel})`,
        );
        const content = await fs.readFile(absolutePath, 'utf-8');
        combinedContext += `--- START FILE: ${relativePathLabel} ---\n\n${content}\n\n--- END FILE: ${relativePathLabel} ---\n\n`;
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`Error reading file ${relativePathLabel}:`, errorMessage);
        errors.push(`Failed to load ${relativePathLabel}: ${errorMessage}`);
      }
    }

    if (errors.length > 0 && !combinedContext) {
      return NextResponse.json(
        {
          error: `Failed to load any context files. Errors: ${errors.join(', ')}`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      context: combinedContext || 'No content loaded.',
      ...(errors.length > 0 && { loadErrors: errors }),
    });
  } catch (error: unknown) {
    console.error('[Load Context API Error]', error);
    const errorMessage =
      error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
