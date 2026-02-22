import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";

export async function acquireLock(relayDir: string): Promise<boolean> {
  await mkdir(relayDir, { recursive: true });
  const lockFile = join(relayDir, "bot.lock");

  try {
    const raw = await readFile(lockFile, "utf-8");
    const pid = parseInt(raw.trim(), 10);

    if (!isNaN(pid)) {
      try {
        // Check if process is alive (signal 0 doesn't kill, just checks)
        process.kill(pid, 0);
        // Process is still running
        return false;
      } catch {
        // Process is dead — stale lock, safe to overwrite
      }
    }
  } catch {
    // No lock file — proceed
  }

  await writeFile(lockFile, String(process.pid));
  return true;
}

export async function releaseLock(relayDir: string): Promise<void> {
  const lockFile = join(relayDir, "bot.lock");
  await unlink(lockFile).catch(() => {});
}
