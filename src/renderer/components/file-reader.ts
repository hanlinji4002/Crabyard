import DOMPurify from 'dompurify';
import { appState } from '../state.js';
import { closeSessionIfFileMissing } from '../session-close.js';
import { destroySearchBar } from './search-bar.js';
import { escapeHtml } from './dom-search-backend.js';
import { isAbsolutePath, dirname, samePath } from '../../shared/platform.js';
import { estimateTokens, TOKEN_COUNT_MAX_CHARS } from '../../shared/token-estimate.js';
import { resolveMarkdownLink } from '../markdown-link.js';
import { openFileReaderChecked } from '../open-file-reader.js';
import { slugifyHeading } from '../../shared/slug.js';
import { renderMarkdownWithMath } from '../markdown-math.js';
import { parseTranscript, turnHtml, type TranscriptTurn } from '../transcript-view.js';
import { t } from '../i18n.js';

interface FileReaderInstance {
  element: HTMLElement;
  filePath: string;
  resolvedPath: string | null;
  loaded: boolean;
  targetLine?: number;
  viewMode: 'raw' | 'rendered';
  /** 'transcript' is a Claude Code conversation shown as the typeset conversation view. */
  kind: 'text' | 'image' | 'pdf' | 'transcript';
  unsupported: boolean;
  rawContent?: string;
  imageDataUrl?: string;
  turns?: TranscriptTurn[];
  /** The conversation view shows only its latest turns until asked for the rest. */
  showAllTurns?: boolean;
  reloadTimer?: ReturnType<typeof setTimeout> | null;
}

/** Turns the conversation view shows before "show earlier". */
const RECENT_TURNS = 60;
/** A conversation being written to changes constantly; re-read it at most this often. */
const TRANSCRIPT_RELOAD_MS = 600;

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown|mdown|mkd|mdx)$/i.test(filePath);
}

function isImageFile(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(filePath);
}

function isPdfFile(filePath: string): boolean {
  return /\.pdf$/i.test(filePath);
}

/** A Claude Code transcript: `<config dir>/projects/<folder>/<session id>.jsonl`. */
export function isTranscriptFile(filePath: string): boolean {
  return /[\\/]projects[\\/][^\\/]+[\\/][^\\/]+\.jsonl$/i.test(filePath);
}

function fileUrl(filePath: string): string {
  return `file://${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

const instances = new Map<string, FileReaderInstance>();
let unwatchFileChanged: (() => void) | null = null;

function renderFileContent(content: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'file-reader-content';

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = 'file-reader-line';

    const lineNum = document.createElement('span');
    lineNum.className = 'file-reader-line-num';
    lineNum.textContent = String(i + 1);

    const lineText = document.createElement('span');
    lineText.className = 'file-reader-line-text';
    lineText.innerHTML = escapeHtml(lines[i]) || '&nbsp;';

    row.appendChild(lineNum);
    row.appendChild(lineText);
    wrapper.appendChild(row);
  }

  return wrapper;
}

function scrollToHeading(wrapper: HTMLElement, slug: string): void {
  const headings = [...wrapper.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')];
  const heading = headings.find((h) => slugifyHeading(h.textContent ?? '') === slug);
  if (!heading) {
    console.warn(`[markdown-link] no heading matches anchor #${slug}`);
    return;
  }
  heading.scrollIntoView({ block: 'start' });
}

/**
 * Route clicks on links inside rendered Markdown. The default action is always
 * suppressed: the renderer is a `file://` document, so letting an anchor
 * navigate would replace the whole app with the link target.
 */
