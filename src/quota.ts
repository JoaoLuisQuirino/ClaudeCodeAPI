import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from './errors.js';
import { config } from './config.js';

export interface DiskUsage {
  totalBytes: number;
  fileCount: number;
}

/**
 * Calculate total disk usage for a user's files directory.
 */
export async function getUserDiskUsage(filesDir: string): Promise<DiskUsage> {
  let entries: string[];
  try {
    entries = await readdir(filesDir);
  } catch {
    return { totalBytes: 0, fileCount: 0 };
  }

  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    try {
      const s = await stat(join(filesDir, entry));
      if (s.isFile()) {
        totalBytes += s.size;
        fileCount++;
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { totalBytes, fileCount };
}

/**
 * Check whether adding `additionalBytes` would exceed the user's disk quota.
 * Throws BadRequestError if over limit.
 */
export async function checkQuota(filesDir: string, additionalBytes: number): Promise<void> {
  const usage = await getUserDiskUsage(filesDir);
  const projected = usage.totalBytes + additionalBytes;
  if (projected > config.maxUserDiskBytes) {
    const usedMB = Math.round(usage.totalBytes / (1024 * 1024));
    const maxMB = Math.round(config.maxUserDiskBytes / (1024 * 1024));
    throw new BadRequestError(
      `Disk quota exceeded: ${usedMB}MB used of ${maxMB}MB limit. Delete files to free space.`,
    );
  }
}
