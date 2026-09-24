import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mocks for peer-host and appState ----

const { hostState, appStateListeners, appStateMock } = vi.hoisted(() => {
  const hostState = {
    startShare: vi.fn(),
    stopShare: vi.fn(),
    broadcastData: vi.fn(),
    broadcastResize: vi.fn(),
    isSharing: vi.fn(),
  };
  const appStateListeners = new Map<string, Array<(data?: unknown) => void>>();
  const appStateMock = {
    on: vi.fn((ev: string, cb: (data?: unknown) => void) => {
      if (!appStateListeners.has(ev)) appStateListeners.set(ev, []);
      appStateListeners.get(ev)!.push(cb);
    }),
  };
  return { hostState, appStateListeners, appStateMock };
});

vi.mock('./peer-host.js', () => hostState);
vi.mock('../state.js', () => ({ appState: appStateMock }));

// ---- import SUT ----
import {
  shareSession,
  acceptShareAnswer,
  endShare,
  forwardPtyData,
  forwardResize,
  initShareManager,
  cleanupAllShares,
  onShareChange,
  _resetForTesting,
} from './share-manager.js';

// ---- helpers ----

interface FakeShareHandle {
  getOffer: ReturnType<typeof vi.fn>;
  acceptAnswer: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onConnected: ReturnType<typeof vi.fn>;
  onDisconnected: ReturnType<typeof vi.fn>;
  onAuthFailed: ReturnType<typeof vi.fn>;
  __fireConnected: (() => void) | null;
  __fireDisconnected: (() => void) | null;
}

function makeShareHandle(): FakeShareHandle {
  const h: FakeShareHandle = {
    getOffer: vi.fn(async () => 'fake-offer'),
    acceptAnswer: vi.fn(async () => {}),
    stop: vi.fn(),
    onConnected: vi.fn((cb: () => void) => {
      h.__fireConnected = cb;
    }),
    onDisconnected: vi.fn((cb: () => void) => {
      h.__fireDisconnected = cb;
    }),
    onAuthFailed: vi.fn(),
    __fireConnected: null,
    __fireDisconnected: null,
  };
  return h;
}

beforeEach(() => {
  vi.clearAllMocks();
  appStateListeners.clear();
  _resetForTesting();
});

describe('shareSession', () => {
  it('calls startShare, stores handle, notifies listeners, and returns offer', async () => {
    const handle = makeShareHandle();
    hostState.startShare.mockReturnValue(handle);
    const change = vi.fn();
    onShareChange(change);

    const result = await shareSession('s1', 'readonly', '1234');

    expect(hostState.startShare).toHaveBeenCalledWith('s1', 'readonly', '1234');
    expect(result.offer).toBe('fake-offer');
    expect(change).toHaveBeenCalled();
  });

  it('notifies listeners on connect and removes handle on disconnect', async () => {
    const handle = makeShareHandle();
    hostState.startShare.mockReturnValue(handle);
    const change = vi.fn();
    onShareChange(change);

    await shareSession('s1', 'readonly', '1234');
    change.mockClear();

    handle.__fireConnected?.();
    expect(change).toHaveBeenCalledTimes(1);

    handle.__fireDisconnected?.();
    expect(change).toHaveBeenCalledTimes(2);
  });
});

describe('acceptShareAnswer', () => {
  it('delegates to the stored ShareHandle', async () => {
    const handle = makeShareHandle();
    hostState.startShare.mockReturnValue(handle);
    await shareSession('s1', 'readonly', '1234');
    await acceptShareAnswer('s1', 'answer-code');
    expect(handle.acceptAnswer).toHaveBeenCalledWith('answer-code');
  });

  it('throws when no share is active for the session', async () => {
    await expect(acceptShareAnswer('missing', 'answer')).rejects.toThrow(/No active share/);
  });
});

describe('endShare', () => {
  it('calls stopShare and notifies listeners', async () => {
    const handle = makeShareHandle();
    hostState.startShare.mockReturnValue(handle);
    await shareSession('s1', 'readonly', '1234');
    const change = vi.fn();
    onShareChange(change);
    endShare('s1');
    expect(hostState.stopShare).toHaveBeenCalledWith('s1');
    expect(change).toHaveBeenCalled();
  });
});

describe('forwardPtyData / forwardResize', () => {
  it('delegates to broadcastData', () => {
    forwardPtyData('s1', 'hello');
    expect(hostState.broadcastData).toHaveBeenCalledWith('s1', 'hello');
  });

  it('delegates to broadcastResize', () => {
    forwardResize('s1', 100, 30);
    expect(hostState.broadcastResize).toHaveBeenCalledWith('s1', 100, 30);
  });
});

describe('initShareManager', () => {
  it('removes host share on session-removed when sharing', async () => {
    initShareManager();
    const handle = makeShareHandle();
    hostState.startShare.mockReturnValue(handle);
    hostState.isSharing.mockImplementation((id: string) => id === 's1');
    await shareSession('s1', 'readonly', '1234');

    const listeners = appStateListeners.get('session-removed') ?? [];
    for (const l of listeners) l({ sessionId: 's1' });

    expect(hostState.stopShare).toHaveBeenCalledWith('s1');
  });

  it('ignores session-removed with missing payload', () => {
    initShareManager();
    const listeners = appStateListeners.get('session-removed') ?? [];
    expect(() => {
      for (const l of listeners) l();
    }).not.toThrow();
    expect(() => {
      for (const l of listeners) l({});
    }).not.toThrow();
  });
});

describe('cleanupAllShares', () => {
  it('ends all active host shares', async () => {
    hostState.isSharing.mockReturnValue(true);
    const handle = makeShareHandle();
    hostState.startShare.mockReturnValue(handle);
    await shareSession('s1', 'readonly', '1234');

    cleanupAllShares();

    expect(hostState.stopShare).toHaveBeenCalledWith('s1');
  });
});