function handleMarkdownClick(wrapper: HTMLElement, baseDir: string | undefined, event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest('a');
  if (!anchor) return;

  event.preventDefault();

  const href = anchor.getAttribute('href') ?? '';
  const target = resolveMarkdownLink(href, baseDir);
  // Every branch can fail silently, and a suppressed default is indistinguishable
  // from a dead link — so each failure path says why on the console.
  switch (target.kind) {
    case 'anchor':
      scrollToHeading(wrapper, target.slug);
      break;
    case 'external':
      window.vibeyard.app
        .openExternal(target.url)
        .catch((err: unknown) => console.warn(`[markdown-link] could not open ${target.url}`, err));
      break;
    case 'file': {
      // openFileReaderChecked validates the path before it spawns a tab — a
      // dead link would otherwise open a tab that loadFile tears down again,
      // dropping the reader on an unrelated tab.
      const project = appState.activeProject;
      if (project) void openFileReaderChecked(project.id, target.path);
      break;
    }
    case 'ignore':
      console.warn(`[markdown-link] not a routable link: ${href}`);
      break;
  }
}

export function renderMarkdownContent(content: string, baseDir?: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'file-reader-markdown';
  wrapper.innerHTML = DOMPurify.sanitize(renderMarkdownWithMath(content));
  wrapper.addEventListener('click', (event) => handleMarkdownClick(wrapper, baseDir, event));
  if (baseDir) void inlineLocalImages(wrapper, baseDir);
  return wrapper;
}

/**
 * A relative image path would resolve against the app's own page, so local
 * images are read from the Markdown file's folder and shown as data URLs.
 */
async function inlineLocalImages(wrapper: HTMLElement, baseDir: string): Promise<void> {
  for (const img of wrapper.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!src || /^(https?:|data:|blob:)/i.test(src)) continue;
    let local = src.replace(/^file:\/\//i, '');
    try {
      local = decodeURI(local);
    } catch {
      // keep it as written
    }
    const full = isAbsolutePath(local) ? local : `${baseDir}/${local.replace(/^\.\//, '')}`;
    img.removeAttribute('src');
    const result = await window.vibeyard.fs.readImage(full).catch(() => null);
    if (result) img.src = result.dataUrl;
  }
}

/** The conversation view: its latest turns (or all of them), keeping the reader's place. */
function renderTranscript(instance: FileReaderInstance, body: Element): void {
  const turns = instance.turns ?? [];
  const el = body as HTMLElement;
  const firstRender = !body.querySelector('.tv-list');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const prevTop = el.scrollTop;
  const hidden = instance.showAllTurns ? 0 : Math.max(0, turns.length - RECENT_TURNS);
  const labels = { user: t('preview.you'), assistant: 'Claude' };
  const list = document.createElement('div');
  list.className = 'tv-list';
  if (hidden > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tv-earlier';
    more.textContent = t('preview.showEarlier', { count: hidden });
    more.addEventListener('click', () => {
      instance.showAllTurns = true;
      renderTranscript(instance, body);
    });
    list.appendChild(more);
  }
  const html = turns.slice(hidden).map((turn) => turnHtml(turn, labels)).join('');
  list.insertAdjacentHTML('beforeend', html || `<div class="tv-empty">${t('preview.emptyConversation')}</div>`);
  list.addEventListener('click', (event) => handleMarkdownClick(list, appState.activeProject?.path, event));
  body.replaceChildren(list);
  if (firstRender || atBottom) el.scrollTop = el.scrollHeight;
  else el.scrollTop = prevTop;
}

function renderImageContent(dataUrl: string, filePath: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'file-reader-image-container';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = filePath;
  wrapper.appendChild(img);
  return wrapper;
}

function renderBody(instance: FileReaderInstance): void {
  const body = instance.element.querySelector('.file-reader-body')!;
  // Preserve text selection if user is selecting
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed && body.contains(sel.anchorNode)) {
    return;
  }
  if (instance.kind === 'transcript') {
    renderTranscript(instance, body);
    return;
  }
  body.innerHTML = '';
  if (instance.kind === 'pdf') {
    // Chromium's own PDF viewer: pages, zoom, search and print come with it.
    const frame = document.createElement('iframe');
    frame.className = 'file-reader-pdf';
    frame.src = fileUrl(resolveFilePath(instance));
    body.appendChild(frame);
    return;
  }
  if (instance.kind === 'image') {
    if (instance.imageDataUrl) {
      body.appendChild(renderImageContent(instance.imageDataUrl, instance.filePath));
    }
    return;
  }
  if (instance.viewMode === 'rendered') {
    body.appendChild(renderMarkdownContent(instance.rawContent!, dirname(resolveFilePath(instance))));
  } else {
    body.appendChild(renderFileContent(instance.rawContent!));
  }
}

