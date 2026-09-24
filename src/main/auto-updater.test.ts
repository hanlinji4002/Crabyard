import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
  },
}));

const mockSend = vi.fn();

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
}));

import { autoUpdater } from 'electron-updater';
import { initAutoUpdater, checkForUpdates, quitAndInstall, _setUpdatesEnabled } from './auto-updater';

// The fork ships with updates switched off (see the next describe); these cover
// the upstream wiring that sits behind the switch.
describe('auto-updater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _setUpdatesEnabled(true);
  });

  it('registers event listeners and configures autoUpdater', () => {
    initAutoUpdater();
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('download-progress', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('schedules check after 10s delay', () => {
    initAutoUpdater();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('checkForUpdates delegates to autoUpdater', () => {
    checkForUpdates();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it('quitAndInstall delegates to autoUpdater', () => {
    quitAndInstall();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
  });

  it('forwards update-available event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'update-available')![1] as (info: { version: string }) => void;
    handler({ version: '1.2.3' });
    expect(mockSend).toHaveBeenCalledWith('update:available', { version: '1.2.3' });
  });

  it('forwards download-progress event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'download-progress')![1] as (progress: { percent: number }) => void;
    handler({ percent: 55.7 });
    expect(mockSend).toHaveBeenCalledWith('update:download-progress', { percent: 56 });
  });

  it('forwards update-downloaded event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'update-downloaded')![1] as (info: { version: string }) => void;
    handler({ version: '2.0.0' });
    expect(mockSend).toHaveBeenCalledWith('update:downloaded', { version: '2.0.0' });
  });

  it('forwards error event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'error')![1] as (err: Error) => void;
    handler(new Error('update failed'));
    expect(mockSend).toHaveBeenCalledWith('update:error', { message: 'update failed' });
  });

  it('skips initialization in dev mode', async () => {
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock('electron-updater', () => ({
      autoUpdater: {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        checkForUpdates: vi.fn(),
        quitAndInstall: vi.fn(),
        on: vi.fn(),
      },
    }));
    const mod = await import('./auto-updater');
    const { autoUpdater: freshUpdater } = await import('electron-updater');
    mod._setUpdatesEnabled(true);
    mod.initAutoUpdater();
    expect(freshUpdater.on).not.toHaveBeenCalled();
  });
});

describe('auto-updater in this fork (updates disabled by default)', () => {
  // A fresh module, so the switch is at its shipped default, in a packaged build
  // (the case where upstream would start checking).
  async function loadPackaged() {
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { isPackaged: true },
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock('electron-updater', () => ({
      autoUpdater: {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        checkForUpdates: vi.fn().mockResolvedValue({}),
        quitAndInstall: vi.fn(),
        on: vi.fn(),
      },
    }));
    const mod = await import('./auto-updater');
    const { autoUpdater: updater } = await import('electron-updater');
    return { mod, updater };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('never configures the updater or schedules a check', async () => {
    const { mod, updater } = await loadPackaged();
    mod.initAutoUpdater();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(updater.on).not.toHaveBeenCalled();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('ignores a manual "Check for Updates" request', async () => {
    const { mod, updater } = await loadPackaged();
    mod.checkForUpdates();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('ignores an install request', async () => {
    const { mod, updater } = await loadPackaged();
    mod.quitAndInstall();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
