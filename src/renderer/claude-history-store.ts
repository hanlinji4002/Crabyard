import type { ClaudeConversation, ClaudeUsageReport } from '../shared/types.js';

// Renderer-side cache for the sidebar's 对话 and Usage views. The main process
// keeps per-transcript digests keyed by mtime, so refreshing is cheap after the
// first scan; this module only de-duplicates in-flight requests and fans out
// change notifications.

type Listener = () => void;

let conversations: ClaudeConversation[] | null = null;
let usage: ClaudeUsageReport | null = null;
let listPromise: Promise<void> | null = null;
let usagePromise: Promise<void> | null = null;
let listError = false;
let usageError = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function onClaudeHistoryChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getConversations(): ClaudeConversation[] | null {
  return conversations;
}

export function getUsageReport(): ClaudeUsageReport | null {
  return usage;
}

export function isConversationsLoading(): boolean {
  return listPromise !== null;
}

export function isUsageLoading(): boolean {
  return usagePromise !== null;
}

export function conversationsFailed(): boolean {
  return listError;
}

export function usageFailed(): boolean {
  return usageError;
}

function conversationsSignature(list: ClaudeConversation[]): string {
  return list.map((c) => `${c.cliSessionId}|${c.updatedAt}|${c.turns}|${c.title}|${c.cwdExists}|${c.background?.live ? 1 : 0}`).join('\n');
}

/**
 * Re-fetch the conversation list. Background refreshes only notify listeners
 * when something changed, so periodic polling doesn't rebuild the sidebar;
 * `force` (the refresh button) also notifies at start so the UI can show progress.
 * `rescan` skips main's reuse of a scan from the last few seconds, quietly: for
 * when a new transcript is known to be there.
 */
export function refreshConversations(force = false, rescan = force): Promise<void> {
  if (listPromise) return listPromise;
  const before = conversations ? conversationsSignature(conversations) : null;
  const errorBefore = listError;
  listPromise = window.vibeyard.claudeHistory.list(rescan)
    .then((res) => {
      conversations = res.conversations;
      listError = false;
    })
    .catch(() => {
      listError = true;
    })
    .finally(() => {
      listPromise = null;
      const after = conversations ? conversationsSignature(conversations) : null;
      if (force || after !== before || listError !== errorBefore) emit();
    });
  if (force) emit();
  return listPromise;
}

export function refreshUsage(force = false): Promise<void> {
  if (usagePromise) return usagePromise;
  const before = usage ? JSON.stringify(usage.rows) : null;
  const errorBefore = usageError;
  usagePromise = window.vibeyard.claudeHistory.usage(force)
    .then((res) => {
      usage = res;
      usageError = false;
    })
    .catch(() => {
      usageError = true;
    })
    .finally(() => {
      usagePromise = null;
      const after = usage ? JSON.stringify(usage.rows) : null;
      if (force || after !== before || usageError !== errorBefore) emit();
    });
  if (force) emit();
  return usagePromise;
}
