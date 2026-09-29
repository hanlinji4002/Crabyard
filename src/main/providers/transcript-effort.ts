import * as fs from 'fs';
import { isClaudeEffortLevel, type ClaudeEffortLevel } from '../../shared/effort';

/**
 * Effort of the newest main-thread assistant record among the complete lines of
 * `text`: the level the conversation last actually ran at. Claude Code stamps
 * every assistant record with the request's effort (`"effort":"max"`); it never
 * restores a session's effort from it on `-r`.
 */
export function lastEffortInText(text: string, firstLineIsPartial: boolean): ClaudeEffortLevel | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= (firstLineIsPartial ? 1 : 0); i--) {
    const line = lines[i];
    if (!line.includes('"type":"assistant"') || !line.includes('"effort":"')) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; } // partial write at a live tail
    if (e.type !== 'assistant' || e.isSidechain === true || e.isApiErrorMessage === true) continue;
    if (isClaudeEffortLevel(e.effort)) return e.effort;
  }
  return undefined;
}

/** Last effort recorded in a transcript, reading only its tail (synchronously; ~1ms on a 77MB file). */
export function readLastTranscriptEffort(filePath: string, maxBytes = 8 * 1024 * 1024): ClaudeEffortLevel | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    for (let window = 256 * 1024; ; window *= 4) {
      const len = Math.min(window, size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const found = lastEffortInText(buf.toString('utf8'), len < size);
      if (found || len >= size || len >= maxBytes) return found;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}
