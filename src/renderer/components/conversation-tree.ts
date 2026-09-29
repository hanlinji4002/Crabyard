import { appState, type ProjectRecord } from '../state.js';
import { esc } from '../dom-utils.js';
import { getProjectStatus, projectInitial } from '../project-status.js';
import { getStatus } from '../session-activity.js';
import { hasUnreadInProject } from '../session-unread.js';
import { deriveProjectName } from '../../shared/project-name.js';
import { getLocale, t } from '../i18n.js';
import { defaultSessionName } from '../state/session-naming.js';
import { attachHoverCard } from './hover-card.js';
import { showContextMenu, type MenuOption } from './context-menu.js';
import { showConfirmDialog } from './modal.js';
import {
  conversationsFailed,
  getConversations,
  isConversationsLoading,
  refreshConversations,
} from '../claude-history-store.js';
import { formatRelativeTime, samePath, tildePath } from '../claude-history-format.js';
import { openConversationView, openFileReaderChecked } from '../open-file-reader.js';
import type { ClaudeConversation, PreviewTreeNode } from '../../shared/types.js';

// The sidebar's 对话 view: every folder that has Claude Code transcripts (plus
// every Vibeyard project) as a collapsible card, newest activity first, with
// its conversations listed underneath. Clicking a conversation reopens it the
// way `/resume` would — `claude -r <id>` in that folder — or focuses its tab
// when it is already open; its 排版 button opens the typeset conversation view.
// The active card can switch between 对话 and 文件: the project's folders with
// the files Crabyard can preview (Markdown, PDF), each opening in a tab.

const PAGE_SIZE = 8;
/** Re-scan a project's files when its 文件 view is shown and the last scan is older than this. */
const TREE_STALE_MS = 15_000;
const ICON_TYPESET = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

export interface ConversationTreeHooks {
  /** Segmented actions + open panel for the active project's card. */
  buildActiveExtras(project: ProjectRecord): HTMLElement[];
  showProjectContextMenu(x: number, y: number, project: ProjectRecord): void;
}

interface FolderGroup {
  key: string;
  path: string;
  name: string;
  project?: ProjectRecord;
  conversations: ClaudeConversation[];
  lastActivity: number;
  exists: boolean;
}

/** Explicit expand/collapse choices; folders without one follow the default. */
const expanded = new Map<string, boolean>();
const showAll = new Set<string>();
let filterText = '';
/** Which list the active card shows, per folder. */
const cardView = new Map<string, 'conversations' | 'files'>();
/** Scanned file trees per project folder, and the folders opened in them. */
const fileTrees = new Map<string, { tree: PreviewTreeNode | null; loading: boolean; at: number }>();
const openDirs = new Set<string>();

export function setConversationFilter(text: string): void {
  filterText = text.trim().toLowerCase();
}