function resolveFilePath(instance: FileReaderInstance): string {
  const project = appState.activeProject;
  if (isAbsolutePath(instance.filePath)) return instance.filePath;
  return project ? `${project.path}/${instance.filePath}` : instance.filePath;
}

function showFileReaderMessage(body: Element, message: string): void {
  body.innerHTML = `<div class="file-reader-content"><div class="file-reader-line"><span class="file-reader-line-text">${message}</span></div></div>`;
}

async function loadFile(instance: FileReaderInstance, sessionId: string): Promise<void> {
  if (instance.loaded) return;

  const project = appState.activeProject;
  if (!project) return;

  instance.unsupported = false;
  hideTokenBadge(instance);
  const body = instance.element.querySelector('.file-reader-body')!;
  if (!(instance.kind === 'transcript' && instance.turns)) showFileReaderMessage(body, 'Loading...');

  try {
    const fullPath = resolveFilePath(instance);
    if (await closeSessionIfFileMissing(sessionId, fullPath)) return;
    if (instance.kind === 'pdf') {
      renderBody(instance);
      instance.loaded = true;
      return;
    }
    if (instance.kind === 'transcript') {
      const result = await window.vibeyard.fs.readFile(fullPath);
      if (!result.ok) {
        showFileReaderMessage(body, t('preview.loadFailed'));
        instance.loaded = true;
        return;
      }
      instance.turns = parseTranscript(result.content);
      renderBody(instance);
      instance.loaded = true;
      return;
    }
    if (instance.kind === 'image') {
      const result = await window.vibeyard.fs.readImage(fullPath);
      if (!result) {
        showFileReaderMessage(body, 'Failed to load file');
        return;
      }
      instance.imageDataUrl = result.dataUrl;
      renderBody(instance);
      instance.loaded = true;
      return;
    }
    const result = await window.vibeyard.fs.readFile(fullPath);
    if (!result.ok) {
      showFileReaderMessage(
        body,
        result.reason === 'binary' ? 'Unable to preview this file' : 'Failed to load file',
      );
      instance.unsupported = true;
      instance.loaded = true;
      return;
    }
    instance.rawContent = result.content;
    updateTokenBadge(instance, result.content);
    renderBody(instance);
    instance.loaded = true;
    if (instance.targetLine && instance.viewMode === 'raw') {
      scrollToLine(instance);
    }
  } catch {
    showFileReaderMessage(body, 'Failed to load file');
    instance.unsupported = true;
  }
}

function getTokenBadge(instance: FileReaderInstance): HTMLElement | null {
  return instance.element.querySelector('.file-reader-token-badge');
}

function updateTokenBadge(instance: FileReaderInstance, content: string): void {
  const badge = getTokenBadge(instance);
  if (!badge) return;
  if (content.length > TOKEN_COUNT_MAX_CHARS) {
    badge.textContent = 'too large to count';
  } else {
    const count = estimateTokens(content);
    badge.textContent = `~ ${count.toLocaleString()} tokens`;
  }
  badge.style.display = '';
}

function hideTokenBadge(instance: FileReaderInstance): void {
  const badge = getTokenBadge(instance);
  if (!badge) return;
  badge.style.display = 'none';
}

function ensureFileChangedListener(): void {
  if (unwatchFileChanged) return;
  unwatchFileChanged = window.vibeyard.fs.onFsChange((changes) => {
    for (const change of changes) {
      for (const [sessionId, instance] of instances) {
        if (instance.resolvedPath && samePath(instance.resolvedPath, change.path) && instance.loaded) {
          // reloadFileReader -> loadFile -> closeSessionIfFileMissing handles deletes.
          if (instance.kind === 'transcript') scheduleTranscriptReload(sessionId, instance);
          else reloadFileReader(sessionId);
        }
      }
    }
  });
}

