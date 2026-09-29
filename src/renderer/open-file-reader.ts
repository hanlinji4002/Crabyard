import { appState } from './state.js';
import { resolveProjectFilePath } from './state/specialized-sessions.js';
import { t } from './i18n.js';

/**
 * Open a path in a file-reader tab, but only once the path is known to be an
 * openable file. `projectId` must be the active project — a row rendered for a
 * project the user has since left is dropped rather than opened.
 *
 * Checking first is load-bearing, not defensive: `addFileReaderSession` appends
 * the new tab and makes it active *before* anything touches the filesystem, so
 * a dead path spawns a tab that `loadFile`'s `closeSessionIfFileMissing` tears
 * down a moment later — and `removeSession` then falls back to the left
 * neighbour by index, not to the tab the user came from. The user sees a tab
 * flash and lands somewhere arbitrary.
 *
 * `exists` is also true for a directory, whose read fails with EISDIR; that tab
 * is never reaped (the path really is there) and sticks around permanently
 * showing "Failed to load file".
 *
 * Failures are console-only, matching every other silent-open path in the
 * renderer — and this never rejects, so callers can fire it off with a bare
 * `void` instead of each repeating the same `.catch`.
 */
export async function openFileReaderChecked(
  projectId: string,
  filePath: string,
  lineNumber?: number,
  /** Tab name instead of the file name, e.g. for a conversation view. */
  name?: string,
): Promise<void> {
  const project = appState.activeProject;
  if (project?.id !== projectId) {
    console.warn(`[open-file] ${projectId} is not the active project: ${filePath}`);
    return;
  }

  const fullPath = resolveProjectFilePath(project, filePath);

  try {
    const [exists, isDir] = await Promise.all([
      window.vibeyard.fs.exists(fullPath),
      window.vibeyard.fs.isDirectory(fullPath),
    ]);
    if (!exists || isDir) {
      console.warn(`[open-file] not an openable file: ${fullPath}`);
      return;
    }
  } catch (err: unknown) {
    // An invoke rejects when the window is tearing down mid-click.
    console.warn(`[open-file] could not check ${fullPath}`, err);
    return;
  }

  // Re-check after the await: the user may have switched projects while the IPC
  // was in flight, and appending to the one they left would silently steal its
  // tab selection.
  if (appState.activeProject?.id !== projectId) {
    console.warn(`[open-file] active project changed mid-lookup, dropping ${fullPath}`);
    return;
  }

  appState.addFileReaderSession(projectId, fullPath, lineNumber, name);
}

/** Open a Claude Code conversation's transcript as the typeset conversation view (排版视图). */
export function openConversationView(projectId: string, transcriptPath: string, title: string): void {
  void openFileReaderChecked(projectId, transcriptPath, undefined, t('preview.tabName', { title: title || t('conversations.untitled') }));
}

/**
 * Open a tab's own conversation in the typeset view. False while there is
 * nothing to show yet: the CLI writes its transcript with the first message.
 */
export async function openSessionTypesetView(projectId: string, sessionId: string): Promise<boolean> {
  const session = appState.projects.find((p) => p.id === projectId)?.sessions.find((s) => s.id === sessionId);
  const transcript = session?.cliSessionId
    ? await window.vibeyard.claudeHistory.transcriptPath(session.cliSessionId).catch(() => null)
    : null;
  if (!session || !transcript) return false;
  openConversationView(projectId, transcript, session.name);
  return true;
}
