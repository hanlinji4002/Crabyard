import { describe, it, expect, vi } from 'vitest';

vi.mock('./pty-manager', () => ({ getFullPath: () => '/usr/bin' }));
vi.mock('./providers/resolve-binary', () => ({ resolveBinary: () => '/usr/bin/false' }));

import { parsePluginList } from './plugins';

describe('parsePluginList', () => {
  it('reads claude plugin list --json', () => {
    const json = JSON.stringify([
      { id: 'i-have-adhd@i-have-adhd', version: '0.3.0', scope: 'user', enabled: true, installPath: '/p/adhd' },
      { id: 'clangd-lsp@claude-plugins-official', version: '1.0.0', scope: 'user', enabled: false, installPath: '/p/clangd' },
      { id: 'bad id with spaces', enabled: true },
      null,
    ]);
    const out = parsePluginList(json, (p) => (p === '/p/adhd' ? 'ADHD mode' : ''));
    expect(out).toEqual([
      { id: 'clangd-lsp@claude-plugins-official', name: 'clangd-lsp', marketplace: 'claude-plugins-official', version: '1.0.0', scope: 'user', enabled: false, description: '' },
      { id: 'i-have-adhd@i-have-adhd', name: 'i-have-adhd', marketplace: 'i-have-adhd', version: '0.3.0', scope: 'user', enabled: true, description: 'ADHD mode' },
    ]);
  });

  it('returns nothing for output that is not a list', () => {
    expect(parsePluginList('{}')).toEqual([]);
  });
});
