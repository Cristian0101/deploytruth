import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Write JSON through a unique temp file, fsync, then atomic rename. */
export const writeFileAtomic = async (filePath: string, contents: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
};
