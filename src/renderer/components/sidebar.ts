import { appState, MAX_PROJECT_NAME_LENGTH, ProjectRecord } from '../state.js';
import { showModal, closeModal, showConfirmDialog } from './modal.js';
import { showPreferencesModal } from './preferences-modal.js';
import { onChange as onUnreadChange } from '../session-unread.js';
import { onChange as onActivityChange } from '../session-activity.js';
import { getProjectStatus } from '../project-status.js';
import { basename, lastSeparatorIndex } from '../../shared/platform.js';
import { deriveProjectName } from '../../shared/project-name.js';
import { esc } from '../dom-utils.js';
import {
  closeSessionHistory,
  clearProjectState as clearSessionHistoryState,
} from './session-history.js';
import { attachHoverCard } from './hover-card.js';
import { mountGitPanel, closeGitPanel } from './git-panel.js';
import { gitChangeCount, onChange as onGitStatusChange } from '../git-status.js';
import { ICON_SESSIONS, ICON_GIT } from '../icons.js';
import { onLocaleChange, t } from '../i18n.js';
import { getStatus } from '../session-activity.js';
import { renderConversationTree, setConversationFilter } from './conversation-tree.js';
import {
  isConversationsLoading,
  onClaudeHistoryChange,
  refreshConversations,
} from '../claude-history-store.js';

type ProjectPanel = 'history' | 'git' | null;
const projectPanelOpen = new Map<string, ProjectPanel>();

/** How often the conversation tree re-reads transcripts (cheap: unchanged files are cached). */
const HISTORY_POLL_MS = 30_000;

let historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const projectListEl = document.getElementById('project-list')!;
const convToolbarEl = document.getElementById('conv-toolbar')!;
let activeProjectContextMenu: HTMLElement | null = null;
let renamingProjectId: string | null = null;
const btnAddProject = document.getElementById('btn-add-project')!;
const btnPreferences = document.getElementById('btn-preferences')!;
const sidebarEl = document.getElementById('sidebar')!;
const resizeHandle = document.getElementById('sidebar-resize-handle')!;

const btnToggleSidebar = document.getElementById('btn-toggle-sidebar')!;

const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 500;


export function toggleSidebar(): void {
  appState.toggleSidebar();
}

function applySidebarCollapsed(): void {
  const collapsed = appState.sidebarCollapsed;
  sidebarEl.classList.toggle('collapsed', collapsed);
  resizeHandle.style.display = collapsed ? 'none' : '';
}

export function initSidebar(): void {
  btnAddProject.addEventListener('click', promptNewProject);
  btnPreferences.addEventListener('click', () => showPreferencesModal());
  btnToggleSidebar.addEventListener('click', toggleSidebar);

  initResizeHandle();
  initConversationToolbar();
  appState.on('state-loaded', () => {
    if (appState.sidebarWidth) {
      sidebarEl.style.width = appState.sidebarWidth + 'px';
    }
    applySidebarCollapsed();
    render();
  });
  appState.on('sidebar-toggled', () => {
    applySidebarCollapsed();
    render();
  });
  onClaudeHistoryChange(render);
  // appState.load() renders the sidebar before initI18n() sets the saved locale.
  onLocaleChange(render);
  // New or closed sessions write transcripts; pick them up shortly after.
  appState.on('session-added', scheduleHistoryRefresh);
  appState.on('session-removed', scheduleHistoryRefresh);
  setInterval(refreshVisibleHistory, HISTORY_POLL_MS);
  window.addEventListener('focus', refreshVisibleHistory);
  appState.on('project-added', render);
  appState.on('project-removed', (id) => {
    if (typeof id === 'string') {
      projectPanelOpen.delete(id);
      clearSessionHistoryState(id);
    }
    render();
  });
  appState.on('project-changed', render);
  appState.on('session-added', render);
  appState.on('session-removed', render);
  appState.on('layout-changed', render);

  onUnreadChange(render);
  // Keep the active project's Git tab badge in sync. Surgical when the button is
  // already present; a full render only when repo-ness first becomes known (the
  // button needs to appear/disappear).
  onGitStatusChange((projectId) => {
    if (projectId !== appState.activeProjectId) return;
    const gitBtn = projectListEl.querySelector('.project-row.active .project-action-btn.git-toggle');
    const count = gitChangeCount(projectId);
    const gitEnabled = appState.preferences.sidebarViews?.gitPanel ?? true;
    if (!gitBtn) {
      if (count !== null && gitEnabled) render();
      return;
    }
    if (count === null || !gitEnabled) { render(); return; } // repo went away / disabled
    const badge = gitBtn.querySelector('.project-action-badge');
    if (badge) {
      badge.textContent = String(count);
      badge.classList.toggle('hidden', count === 0);
    }
  });
  // Status ticks are frequent — update just the affected row's dot rather than
  // rebuilding the whole list (mirrors the tab-bar's surgical update).
  onActivityChange((sessionId) => {
    const convDot = projectListEl.querySelector(`.conv-item[data-session-id="${sessionId}"] .conv-dot`);
    if (convDot) convDot.className = `conv-dot project-status ${getStatus(sessionId)}`;
    const project = appState.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
    if (!project || project.id === appState.activeProjectId) return;
    const dot = projectListEl.querySelector(
      `.project-item[data-project-id="${project.id}"] .project-status`,
    );
    if (dot) dot.className = `project-status ${getProjectStatus(project)}`;
  });
  appState.on('preferences-changed', render);
  // Adding/removing a profile or changing a default flips the badge's
  // visibility/label on the active card.
  appState.on('profiles-changed', render);

  document.addEventListener('click', hideProjectContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideProjectContextMenu(); });

  render();
}

