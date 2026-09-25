import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPreviewTree } from './preview-tree';

let root: string;

function touch(rel: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-tree-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('buildPreviewTree', () => {
  it('keeps Markdown and PDF files and the folders that lead to them', () => {
    touch('README.md');
    touch('notes.txt');
    touch('docs/guide.md');
    touch('docs/paper/report.pdf');
    touch('docs/img/figure.png');
    touch('src/main.ts');
    const tree = buildPreviewTree(root);
    expect(tree.files.map((f) => f.name)).toEqual(['README.md']);
    expect(tree.dirs.map((d) => d.name)).toEqual(['docs']);
    const docs = tree.dirs[0];
    expect(docs.files.map((f) => f.name)).toEqual(['guide.md']);
    expect(docs.dirs.map((d) => d.name)).toEqual(['paper']);
    expect(docs.dirs[0].files[0]).toMatchObject({ name: 'report.pdf', path: path.join(root, 'docs/paper/report.pdf') });
    expect(tree.truncated).toBeUndefined();
  });

  it('skips dependencies, build output and hidden folders', () => {
    touch('node_modules/pkg/README.md');
    touch('dist/out.pdf');
    touch('.git/notes.md');
    touch('.venv/lib/doc.md');
    touch('keep/ok.md');
    const tree = buildPreviewTree(root);
    expect(tree.dirs.map((d) => d.name)).toEqual(['keep']);
  });

  it('stops at the depth and entry budget and says so', () => {
    touch('a/b/c/deep.md');
    expect(buildPreviewTree(root, { maxDepth: 1 })).toMatchObject({ dirs: [], truncated: true });
    for (let i = 0; i < 5; i++) touch(`f${i}.md`);
    const small = buildPreviewTree(root, { maxEntries: 3 });
    expect(small.truncated).toBe(true);
    expect(small.files.length).toBeLessThanOrEqual(3);
  });
});
