import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('./providers/resolve-binary', () => ({ resolveBinary: () => '/usr/local/bin/claude' }));
vi.mock('./pty-manager', () => ({ getFullPath: () => '/usr/local/bin:/usr/bin' }));

import { stopBackgroundSession } from './background-sessions';

type Callback = (err: Error | null, stdout: string, stderr: string) => void;

describe('stopBackgroundSession', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('runs `claude stop <id>` and reports success', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Callback) => cb(null, 'stopped b54b5bdc\n', ''));
    await expect(stopBackgroundSession('b54b5bdc')).resolves.toEqual({ ok: true });
    const [bin, args, opts] = execFileMock.mock.calls[0];
    expect(bin).toBe('/usr/local/bin/claude');
    expect(args).toEqual(['stop', 'b54b5bdc']);
    expect(opts.env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  it('points the CLI at a profile config dir', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Callback) => cb(null, '', ''));
    await stopBackgroundSession('b54b5bdc', '/Users/me/.vibeyard/profiles/work');
    expect(execFileMock.mock.calls[0][2].env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.vibeyard/profiles/work');
  });

  it('passes on why the CLI could not stop it', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Callback) =>
      cb(new Error('Command failed'), '', "couldn't confirm b54b5bdc was stopped — the background service may be restarting. Try again in a moment.\n"));
    await expect(stopBackgroundSession('b54b5bdc')).resolves.toEqual({
      ok: false,
      error: "couldn't confirm b54b5bdc was stopped — the background service may be restarting. Try again in a moment.",
    });
  });

  it('refuses anything that is not a job id', async () => {
    for (const bad of ['', 'b54b5bd', 'b54b5bdc; rm -rf ~', '../../etc', 'B54B5BDCX']) {
      await expect(stopBackgroundSession(bad)).resolves.toMatchObject({ ok: false });
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