interface RenderOpts {
  historyEnabled: boolean;
  gitEnabled: boolean;
}

function render(): void {
  if (renamingProjectId) return;
  hideProjectContextMenu();

  applyToolbarStrings();
  projectListEl.innerHTML = '';
  const opts: RenderOpts = {
    historyEnabled:
      (appState.preferences.sidebarViews?.sessionHistory ?? true) &&
      appState.preferences.sessionHistoryEnabled,
    gitEnabled: appState.preferences.sidebarViews?.gitPanel ?? true,
  };
  renderConversationTree(projectListEl, {
    buildActiveExtras: (project) => buildActiveProjectExtras(project, opts),
    showProjectContextMenu,
  }, render);
}

/** The toolbar is built before the saved locale loads; keep its strings current. */
function applyToolbarStrings(): void {
  const search = convToolbarEl.querySelector<HTMLInputElement>('.conv-search');
  if (search) search.placeholder = t('conversations.searchPlaceholder');
  convToolbarEl.querySelector('.conv-search-clear')?.setAttribute('aria-label', t('conversations.clearSearch'));
  const refreshBtn = convToolbarEl.querySelector('.conv-refresh');
  refreshBtn?.setAttribute('title', t('conversations.refresh'));
  refreshBtn?.setAttribute('aria-label', t('conversations.refresh'));
  refreshBtn?.classList.toggle('spinning', isConversationsLoading());
}

/** Search box + refresh button above the conversation tree (outside it, so typing keeps focus). */
function initConversationToolbar(): void {
  convToolbarEl.innerHTML = `
    <div class="conv-search-wrap">
      <svg class="conv-search-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" class="conv-search" spellcheck="false" placeholder="${esc(t('conversations.searchPlaceholder'))}">
      <button type="button" class="conv-search-clear" hidden aria-label="${esc(t('conversations.clearSearch'))}">&times;</button>
    </div>
    <button type="button" class="icon-btn conv-refresh" title="${esc(t('conversations.refresh'))}" aria-label="${esc(t('conversations.refresh'))}">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
    </button>
  `;
  const input = convToolbarEl.querySelector<HTMLInputElement>('.conv-search');
  const clear = convToolbarEl.querySelector<HTMLButtonElement>('.conv-search-clear');
  if (!input || !clear) return;
  const apply = () => {
    setConversationFilter(input.value);
    clear.hidden = !input.value;
    render();
  };
  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      apply();
    }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    apply();
    input.focus();
  });
  convToolbarEl.querySelector('.conv-refresh')?.addEventListener('click', () => { void refreshConversations(true); });
}

function refreshVisibleHistory(): void {
  if (document.visibilityState === 'hidden') return;
  void refreshConversations();
}

function scheduleHistoryRefresh(): void {
  if (historyRefreshTimer) clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    refreshVisibleHistory();
  }, 3000);
}

/**
 * Render plan for the project list: every project in its stored
 * (user-reorderable) order, each flagged `isActive` when it is the current
 * project. The active project is marked **in place** — it is never pinned to
 * the top, so selecting a project does not reorder the list.
 */
export function projectRenderOrder(
  projects: ProjectRecord[],
  activeProjectId: string | null,
): Array<{ project: ProjectRecord; isActive: boolean }> {
  return projects.map((project) => ({ project, isActive: project.id === activeProjectId }));
}

/**
 * Label for the project's effective Claude profile, or `undefined` when no badge
 * should render. Shown only when more than one Claude profile exists (mirrors the
 * session status-line gate in terminal-pane.ts). Resolution matches `resolveProfile`:
 * `project.defaultProfileId ?? preferences.defaultProfileId`; a missing/unknown id
 * (base ~/.claude) is labeled "Default".
 */
export function projectProfileLabel(project: ProjectRecord): string | undefined {
  const providerProfiles = appState.profiles.filter((p) => p.providerId === 'claude');
  if (providerProfiles.length <= 1) return undefined;
  const id = project.defaultProfileId ?? appState.preferences.defaultProfileId;
  if (!id) return t('sidebar.default');
  return providerProfiles.find((p) => p.id === id)?.name ?? t('sidebar.default');
}

