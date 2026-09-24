import { appState } from '../../state.js';
import { onChange as onStatusChange } from '../../session-activity.js';
import { onChange as onGitStatusChange } from '../../git-status.js';
import { onChange as onUnreadChange } from '../../session-unread.js';
import { ICON_TERMINAL, ICON_GRID } from '../../icons.js';
import { onShareChange } from '../../sharing/share-manager.js';
import { loadProviderAvailability, hasMultipleAvailableProviders } from '../../provider-availability.js';
import { hideTabContextMenu } from './menu.js';
import { gitStatusEl } from './dom.js';
import { render, updateTabStatus } from './tab-list.js';
import { clearTabScrollState } from './tab-scroll.js';
import { renderGitStatus, showBranchContextMenu } from './git-status-bar.js';
import { promptNewSession, quickNewSession } from './session-menu.js';
import { t } from '../../i18n.js';

const btnAddSession = document.getElementById('btn-add-session')!;
const btnAddSessionMenu = document.getElementById('btn-add-session-menu')!;
const btnSwarm = document.getElementById('btn-toggle-swarm')!;
// Terminal toggle is wired in project-terminal.ts; we only own its icon here.
const btnToggleTerminal = document.getElementById('btn-toggle-terminal')!;

export function initTabBar(): void {
  btnToggleTerminal.innerHTML = ICON_TERMINAL;
  btnSwarm.innerHTML = ICON_GRID;

  btnAddSession.addEventListener('click', () => quickNewSession());
  // The pill's caret opens a custom-session dialog.
  btnAddSessionMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    promptNewSession();
  });
  // 田: the swarm (grid) layout, pressed while on.
  btnSwarm.addEventListener('click', (e) => {
    e.stopPropagation();
    appState.toggleSwarm();
  });
  const syncSwarmButton = () => {
    const on = appState.activeProject?.layout.mode === 'swarm';
    btnSwarm.classList.toggle('active', on);
    btnSwarm.setAttribute('aria-pressed', String(on));
    btnSwarm.title = t('tab.swarmToggle');
    btnSwarm.setAttribute('aria-label', t('tab.swarmToggle'));
  };
  syncSwarmButton();
  for (const event of ['layout-changed', 'project-changed', 'state-loaded', 'preferences-changed'] as const) {
    appState.on(event, syncSwarmButton);
  }
  gitStatusEl.addEventListener('click', (e) => showBranchContextMenu(e));

  // Icons only distinguish providers when multiple are installed
  loadProviderAvailability().then(() => {
    if (hasMultipleAvailableProviders()) render();
  }).catch(() => {});

  appState.on('state-loaded', render);
  appState.on('project-changed', render);
  appState.on('session-added', render);
  appState.on('session-removed', render);
  appState.on('project-removed', (id) => { if (typeof id === 'string') clearTabScrollState(id); });
  appState.on('session-changed', render);
  appState.on('layout-changed', render);
  onShareChange(render);

  onStatusChange(updateTabStatus);

  onUnreadChange(render);

  onGitStatusChange((projectId) => {
    if (projectId === appState.activeProjectId) renderGitStatus();
  });
  appState.on('project-changed', renderGitStatus);

  document.addEventListener('click', hideTabContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTabContextMenu(); });

  render();
}