function scheduleTranscriptReload(sessionId: string, instance: FileReaderInstance): void {
  if (instance.reloadTimer) return;
  instance.reloadTimer = setTimeout(() => {
    instance.reloadTimer = null;
    reloadFileReader(sessionId);
  }, TRANSCRIPT_RELOAD_MS);
}

export function reloadFileReader(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instance.loaded = false;
  loadFile(instance, sessionId);
}

export function createFileReaderPane(sessionId: string, filePath: string, targetLine?: number): void {
  if (instances.has(sessionId)) return;

  const el = document.createElement('div');
  el.className = 'file-reader-pane';
  el.dataset.sessionId = sessionId;
  el.dataset.paneKind = 'file-reader';
  el.style.display = 'none';

  // Header
  const header = document.createElement('div');
  header.className = 'file-viewer-header';

  const transcript = isTranscriptFile(filePath);
  const pdf = isPdfFile(filePath);
  const pathSpan = document.createElement('span');
  pathSpan.className = 'file-viewer-path';
  pathSpan.textContent = transcript ? t('preview.conversationView') : filePath;
  if (transcript) pathSpan.title = filePath;

  const badge = document.createElement('span');
  badge.className = 'file-reader-badge' + (transcript ? ' live' : '');
  badge.textContent = transcript ? t('preview.live') : pdf ? 'PDF' : 'READ-ONLY';

  const tokenBadge = document.createElement('span');
  tokenBadge.className = 'file-reader-token-badge';
  tokenBadge.style.display = 'none';
  tokenBadge.title = 'Rough token estimate (provider-agnostic)';

  header.appendChild(pathSpan);
  header.appendChild(badge);
  header.appendChild(tokenBadge);

  const isMd = isMarkdownFile(filePath);
  const isImage = isImageFile(filePath);
  const instance: FileReaderInstance = {
    element: el, filePath, resolvedPath: null, loaded: false, targetLine,
    viewMode: isMd || transcript ? 'rendered' : 'raw',
    kind: transcript ? 'transcript' : pdf ? 'pdf' : isImage ? 'image' : 'text',
    unsupported: false,
  };
  if (transcript) el.classList.add('conversation-view');

  if (isMd) {
    const toggleGroup = document.createElement('div');
    toggleGroup.className = 'file-reader-view-toggle';

    const renderedBtn = document.createElement('button');
    renderedBtn.className = 'search-toggle-btn active';
    renderedBtn.textContent = 'Rendered';
    renderedBtn.title = 'Rendered Markdown';

    const rawBtn = document.createElement('button');
    rawBtn.className = 'search-toggle-btn';
    rawBtn.textContent = 'Raw';
    rawBtn.title = 'Raw Text';

    const setMode = (mode: 'raw' | 'rendered') => {
      instance.viewMode = mode;
      renderedBtn.classList.toggle('active', mode === 'rendered');
      rawBtn.classList.toggle('active', mode === 'raw');
      if (instance.rawContent !== undefined) {
        renderBody(instance);
      }
    };

    renderedBtn.addEventListener('click', () => setMode('rendered'));
    rawBtn.addEventListener('click', () => setMode('raw'));

    toggleGroup.appendChild(renderedBtn);
    toggleGroup.appendChild(rawBtn);
    header.appendChild(toggleGroup);
  }

  el.appendChild(header);

  // Scrollable body
  const body = document.createElement('div');
  body.className = 'file-reader-body';
  el.appendChild(body);

  instances.set(sessionId, instance);
}

export function destroyFileReaderPane(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.resolvedPath) {
    window.vibeyard.fs.unwatchDir(dirname(instance.resolvedPath));
  }
  if (instance.reloadTimer) clearTimeout(instance.reloadTimer);
  destroySearchBar(sessionId);
  destroyGoToLineBar(sessionId);
  instance.element.remove();
  instances.delete(sessionId);
}

