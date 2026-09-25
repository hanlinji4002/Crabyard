import * as fs from 'fs';
import * as path from 'path';
import type { PreviewTreeNode } from '../shared/types';

// The sidebar's 文件 view: a project's folders, pruned to the files Crabyard
// can preview (Markdown and PDF for now) and the folders that lead to them.
// Build output, dependencies and hidden folders are skipped, and the walk
// stops at a depth and entry budget so a huge tree can't stall the app.

export const PREVIEWABLE_RE = /\.(md|markdown|mdown|mkd|pdf)$/i;

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', 'target', 'vendor', 'coverage',
  '__pycache__', 'venv', 'env', 'site-packages', 'Pods', 'DerivedData',
]);

export interface PreviewTreeOptions {
  maxDepth?: number;
  /** Directory entries read in total before the walk gives up on the rest. */
  maxEntries?: number;
}

export function buildPreviewTree(root: string, opts: PreviewTreeOptions = {}): PreviewTreeNode {
  const maxDepth = opts.maxDepth ?? 8;
  let budget = opts.maxEntries ?? 20_000;
  let truncated = false;

  const walk = (dir: string, depth: number): PreviewTreeNode => {
    const node: PreviewTreeNode = { name: path.basename(dir), path: dir, dirs: [], files: [] };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return node;
    }
    const take = entries.slice(0, Math.max(0, budget));
    if (take.length < entries.length) truncated = true;
    budget -= take.length;
    for (const entry of take) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (depth >= maxDepth) {
          truncated = true;
          continue;
        }
        const child = walk(full, depth + 1);
        if (child.dirs.length > 0 || child.files.length > 0) node.dirs.push(child);
      } else if (entry.isFile() && PREVIEWABLE_RE.test(entry.name)) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        node.files.push({ name: entry.name, path: full, mtimeMs });
      }
    }
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    return node;
  };

  const tree = walk(root, 0);
  if (truncated) tree.truncated = true;
  return tree;
}