function buildGroups(conversations: ClaudeConversation[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const conv of conversations) {
    const key = conv.projectCwd || `slug:${conv.projectSlug}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        path: conv.projectCwd,
        name: conv.projectCwd ? deriveProjectName(conv.projectCwd) : conv.projectSlug,
        conversations: [],
        lastActivity: 0,
        exists: conv.cwdExists,
      };
      groups.set(key, group);
    }
    group.conversations.push(conv);
    group.lastActivity = Math.max(group.lastActivity, conv.updatedAt);
  }

  for (const project of appState.projects) {
    const match = [...groups.values()].find((g) => g.path && samePath(g.path, project.path));
    if (match) {
      match.project = project;
      match.name = project.name;
    } else {
      groups.set(project.path, {
        key: project.path,
        path: project.path,
        name: project.name,
        project,
        conversations: [],
        lastActivity: 0,
        exists: true,
      });
    }
  }

  const now = Date.now();
  for (const group of groups.values()) {
    // Folders with open tabs count as active right now.
    if (group.project && group.project.sessions.length > 0) group.lastActivity = Math.max(group.lastActivity, now - 1);
  }
  return [...groups.values()].sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
}

/**
 * The row's title: a name the user gave the conversation in Crabyard (tab
 * rename) wins over the one Claude Code keeps in the transcript, unless they
 * renamed it in the CLI since; a conversation carried on in a background
 * session keeps the name given to the one it carries on.
 */
export function conversationTitle(conv: ClaudeConversation): string {
  return appState.conversationTitleFor(conv) ?? conv.title;
}

function matchesFilter(conv: ClaudeConversation): boolean {
  if (!filterText) return true;
  return (
    conversationTitle(conv).toLowerCase().includes(filterText) ||
    conv.title.toLowerCase().includes(filterText) ||
    conv.firstPrompt.toLowerCase().includes(filterText) ||
    (conv.gitBranch?.toLowerCase().includes(filterText) ?? false) ||
    conv.cliSessionId.startsWith(filterText)
  );
}

function isExpanded(group: FolderGroup): boolean {
  if (filterText) return true;
  const explicit = expanded.get(group.key);
  if (explicit !== undefined) return explicit;
  return !!group.project && group.project.id === appState.activeProjectId;
}

/** Open (or focus) a conversation in its folder's project, creating the project if needed. */
export function openConversation(conv: ClaudeConversation): void {
  if (!conv.projectCwd || !conv.cwdExists) return;
  let project = appState.projects.find((p) => samePath(p.path, conv.projectCwd));
  if (!project) {
    project = appState.addProject(deriveProjectName(conv.projectCwd, conv.projectSlug), conv.projectCwd);
  } else if (appState.activeProjectId !== project.id) {
    appState.setActiveProject(project.id);
  }
  const name = conversationTitle(conv) || conv.cliSessionId.slice(0, 8);
  appState.openCliSession(project.id, conv.cliSessionId, name, 'claude', conv.profileId);
}

function ensureProjectFor(group: FolderGroup): ProjectRecord | undefined {
  if (group.project) {
    if (appState.activeProjectId !== group.project.id) appState.setActiveProject(group.project.id);
    return group.project;
  }
  if (!group.path || !group.exists) return undefined;
  return appState.addProject(group.name, group.path);
}

/**
 * Which tab each conversation is open in. A tab still on a conversation that
 * was handed off to a background session counts as open on the one carrying it
 * on (its CLI shows that one in the agents view).
 */
function openSessionsByCliId(conversations: ClaudeConversation[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of appState.projects) {
    for (const session of project.sessions) {
      if (session.cliSessionId) map.set(session.cliSessionId, session.id);
    }
  }
  for (const conv of conversations) {
    if (map.has(conv.cliSessionId)) continue;
    const tab = conv.continuedFrom?.map((id) => map.get(id)).find(Boolean);
    if (tab) map.set(conv.cliSessionId, tab);
  }
  return map;
}

/** Bring an open conversation's tab forward, in whichever project it is. */
function focusTab(sessionId: string): void {
  const project = appState.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
  if (!project) return;
  if (appState.activeProjectId !== project.id) appState.setActiveProject(project.id);
  appState.setActiveSession(project.id, sessionId);
}

/**
 * Ask first (it interrupts whatever the session is doing), then stop a
 * background session with `claude stop`. Its conversation is kept, and the
 * row turns into an ordinary one that `claude -r` picks up again.
 */
function confirmStopBackground(conv: ClaudeConversation): void {
  const short = conv.background?.short;
  if (!short) return;
  const title = conversationTitle(conv) || t('conversations.untitled');
  showConfirmDialog(t('conversations.stopTitle'), t('conversations.stopMessage', { title }), {
    confirmLabel: t('conversations.stopConfirm'),
    cancelLabel: t('preferences.cancel'),
    onConfirm: () => {
      void window.vibeyard.claudeHistory.stopBackground(short, conv.profileId).then((result) => {
        void refreshConversations(false, true);
        if (result.ok) return;
        showConfirmDialog(t('conversations.stopTitle'), t('conversations.stopFailed', { error: result.error ?? '' }), {
          confirmLabel: t('preferences.done'),
          onConfirm: () => {},
        });
      });
    },
  });
}

/** Ask first, then move the conversation's transcript to the Trash (restorable). */
function confirmDeleteConversation(conv: ClaudeConversation): void {
  const title = conversationTitle(conv) || t('conversations.untitled');
  showConfirmDialog(t('conversations.deleteTitle'), t('conversations.deleteMessage', { title }), {
    confirmLabel: t('conversations.deleteConfirm'),
    cancelLabel: t('preferences.cancel'),
    onConfirm: () => {
      void window.vibeyard.claudeHistory.trash(conv.transcriptPath).then((result) => {
        void refreshConversations(true);
        // A name the user gave it stays: the transcript can come back from the Trash.
        if (result.ok) return;
        const refused = result.reason === 'open' ? t('conversations.deleteOpen')
          : result.reason === 'background' ? t('conversations.deleteBackground')
          : result.reason === 'recent' ? t('conversations.deleteRecent')
          : t('conversations.deleteFailed', { error: result.error ?? '' });
        showConfirmDialog(t('conversations.deleteTitle'), refused, {
          confirmLabel: t('preferences.done'),
          onConfirm: () => {},
        });
      });
    },
  });
}

/** Title of the conversation a /fork came from, when it is in the list. */
function forkParentTitle(conv: ClaudeConversation): string | undefined {
  if (!conv.forkOf) return undefined;
  const parent = getConversations()?.find((c) => c.cliSessionId === conv.forkOf);
  return parent ? conversationTitle(parent) || undefined : undefined;
}

function buildConversationRow(conv: ClaudeConversation, openSessionId: string | undefined, now: number, locale: string, onTypeset: () => void): HTMLElement {
  const row = document.createElement('div');
  const unavailable = !conv.projectCwd || !conv.cwdExists;
  // Claude Code is running it in its daemon (/fork, /background): opening it
  // attaches to that session (see pty-manager), and it can't be deleted.
  const liveBackground = !!conv.background?.live;
  row.className = 'conv-item' + (openSessionId ? ' open' : '') + (unavailable ? ' unavailable' : '') + (liveBackground ? ' background' : '');
  if (openSessionId) row.dataset.sessionId = openSessionId;
  const status = openSessionId ? getStatus(openSessionId) : null;
  const meta = [formatRelativeTime(conv.updatedAt, now, locale), t('conversations.turns', { count: conv.turns })];
  if (liveBackground) meta.unshift(t('conversations.background'));
  const parentTitle = forkParentTitle(conv);
  if (parentTitle) meta.push(t('conversations.forkOf', { title: parentTitle }));
  if (conv.gitBranch) meta.push(conv.gitBranch);
  // An open conversation is still being written to, so it can't be deleted
  // until its tab is closed; the same goes for one running in the background.
  const deletable = !openSessionId && !liveBackground && !!conv.transcriptPath;
  const typesettable = !!conv.transcriptPath;
  const title = conversationTitle(conv);
  row.innerHTML = `
    <span class="conv-dot${status ? ` project-status ${status}` : ''}" aria-hidden="true"></span>
    <div class="conv-main">
      <div class="conv-title">${esc(title || t('conversations.untitled'))}</div>
      <div class="conv-meta">${esc(meta.join(' · '))}</div>
    </div>
    ${liveBackground ? `<button type="button" class="conv-stop" aria-label="${esc(t('conversations.stopBackground'))}">${ICON_STOP}</button>` : ''}
    ${typesettable ? `<button type="button" class="conv-typeset" aria-label="${esc(t('preview.openConversationView'))}">${ICON_TYPESET}</button>` : ''}
    ${deletable ? `<button type="button" class="conv-delete" aria-label="${esc(t('conversations.delete'))}">${ICON_TRASH}</button>` : ''}
  `;
  const typesetBtn = row.querySelector<HTMLButtonElement>('.conv-typeset');
  if (typesetBtn) {
    attachHoverCard(typesetBtn, t('preview.openConversationView'));
    typesetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onTypeset();
    });
  }
  const stopBtn = row.querySelector<HTMLButtonElement>('.conv-stop');
  if (stopBtn) {
    attachHoverCard(stopBtn, t('conversations.stopBackground'));
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmStopBackground(conv);
    });
  }
  const deleteBtn = row.querySelector<HTMLButtonElement>('.conv-delete');
  if (deleteBtn) {
    attachHoverCard(deleteBtn, t('conversations.delete'));
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeleteConversation(conv);
    });
  }
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: t('preview.openConversationView'), action: onTypeset, disabled: !typesettable },
      ...(liveBackground ? [{ label: t('conversations.stopBackground'), action: () => confirmStopBackground(conv) }] : []),
      {
        label: deletable ? t('conversations.delete') : liveBackground ? t('conversations.deleteBackground') : t('conversations.deleteOpen'),
        separatorBefore: true,
        danger: deletable,
        disabled: !deletable,
        action: () => confirmDeleteConversation(conv),
      },
    ]);
  });
  const command = liveBackground && conv.background ? `claude attach ${conv.background.short}` : `claude -r ${conv.cliSessionId}`;
  const hint = unavailable
    ? t('conversations.folderMissing')
    : [conv.firstPrompt && conv.firstPrompt !== title ? conv.firstPrompt : '', command]
      .filter(Boolean)
      .join('\n');
  row.title = hint;
  row.dataset.cliSessionId = conv.cliSessionId;
  if (!unavailable) row.addEventListener('click', () => (openSessionId ? focusTab(openSessionId) : openConversation(conv)));
  return row;
}

function buildFolder(group: FolderGroup, hooks: ConversationTreeHooks, openIds: Map<string, string>, now: number, locale: string): HTMLElement | null {
  const visible = group.conversations.filter(matchesFilter);
  const folderMatches = !!filterText && (group.name.toLowerCase().includes(filterText) || group.path.toLowerCase().includes(filterText));
  if (filterText && !folderMatches && visible.length === 0) return null;
  const list = folderMatches && visible.length === 0 ? group.conversations : visible;

  const isActive = !!group.project && group.project.id === appState.activeProjectId;
  const open = isExpanded(group);

  const wrapper = document.createElement('div');
  wrapper.className = 'project-row conv-folder' + (isActive ? ' active' : '') + (group.exists ? '' : ' missing');

  const header = document.createElement('div');
  header.className = 'project-item conv-folder-header' + (isActive ? ' active' : '');
  if (group.project) header.dataset.projectId = group.project.id;
  const lead = isActive
    ? `<div class="project-avatar" aria-hidden="true">${esc(projectInitial(group.name))}</div>`
    : group.project
      ? `<span class="project-status ${getProjectStatus(group.project)}" aria-hidden="true"></span>`
      : '<span class="conv-folder-icon" aria-hidden="true"></span>';
  const unread = group.project && hasUnreadInProject(group.project.id) ? ' unread' : '';
  header.innerHTML = `
    ${lead}
    <div class="project-main">
      <div class="project-name${unread}">${esc(group.name)}</div>
      <div class="project-path">${esc(group.path ? tildePath(group.path) : t('conversations.unknownFolder'))}</div>
    </div>
    <span class="conv-count">${group.conversations.length}</span>
    <button type="button" class="conv-folder-add" aria-label="${esc(t('conversations.addMenu'))}" aria-haspopup="menu">+</button>
    <span class="conv-chevron${open ? ' open' : ''}" aria-hidden="true"></span>
  `;

  if (group.path) {
    for (const el of header.querySelectorAll<HTMLElement>('.project-name, .project-path')) el.title = group.path;
  }

  // + opens a menu: a new chat in this folder, a chat with any team member
  // (in this folder — the card names the project), or the Team panel.
  const addBtn = header.querySelector<HTMLButtonElement>('.conv-folder-add')!;
  attachHoverCard(addBtn, t('conversations.addMenu'));
  if (!group.exists && !group.project) addBtn.disabled = true;
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = addBtn.getBoundingClientRect();
    const members = appState.getTeamMembers();
    const inFolder = (run: (project: ProjectRecord) => void) => () => {
      const project = ensureProjectFor(group);
      if (!project) return;
      expanded.set(group.key, true);
      run(project);
    };
    const options: MenuOption[] = [
      {
        label: t('conversations.addConversation'),
        action: inFolder((project) => { appState.addSession(project.id, defaultSessionName(project)); }),
      },
      ...members.map((member, i) => ({
        label: t('conversations.chatWithMember', { name: member.name }),
        separatorBefore: i === 0,
        action: inFolder((project) => { appState.startTeamChat(project.id, member); }),
      })),
      {
        label: members.length > 0 ? t('conversations.manageTeam') : t('conversations.addTeamMember'),
        separatorBefore: members.length === 0,
        action: inFolder((project) => { appState.openTeamTab(project.id); }),
      },
    ];
    showContextMenu(rect.left, rect.bottom + 4, options);
  });

  header.addEventListener('click', () => {
    if (group.project && !isActive) {
      expanded.set(group.key, true);
      appState.setActiveProject(group.project.id);
      return;
    }
    expanded.set(group.key, !open);
    renderInto?.();
  });

  if (group.project) {
    const project = group.project;
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      hooks.showProjectContextMenu(e.clientX, e.clientY, project);
    });
  }

  wrapper.appendChild(header);
  const view = isActive && group.project ? cardView.get(group.key) ?? 'conversations' : 'conversations';
  if (isActive && group.project) {
    wrapper.appendChild(buildViewSwitch(group, view));
    for (const el of hooks.buildActiveExtras(group.project)) wrapper.appendChild(el);
  }

  if (open && view === 'files' && group.project) {
    wrapper.appendChild(buildFileTree(group.project));
  } else if (open) {
    const listEl = document.createElement('div');
    listEl.className = 'conv-list';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'conv-empty';
      empty.textContent = t('conversations.emptyFolder');
      listEl.appendChild(empty);
    }
    const limit = showAll.has(group.key) || filterText ? list.length : PAGE_SIZE;
    for (const conv of list.slice(0, limit)) {
      const onTypeset = () => {
        const project = ensureProjectFor(group);
        if (project) openConversationView(project.id, conv.transcriptPath, conversationTitle(conv));
      };
      listEl.appendChild(buildConversationRow(conv, openIds.get(conv.cliSessionId), now, locale, onTypeset));
    }
    if (list.length > limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'conv-more';
      more.textContent = t('conversations.showMore', { count: list.length - limit });
      more.addEventListener('click', () => {
        showAll.add(group.key);
        renderInto?.();
      });
      listEl.appendChild(more);
    }
    wrapper.appendChild(listEl);
  }
  return wrapper;
}

/** 对话 | 文件 at the top of the active card. */
function buildViewSwitch(group: FolderGroup, view: 'conversations' | 'files'): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'conv-view-switch';
  bar.setAttribute('role', 'tablist');
  for (const [key, label] of [['conversations', t('preview.tabConversations')], ['files', t('preview.tabFiles')]] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'conv-view-btn' + (view === key ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(view === key));
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardView.set(group.key, key);
      expanded.set(group.key, true);
      if (key === 'files' && group.path) loadFileTree(group.path, true);
      renderInto?.();
    });
    bar.appendChild(btn);
  }
  return bar;
}

function loadFileTree(dir: string, force = false): void {
  const cached = fileTrees.get(dir);
  if (cached?.loading || (!force && cached && Date.now() - cached.at < TREE_STALE_MS)) return;
  fileTrees.set(dir, { tree: cached?.tree ?? null, loading: true, at: cached?.at ?? 0 });
  void window.vibeyard.fs
    .previewTree(dir)
    .catch(() => null)
    .then((tree) => {
      fileTrees.set(dir, { tree, loading: false, at: Date.now() });
      renderInto?.();
    });
}

function countFiles(node: PreviewTreeNode): number {
  return node.files.length + node.dirs.reduce((n, d) => n + countFiles(d), 0);
}

/** The project's folders and previewable files; a file opens in a preview tab. */
function buildFileTree(project: ProjectRecord): HTMLElement {
  const listEl = document.createElement('div');
  listEl.className = 'conv-list file-tree';
  loadFileTree(project.path);
  const entry = fileTrees.get(project.path);
  const tree = entry?.tree;
  if (!tree) {
    const status = document.createElement('div');
    status.className = 'conv-empty';
    status.textContent = entry?.loading ? t('preview.scanning') : t('preview.scanFailed');
    listEl.appendChild(status);
    return listEl;
  }
  if (countFiles(tree) === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = t('preview.noFiles');
    listEl.appendChild(empty);
    return listEl;
  }
  const now = Date.now();
  const locale = getLocale();
  const addNode = (node: PreviewTreeNode, depth: number) => {
    for (const dir of node.dirs) {
      const isOpen = openDirs.has(dir.path);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'file-tree-row file-tree-dir';
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.title = dir.path;
      row.innerHTML = `<span class="conv-chevron${isOpen ? ' open' : ''}" aria-hidden="true"></span><span class="file-tree-icon">${ICON_FOLDER}</span><span class="file-tree-name">${esc(dir.name)}</span><span class="file-tree-meta">${countFiles(dir)}</span>`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen) openDirs.delete(dir.path);
        else openDirs.add(dir.path);
        renderInto?.();
      });
      listEl.appendChild(row);
      if (isOpen) addNode(dir, depth + 1);
    }
    for (const file of node.files) {
      const row = document.createElement('button');
      row.type = 'button';
      const pdf = /\.pdf$/i.test(file.name);
      row.className = 'file-tree-row file-tree-file';
      row.style.paddingLeft = `${10 + depth * 14 + 16}px`;
      row.title = file.path;
      row.innerHTML = `<span class="file-tree-badge ${pdf ? 'pdf' : 'md'}">${pdf ? 'PDF' : 'MD'}</span><span class="file-tree-name">${esc(file.name)}</span><span class="file-tree-meta">${esc(formatRelativeTime(file.mtimeMs, now, locale))}</span>`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        void openFileReaderChecked(project.id, file.path);
      });
      listEl.appendChild(row);
    }
  };
  addNode(tree, 0);
  if (tree.truncated) {
    const note = document.createElement('div');
    note.className = 'conv-empty file-tree-note';
    note.textContent = t('preview.truncated');
    listEl.appendChild(note);
  }
  return listEl;
}

let renderInto: (() => void) | null = null;

/**
 * A menu of the folders a chat can open in — Vibeyard projects and existing
 * transcript folders, the current project first, then by recent activity.
 * `onPick` receives the project, created from the folder if needed.
 */
export function showProjectPicker(x: number, y: number, onPick: (project: ProjectRecord) => void): void {
  const active = appState.activeProjectId;
  const folders = buildGroups(getConversations() ?? [])
    .filter((g) => g.project || (g.path && g.exists))
    .sort((a, b) => Number(b.project?.id === active) - Number(a.project?.id === active));
  showContextMenu(x, y, folders.map((group) => ({
    label: group.project?.id === active ? t('conversations.currentProject', { name: group.name }) : group.name,
    action: () => {
      const project = ensureProjectFor(group);
      if (project) onPick(project);
    },
  })));
}

/**
 * Render the folder tree into `container`. `rerender` re-invokes the owner's
 * render so local toggles (expand, show more) go through the same pipeline.
 */
export function renderConversationTree(container: HTMLElement, hooks: ConversationTreeHooks, rerender: () => void): void {
  renderInto = rerender;
  const conversations = getConversations();
  if (conversations === null && !isConversationsLoading()) void refreshConversations();

  if (conversations === null) {
    const status = document.createElement('div');
    status.className = 'conv-empty conv-status';
    status.textContent = conversationsFailed() ? t('conversations.loadFailed') : t('conversations.loading');
    container.appendChild(status);
    // Projects still render so the active card's actions stay reachable.
  }

  const groups = buildGroups(conversations ?? []);
  const openIds = openSessionsByCliId(conversations ?? []);
  const now = Date.now();
  const locale = getLocale();
  let shown = 0;
  for (const group of groups) {
    const el = buildFolder(group, hooks, openIds, now, locale);
    if (el) {
      container.appendChild(el);
      shown++;
    }
  }
  if (shown === 0 && conversations !== null) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty conv-status';
    empty.textContent = filterText ? t('conversations.noMatches') : t('conversations.none');
    container.appendChild(empty);
  }
}

/**
 * Show changed conversation names in place, without rebuilding the tree: a
 * rename is often finished by a click into the sidebar, and replacing the rows
 * under the pointer would swallow that click.
 */
export function refreshConversationTitles(container: HTMLElement): void {
  const byId = new Map((getConversations() ?? []).map((c) => [c.cliSessionId, c]));
  for (const row of container.querySelectorAll<HTMLElement>('.conv-item[data-cli-session-id]')) {
    const conv = byId.get(row.dataset.cliSessionId!);
    const titleEl = row.querySelector('.conv-title');
    if (conv && titleEl) titleEl.textContent = conversationTitle(conv) || t('conversations.untitled');
  }
}

/** Whether rows are being filtered by the search box (names decide what matches). */
export function isConversationFilterActive(): boolean {
  return !!filterText;
}
