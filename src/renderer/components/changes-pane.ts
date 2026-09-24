import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';
import { basename } from '../../shared/platform.js';
import { tildePath } from '../claude-history-format.js';
import { getChangesView } from '../conversation-changes-store.js';
import type { FileChange } from '../../shared/types.js';

// Right-column panes 本轮修改 (the focused conversation's latest turn) and
// 本对话修改 (the whole conversation): one row per file with its +/- line
// counts, expandable to the edits' hunks.

export type ChangesMode = 'turn' | 'session';

const ICON_CODE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>';

/** Rows the user opened, per pane, kept across re-renders. */
const expanded: Record<ChangesMode, Set<string>> = { turn: new Set(), session: new Set() };

/** Keep deep directories readable in a narrow column: `…/vibeyard/src/main`. */
const MAX_DIR_SEGMENTS = 3;

/** "src/main" for files under the conversation's folder, else a ~-shortened directory. */
export function splitDisplayPath(file: string, cwd: string): { name: string; dir: string } {
  const name = basename(file);
  let dir = file.slice(0, file.length - name.length).replace(/[\\/]+$/, '');
  const root = cwd.replace(/[\\/]+$/, '');
  if (root && (dir === root || dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`))) {
    dir = dir.slice(root.length).replace(/^[\\/]+/, '');
  } else {
    dir = tildePath(dir);
  }
  const parts = dir.split(/[\\/]/).filter(Boolean);
  if (parts.length > MAX_DIR_SEGMENTS) dir = `…/${parts.slice(-MAX_DIR_SEGMENTS).join('/')}`;
  return { name, dir };
}

/** "+6 −3"; a side that is zero is left out (a new file reads just "+120"). */
function statsHtml(added: number, removed: number): string {
  const parts: string[] = [];
  if (added || !removed) parts.push(`<span class="chg-add">+${added}</span>`);
  if (removed) parts.push(`<span class="chg-del">−${removed}</span>`);
  return parts.join('');
}

function diffHtml(file: FileChange): string {
  const hunks = file.hunks.map((h) => {
    const lines = h.lines.map((line) => {
      const sign = line[0] ?? ' ';
      const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
      return `<div class="chg-line ${cls}"><span class="chg-sign">${esc(sign)}</span>${esc(line.slice(1)) || ' '}</div>`;
    }).join('');
    return `<div class="chg-hunk"><div class="chg-hunk-head">@@ −${h.oldStart} +${h.newStart} @@</div>${lines}</div>`;
  }).join('');
  const note = file.truncated ? `<div class="chg-truncated">${esc(t('changes.truncated'))}</div>` : '';
  return hunks + note;
}

function buildRow(file: FileChange, cwd: string, mode: ChangesMode, rerender: () => void): HTMLElement {
  const { name, dir } = splitDisplayPath(file.path, cwd);
  const open = expanded[mode].has(file.path);
  const row = document.createElement('div');
  row.className = 'chg-row' + (open ? ' open' : '');
  row.innerHTML = `
    <button type="button" class="chg-head" aria-expanded="${open}" title="${esc(file.path)}">
      <span class="chg-icon">${ICON_CODE}</span>
      <span class="chg-text">
        <span class="chg-name-line">
          <span class="chg-name">${esc(name)}</span>
          ${file.created ? `<span class="chg-new">${esc(t('changes.created'))}</span>` : ''}
        </span>
        ${dir ? `<span class="chg-dir">${esc(dir)}</span>` : ''}
      </span>
      <span class="chg-stats">${statsHtml(file.added, file.removed)}</span>
      <span class="chg-chevron" aria-hidden="true"></span>
    </button>
    ${open ? `<div class="chg-diff">${diffHtml(file)}</div>` : ''}
  `;
  row.querySelector('.chg-head')!.addEventListener('click', () => {
    if (expanded[mode].has(file.path)) expanded[mode].delete(file.path);
    else expanded[mode].add(file.path);
    rerender();
  });
  return row;
}

export function renderChangesPane(container: HTMLElement, opts: { mode: ChangesMode; onClose: () => void; rerender: () => void }): void {
  const { mode } = opts;
  const view = getChangesView();
  const files = view.kind === 'ready'
    ? (mode === 'turn' ? view.changes.lastTurn?.files ?? [] : view.changes.total)
    : [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'sidebar-view-header';
  const title = mode === 'turn' ? t('changes.turnTitle') : t('changes.sessionTitle');
  header.innerHTML = `
    <span class="sidebar-view-title">${esc(title)}</span>
    <div class="sidebar-view-actions">
      ${files.length ? `<span class="chg-sum">${statsHtml(added, removed)}<span class="chg-count">${esc(t('changes.files', { count: files.length }))}</span></span>` : ''}
      <button type="button" class="icon-btn usage-panel-close" title="${esc(t('usagePanel.hide'))}" aria-label="${esc(t('usagePanel.hide'))}">&times;</button>
    </div>
  `;
  header.querySelector('.usage-panel-close')!.addEventListener('click', opts.onClose);
  container.appendChild(header);

  const context = document.createElement('div');
  context.className = 'chg-context';
  if (view.kind === 'ready') {
    const c = view.changes;
    context.textContent = mode === 'turn'
      ? (c.lastTurn ? `${t('changes.turnLabel', { index: c.lastTurn.index })} · ${c.lastTurn.prompt}` : '')
      : `${view.sessionName} · ${t('changes.sessionTurns', { count: c.turns })}`;
  } else if (view.kind !== 'none') {
    context.textContent = view.sessionName;
  }
  if (context.textContent) container.appendChild(context);

  if (view.kind !== 'ready' || files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chg-empty';
    empty.textContent = view.kind === 'none' ? t('changes.none')
      : view.kind === 'loading' ? t('changes.loading')
        : view.kind === 'missing' ? t('changes.missing')
          : mode === 'turn' ? t('changes.emptyTurn') : t('changes.emptySession');
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'chg-list';
  for (const file of files) list.appendChild(buildRow(file, view.changes.cwd, mode, opts.rerender));
  container.appendChild(list);

  const note = document.createElement('div');
  note.className = 'chg-note';
  note.textContent = t('changes.note');
  container.appendChild(note);
}
