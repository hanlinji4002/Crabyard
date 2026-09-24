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
import type { ClaudeConversation } from '../../shared/types.js';

// The sidebar's 对话 view: every folder that has Claude Code transcripts (plus
// every Vibeyard project) as a collapsible card, newest activity first, with
// its conversations listed underneath. Clicking a conversation reopens it the
// way `/resume` would — `claude -r <id>` in that folder — or focuses its tab
// when it is already open.

const PAGE_SIZE = 8;
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

function matchesFilter(conv: ClaudeConversation): boolean {
  if (!filterText) return true;
  return (
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
  const name = conv.title || conv.cliSessionId.slice(0, 8);
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

function openSessionsByCliId(): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of appState.projects) {
    for (const session of project.sessions) {
      if (session.cliSessionId) map.set(session.cliSessionId, session.id);
    }
  }
  return map;
}

/** Ask first, then move the conversation's transcript to the Trash (restorable). */
function confirmDeleteConversation(conv: ClaudeConversation): void {
  const title = conv.title || t('conversations.untitled');
  showConfirmDialog(t('conversations.deleteTitle'), t('conversations.deleteMessage', { title }), {
    confirmLabel: t('conversations.deleteConfirm'),
    cancelLabel: t('preferences.cancel'),
    onConfirm: () => {
      void window.vibeyard.claudeHistory.trash(conv.transcriptPath).then((result) => {
        void refreshConversations(true);
        if (result.ok) return;
        showConfirmDialog(t('conversations.deleteTitle'), t('conversations.deleteFailed', { error: result.error ?? '' }), {
          confirmLabel: t('preferences.done'),
          onConfirm: () => {},
        });
      });
    },
  });
}

function buildConversationRow(conv: ClaudeConversation, openSessionId: string | undefined, now: number, locale: string): HTMLElement {
  const row = document.createElement('div');
  const unavailable = !conv.projectCwd || !conv.cwdExists;
  row.className = 'conv-item' + (openSessionId ? ' open' : '') + (unavailable ? ' unavailable' : '');
  if (openSessionId) row.dataset.sessionId = openSessionId;
  const status = openSessionId ? getStatus(openSessionId) : null;
  const meta = [formatRelativeTime(conv.updatedAt, now, locale), t('conversations.turns', { count: conv.turns })];
  if (conv.gitBranch) meta.push(conv.gitBranch);
  // An open conversation is still being written to, so it can't be deleted
  // until its tab is closed.
  const deletable = !openSessionId;
  row.innerHTML = `
    <span class="conv-dot${status ? ` project-status ${status}` : ''}" aria-hidden="true"></span>
    <div class="conv-main">
      <div class="conv-title">${esc(conv.title || t('conversations.untitled'))}</div>
      <div class="conv-meta">${esc(meta.join(' · '))}</div>
    </div>
    ${deletable ? `<button type="button" class="conv-delete" aria-label="${esc(t('conversations.delete'))}">${ICON_TRASH}</button>` : ''}
  `;
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
      {
        label: deletable ? t('conversations.delete') : t('conversations.deleteOpen'),
        danger: deletable,
        disabled: !deletable,
        action: () => confirmDeleteConversation(conv),
      },
    ]);
  });
  const hint = unavailable
    ? t('conversations.folderMissing')
    : [conv.firstPrompt && conv.firstPrompt !== conv.title ? conv.firstPrompt : '', `claude -r ${conv.cliSessionId}`]
      .filter(Boolean)
      .join('\n');
  row.title = hint;
  if (!unavailable) row.addEventListener('click', () => openConversation(conv));
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
  if (isActive && group.project) {
    for (const el of hooks.buildActiveExtras(group.project)) wrapper.appendChild(el);
  }

  if (open) {
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
      listEl.appendChild(buildConversationRow(conv, openIds.get(conv.cliSessionId), now, locale));
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
  const openIds = openSessionsByCliId();
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