export function showFileReaderPane(sessionId: string, isSplit: boolean): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instance.element.style.display = 'flex';
  if (isSplit) instance.element.classList.add('split');
  else instance.element.classList.remove('split');

  // Watch the parent directory (not the file inode) so atomic save/replace —
  // which swaps the inode and would kill a direct file watch — is still caught.
  if (!instance.resolvedPath) {
    const fullPath = resolveFilePath(instance);
    instance.resolvedPath = fullPath;
    ensureFileChangedListener();
    window.vibeyard.fs.watchDir(dirname(fullPath));
  }

  loadFile(instance, sessionId);
  if (instance.loaded && instance.targetLine) {
    scrollToLine(instance);
  }
}

export function setFileReaderLine(sessionId: string, line: number): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instance.targetLine = line;
  if (instance.loaded) {
    scrollToLine(instance);
  }
}

function scrollToLine(instance: FileReaderInstance): void {
  const line = instance.targetLine;
  if (!line) return;

  const body = instance.element.querySelector('.file-reader-body');
  if (!body) return;

  // Clear previous highlights
  body.querySelectorAll('.file-reader-line-highlight').forEach((el) => {
    el.classList.remove('file-reader-line-highlight');
  });

  const lines = body.querySelectorAll('.file-reader-line');
  const targetEl = lines[line - 1] as HTMLElement | undefined;
  if (!targetEl) return;

  targetEl.classList.add('file-reader-line-highlight');
  requestAnimationFrame(() => {
    targetEl.scrollIntoView({ block: 'center' });
  });
}

export function hideAllFileReaderPanes(): void {
  for (const instance of instances.values()) {
    instance.element.style.display = 'none';
  }
}

export function attachFileReaderToContainer(sessionId: string, container: HTMLElement): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.element.parentElement !== container) {
    container.appendChild(instance.element);
  }
}

export function getFileReaderInstance(sessionId: string): FileReaderInstance | undefined {
  return instances.get(sessionId);
}

const MARKDOWN_TEXT_SELECTOR = [
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'pre', 'blockquote',
].map((tag) => `.file-reader-markdown ${tag}`).join(', ');

const RAW_TEXT_SELECTOR = '.file-reader-line-text';

export function getFileReaderTextSelector(sessionId: string): string {
  const instance = instances.get(sessionId);
  if (!instance) return RAW_TEXT_SELECTOR;
  if (instance.kind === 'image' || instance.kind === 'pdf' || instance.unsupported) return '.file-reader-no-search';
  return instance.viewMode === 'rendered' ? MARKDOWN_TEXT_SELECTOR : RAW_TEXT_SELECTOR;
}

const goToLineBars = new Map<string, { bar: HTMLDivElement; input: HTMLInputElement }>();

export function showGoToLineBar(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.kind !== 'text' || instance.unsupported) return;
  if (instance.viewMode === 'rendered') return;

  const existing = goToLineBars.get(sessionId);
  if (existing) {
    existing.bar.classList.remove('hidden');
    existing.input.focus();
    existing.input.select();
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'goto-line-bar';

  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.placeholder = 'Go to line...';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-nav-btn search-close-btn';
  closeBtn.textContent = '\u2715';
  closeBtn.title = 'Close (Escape)';

  bar.appendChild(input);
  bar.appendChild(closeBtn);

  instance.element.appendChild(bar);
  goToLineBars.set(sessionId, { bar, input });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = parseInt(input.value, 10);
      if (line > 0) {
        setFileReaderLine(sessionId, line);
      }
      hideGoToLineBar(sessionId);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideGoToLineBar(sessionId);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      input.select();
    }
  });

  closeBtn.addEventListener('click', () => hideGoToLineBar(sessionId));

  input.focus();
}

export function hideGoToLineBar(sessionId: string): void {
  const entry = goToLineBars.get(sessionId);
  if (!entry) return;
  entry.bar.classList.add('hidden');
  const instance = instances.get(sessionId);
  if (instance) {
    instance.element.querySelector('.file-reader-body')?.focus();
  }
}

function destroyGoToLineBar(sessionId: string): void {
  const entry = goToLineBars.get(sessionId);
  if (!entry) return;
  entry.bar.remove();
  goToLineBars.delete(sessionId);
}
