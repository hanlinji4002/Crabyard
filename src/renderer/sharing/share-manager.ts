// Orchestrates P2P session sharing from this side — ties peer-host to AppState.
// This fork only shares out (tab menu → Share); joining someone else's session
// was removed along with its remote-terminal tab.

import type { ShareMode } from '../../shared/sharing-types.js';
import { startShare, stopShare, broadcastData, broadcastResize, isSharing, type ShareHandle } from './peer-host.js';
import { appState } from '../state.js';

const shareHandles = new Map<string, ShareHandle>();

// Listeners notified when sharing state changes (start/stop/connect/disconnect)
type ShareChangeListener = () => void;
const shareChangeListeners: ShareChangeListener[] = [];

export function onShareChange(cb: ShareChangeListener): void {
  shareChangeListeners.push(cb);
}

function notifyShareChange(): void {
  for (const cb of shareChangeListeners) cb();
}

// --- Host side ---

export interface ShareResult {
  offer: string;
  handle: ShareHandle;
}

export async function shareSession(sessionId: string, mode: ShareMode, passphrase: string): Promise<ShareResult> {
  const handle = startShare(sessionId, mode, passphrase);
  shareHandles.set(sessionId, handle);
  notifyShareChange();

  const offer = await handle.getOffer();

  handle.onConnected(() => {
    notifyShareChange();
  });

  handle.onDisconnected(() => {
    shareHandles.delete(sessionId);
    notifyShareChange();
  });

  return { offer, handle };
}

export async function acceptShareAnswer(sessionId: string, answer: string): Promise<void> {
  const handle = shareHandles.get(sessionId);
  if (!handle) throw new Error(`No active share for session ${sessionId}`);
  await handle.acceptAnswer(answer);
}

export function endShare(sessionId: string): void {
  stopShare(sessionId);
  shareHandles.delete(sessionId);
  notifyShareChange();
}

export function forwardPtyData(sessionId: string, data: string): void {
  broadcastData(sessionId, data);
}

export function forwardResize(sessionId: string, cols: number, rows: number): void {
  broadcastResize(sessionId, cols, rows);
}

// --- Cleanup ---

export function initShareManager(): void {
  appState.on('session-removed', (data?: unknown) => {
    const d = data as { sessionId?: string } | undefined;
    if (!d?.sessionId) return;
    const sessionId = d.sessionId;

    if (isSharing(sessionId)) {
      endShare(sessionId);
    }
  });
}

export function cleanupAllShares(): void {
  for (const [sessionId] of shareHandles) {
    endShare(sessionId);
  }
}

export function _resetForTesting(): void {
  shareHandles.clear();
  shareChangeListeners.length = 0;
}