/**
 * Segmented actions (Git) plus any open panel for the active project's card.
 * The 对话 view lists conversations itself, so the per-project Sessions history
 * panel is left out here; Team lives in the card's + menu.
 */
function buildActiveProjectExtras(project: ProjectRecord, opts: RenderOpts): HTMLElement[] {
  const { gitEnabled } = opts;
  // A 'git' panel only stays open while the git view is enabled in prefs.
  let openPanel = projectPanelOpen.get(project.id) ?? null;
  if (openPanel === 'git' && !gitEnabled) openPanel = null;
  if (openPanel === 'history') openPanel = null;
  const actions = buildProjectActions(project, openPanel, { historyEnabled: false, gitEnabled });
  const out: HTMLElement[] = actions.childElementCount > 0 ? [actions] : [];

  if (openPanel === 'git') {
    const panelContainer = document.createElement('div');
    panelContainer.className = 'project-panel project-panel-git';
    mountGitPanel(project, panelContainer);
    out.push(panelContainer);
  }
  return out;
}

function buildProjectActions(
  project: ProjectRecord,
  openPanel: ProjectPanel,
  opts: { historyEnabled: boolean; gitEnabled: boolean },
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'project-actions';

  // Only the panel toggles (Sessions, Git) reflect a selected state, derived
  // from openPanel below.
  if (opts.historyEnabled) {
    const historyBtn = makeActionButton(t('sidebar.sessions'), ICON_SESSIONS, openPanel === 'history');
    historyBtn.classList.add('panel-toggle');
    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setProjectPanel(project.id, openPanel === 'history' ? null : 'history');
    });
    actions.appendChild(historyBtn);
  }

  // Git changes — only for git repos. The badge surfaces the change count so the
  // tab still gives passive awareness without expanding (mirrors the old panel).
  const gitCount = gitChangeCount(project.id);
  if (opts.gitEnabled && gitCount !== null) {
    const gitBtn = makeActionButton(t('sidebar.git'), ICON_GIT, openPanel === 'git');
    gitBtn.classList.add('panel-toggle', 'git-toggle');
    const badge = document.createElement('span');
    badge.className = 'project-action-badge' + (gitCount === 0 ? ' hidden' : '');
    badge.textContent = String(gitCount);
    gitBtn.appendChild(badge);
    gitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setProjectPanel(project.id, openPanel === 'git' ? null : 'git');
    });
    actions.appendChild(gitBtn);
  }

  return actions;
}

function makeActionButton(label: string, iconSvg: string, active: boolean, hint?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'project-action-btn' + (active ? ' active' : '');
  btn.innerHTML = `<span class="action-icon" aria-hidden="true">${iconSvg}</span><span class="action-label">${esc(label)}</span>`;
  attachHoverCard(btn, hint ?? label);
  return btn;
}

function setProjectPanel(projectId: string, next: ProjectPanel): void {
  const current = projectPanelOpen.get(projectId) ?? null;
  if (current === 'history' && next !== 'history') closeSessionHistory(projectId);
  if (current === 'git' && next !== 'git') closeGitPanel();
  if (next === null) {
    projectPanelOpen.delete(projectId);
  } else {
    projectPanelOpen.set(projectId, next);
  }
  render();
}

/** Toggle the Git changes panel on the active project (Cmd/Ctrl+Shift+G). */
export function toggleGitPanel(): void {
  const project = appState.activeProject;
  if (!project) return;
  if (!(appState.preferences.sidebarViews?.gitPanel ?? true)) return;
  if (gitChangeCount(project.id) === null) return; // not a git repo
  const current = projectPanelOpen.get(project.id) ?? null;
  setProjectPanel(project.id, current === 'git' ? null : 'git');
}

/**
 * Add a project: pick its folder and it's added straight away, named after the
 * folder (rename it later from the project card's context menu). A folder that
 * is already a project just switches to it.
 */
export async function promptNewProject(): Promise<void> {
  const dir = await window.vibeyard.fs.browseDirectory();
  if (!dir) return;
  const existing = appState.projects.find((p) => p.path === dir);
  if (existing) {
    appState.setActiveProject(existing.id);
    return;
  }
  appState.addProject(deriveProjectName(dir), dir, appState.preferences.defaultProfileId || undefined);
}

function initResizeHandle(): void {
  let dragging = false;

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizeHandle.classList.add('active');
    document.body.classList.add('sidebar-resizing');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // If the mouse was released outside the window, mouseup never fired — detect via buttons and tear down.
    if (!e.buttons) {
      dragging = false;
      resizeHandle.classList.remove('active');
      document.body.classList.remove('sidebar-resizing');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      appState.setSidebarWidth(parseInt(sidebarEl.style.width, 10));
      return;
    }
    const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
    sidebarEl.style.width = width + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove('active');
    document.body.classList.remove('sidebar-resizing');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    appState.setSidebarWidth(parseInt(sidebarEl.style.width, 10));
  });
}

