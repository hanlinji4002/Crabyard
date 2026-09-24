import { describe, it, expect } from 'vitest';
import { splitDisplayPath } from './changes-pane';

describe('splitDisplayPath', () => {
  it('shows files inside the conversation folder relative to it', () => {
    expect(splitDisplayPath('/Users/ada/proj/src/main/a.ts', '/Users/ada/proj')).toEqual({ name: 'a.ts', dir: 'src/main' });
    expect(splitDisplayPath('/Users/ada/proj/README.md', '/Users/ada/proj/')).toEqual({ name: 'README.md', dir: '' });
  });

  it('shortens other directories with ~ and keeps their last three segments', () => {
    expect(splitDisplayPath('/Users/ada/notes/x.md', '/Users/ada/proj')).toEqual({ name: 'x.md', dir: '~/notes' });
    expect(splitDisplayPath('/Users/ada/Desktop/vibeyard/src/main/b.ts', '/Users/ada/proj')).toEqual({ name: 'b.ts', dir: '…/vibeyard/src/main' });
  });

  it('does not treat a sibling folder with the same prefix as inside', () => {
    expect(splitDisplayPath('/Users/ada/project2/c.ts', '/Users/ada/proj').dir).toBe('~/project2');
  });
});
