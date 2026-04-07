import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Scan all user file directories and delete files older than
 * config.fileCleanupHours hours (based on mtime).
 */
async function cleanOldFiles(): Promise<void> {
  const usersDir = join(config.dataDir, 'users');

  let userDirs: string[];
  try {
    userDirs = await readdir(usersDir);
  } catch {
    // No users directory yet — nothing to clean
    return;
  }

  const maxAgeMs = config.fileCleanupHours * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;

  for (const userDir of userDirs) {
    const filesDir = join(usersDir, userDir, 'files');

    let entries: string[];
    try {
      entries = await readdir(filesDir);
    } catch {
      continue; // No files dir for this user
    }

    for (const entry of entries) {
      const filePath = join(filesDir, entry);
      try {
        const s = await stat(filePath);
        if (!s.isFile()) continue;
        if (now - s.mtimeMs > maxAgeMs) {
          await unlink(filePath);
          deleted++;
          log('debug', 'Cleaned old file', { userDir, file: entry });
        }
      } catch {
        // Skip unreadable / already-deleted files
      }
    }
  }

  if (deleted > 0) {
    log('info', 'File cleanup complete', { deleted });
  }
}

/**
 * Start the periodic file cleanup timer.
 * Runs every hour.
 * @returns The interval handle — pass to stopFileCleanup() to cancel.
 */
export function startFileCleanup(): NodeJS.Timeout {
  log('info', 'File cleanup scheduled', { intervalHours: 1, maxAgeHours: config.fileCleanupHours });
  // Run immediately on start, then every hour
  cleanOldFiles().catch((err) => {
    log('error', 'File cleanup error', { error: err instanceof Error ? err.message : String(err) });
  });
  return setInterval(() => {
    cleanOldFiles().catch((err) => {
      log('error', 'File cleanup error', { error: err instanceof Error ? err.message : String(err) });
    });
  }, 60 * 60 * 1000);
}

/**
 * Stop the periodic file cleanup timer.
 */
export function stopFileCleanup(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}

// Exported for testing
export { cleanOldFiles as _cleanOldFiles };