function confirmRemoveProject(project: ProjectRecord): void {
  const historyCount = project.sessionHistory?.length ?? 0;

  const parts: string[] = [];
  if (historyCount > 0) {
    const noun = historyCount === 1
      ? t('sidebar.removeConfirm.sessionsHistoryNounSingular')
      : t('sidebar.removeConfirm.sessionsHistoryNounPlural');
    parts.push(t('sidebar.removeConfirm.sessionsHistory', { count: historyCount, noun }));
  }

  const message = parts.length > 0
    ? t('sidebar.removeConfirm.withDataMessage', { name: project.name, parts: parts.join(' and ') })
    : t('sidebar.removeConfirm.emptyMessage', { name: project.name });
  showConfirmDialog(t('sidebar.removeConfirm.title'), message, {
    confirmLabel: t('sidebar.removeConfirm.confirmLabel'),
    onConfirm: () => appState.removeProject(project.id),
  });
}

function startProjectRename(project: ProjectRecord): void {
  const el = projectListEl.querySelector(
    `.project-item[data-project-id="${project.id}"]`,
  ) as HTMLElement | null;
  const nameEl = el?.querySelector('.project-name') as HTMLElement | null;
  if (!nameEl || nameEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.maxLength = MAX_PROJECT_NAME_LENGTH;
  input.value = project.name;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  renamingProjectId = project.id;

  let committed = false;
  const finish = (newName: string | null) => {
    if (committed) return;
    committed = true;
    input.remove();
    renamingProjectId = null;
    if (newName && newName !== project.name) {
      appState.renameProject(project.id, newName);
    } else {
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(input.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(null);
    }
  });

  input.addEventListener('blur', () => finish(input.value.trim()));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function showProjectContextMenu(x: number, y: number, project: ProjectRecord): void {
  hideProjectContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const renameItem = document.createElement('div');
  renameItem.className = 'tab-context-menu-item';
  renameItem.textContent = t('contextMenu.project.rename');
  renameItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideProjectContextMenu();
    startProjectRename(project);
  });

  const hasSessions = project.sessions.length > 0;

  const closeAllItem = document.createElement('div');
  closeAllItem.className = 'tab-context-menu-item' + (!hasSessions ? ' disabled' : '');
  closeAllItem.textContent = t('contextMenu.project.closeAllSessions');
  if (hasSessions) {
    closeAllItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideProjectContextMenu();
      appState.removeAllSessions(project.id);
    });
  }

  const separator = document.createElement('div');
  separator.className = 'tab-context-menu-separator';

  // Project Settings — currently just the default profile, shown only when
  // the user has Claude profiles to choose from.
  const claudeProfiles = appState.profiles.filter((p) => p.providerId === 'claude');
  let settingsItem: HTMLDivElement | null = null;
  if (claudeProfiles.length > 0) {
    settingsItem = document.createElement('div');
    settingsItem.className = 'tab-context-menu-item';
    settingsItem.textContent = t('contextMenu.project.settings');
    settingsItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideProjectContextMenu();
      promptProjectSettings(project);
    });
  }

  const removeItem = document.createElement('div');
  removeItem.className = 'tab-context-menu-item';
  removeItem.textContent = t('contextMenu.project.removeProject');
  removeItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideProjectContextMenu();
    confirmRemoveProject(project);
  });

  menu.appendChild(renameItem);
  menu.appendChild(closeAllItem);
  if (settingsItem) menu.appendChild(settingsItem);
  menu.appendChild(separator);
  menu.appendChild(removeItem);
  document.body.appendChild(menu);
  activeProjectContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
}

function hideProjectContextMenu(): void {
  if (activeProjectContextMenu) {
    activeProjectContextMenu.remove();
    activeProjectContextMenu = null;
  }
}

/** Project-level settings dialog. Currently just the default Claude profile. */
function promptProjectSettings(project: ProjectRecord): void {
  const claudeProfiles = appState.profiles.filter((p) => p.providerId === 'claude');
  showModal(t('sidebar.projectSettings.title'), [
    {
      label: t('sidebar.projectSettings.defaultProfileLabel'),
      id: 'profile',
      type: 'select',
      defaultValue: project.defaultProfileId ?? '',
      options: [
        { value: '', label: t('sidebar.defaultProfileOption') },
        ...claudeProfiles.map((p) => ({ value: p.id, label: p.name })),
      ],
    },
  ], (values) => {
    appState.setProjectDefaultProfile(project.id, values['profile'] || undefined);
    closeModal();
  });
}

