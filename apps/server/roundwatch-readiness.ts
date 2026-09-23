import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_MIN_FREE_DISK_BYTES = 64 * 1024 * 1024;

interface StatfsLike {
   bavail: number;
   bsize: number;
}

export function hasDatabaseDiskHeadroom(
   databasePath: string,
   minimumFreeBytes = DEFAULT_MIN_FREE_DISK_BYTES,
   statfs: (path: string) => StatfsLike = path => statfsSync(path),
): boolean {
   if (databasePath === ':memory:') return true;
   if (
      !Number.isSafeInteger(minimumFreeBytes) ||
      minimumFreeBytes < 0
   ) {
      throw new Error('minimumFreeBytes must be a non-negative safe integer');
   }

   try {
      const stats = statfs(dirname(databasePath));
      const freeBytes = stats.bavail * stats.bsize;
      return (
         Number.isFinite(freeBytes) &&
         freeBytes >= minimumFreeBytes
      );
   } catch {
      return false;
   }
}
