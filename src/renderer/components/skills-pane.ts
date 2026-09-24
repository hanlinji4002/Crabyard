import { appState } from '../state.js';
import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';
import type { SkillInfo } from '../../shared/types.js';

// The right column's Skills pane: the Claude Code skills Claude can use — the
// user's (~/.claude/skills) and the open project's (.claude/skills) — each with
// a switch. Switching one off writes `"skillOverrides": {"<name>": "off"}` to
// Claude Code's settings (see main/skills.ts); Claude Code reloads its skills
// when that file changes.

const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';

let skills: SkillInfo[] | null = null;
let loadedFor: string | undefined;
let loading = false;
let failure = '';
/** Skills whose switch is being written, so a double click can't race it. */
const pending = new Set<string>();

function projectPath(): string | undefined {
  return appState.activeProject?.path;
}

function key(skill: SkillInfo): string {
  return `${skill.scope}:${skill.name}`;
}

/** Re-read the skills, then `rerender` the pane. */
export async function refreshSkills(rerender: () => void): Promise<void> {
  if (loading) return;
  loading = true;
  const project = projectPath();
  try {
    skills = await window.vibeyard.skills.list(project);
    loadedFor = project;
    failure = '';
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
    rerender();
  }
}

async function toggle(skill: SkillInfo, rerender: () => void): Promise<void> {
  const k = key(skill);
  if (pending.has(k)) return;
  pending.add(k);
  const next = !skill.enabled;
  skill.enabled = next;
  rerender();
  const res = await window.vibeyard.skills.setEnabled(skill.name, skill.scope, projectPath(), next).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  pending.delete(k);
  if (!res.ok) {
    skill.enabled = !next;
    failure = res.error ?? t('skills.writeFailed');
  } else {
    failure = '';
    skill.override = next ? null : 'off';
  }
  rerender();
}

function rowHtml(skill: SkillInfo): string {
  const partial = skill.enabled && skill.override && skill.override !== 'on' ? `<span class="skill-tag">${esc(skill.override)}</span>` : '';
  return `
    <div class="skill-row${skill.enabled ? '' : ' off'}" title="${esc(skill.dir)}">
      <div class="skill-text">
        <div class="skill-name-line"><span class="skill-name">${esc(skill.name)}</span>${partial}</div>
        ${skill.description ? `<div class="skill-desc">${esc(skill.description)}</div>` : ''}
      </div>
      <button type="button" class="skill-switch" role="switch" aria-checked="${skill.enabled}" aria-label="${esc(skill.name)}" data-key="${esc(key(skill))}">
        <span class="skill-knob"></span>
      </button>
    </div>`;
}

export function renderSkillsPane(container: HTMLElement, opts: { onClose: () => void; rerender: () => void }): void {
  if ((skills === null || loadedFor !== projectPath()) && !loading) void refreshSkills(opts.rerender);
  const list = skills ?? [];
  const on = list.filter((s) => s.enabled).length;
  const scrollTop = container.scrollTop;

  const header = `
    <div class="sidebar-view-header">
      <span class="sidebar-view-title">${esc(t('skills.title'))}</span>
      <div class="sidebar-view-actions">
        ${list.length ? `<span class="skills-count">${esc(t('skills.count', { on, total: list.length }))}</span>` : ''}
        <button type="button" class="icon-btn skills-refresh${loading ? ' spinning' : ''}" title="${esc(t('skills.refresh'))}" aria-label="${esc(t('skills.refresh'))}">${ICON_REFRESH}</button>
        <button type="button" class="icon-btn usage-panel-close" title="${esc(t('usagePanel.hide'))}" aria-label="${esc(t('usagePanel.hide'))}">&times;</button>
      </div>
    </div>`;

  let body: string;
  if (skills === null) {
    body = `<div class="chg-empty">${esc(t('skills.loading'))}</div>`;
  } else if (!list.length) {
    body = `<div class="chg-empty">${esc(t('skills.empty'))}</div>`;
  } else {
    const groups: [string, SkillInfo[]][] = [
      [t('skills.user'), list.filter((s) => s.scope === 'user')],
      [t('skills.project'), list.filter((s) => s.scope === 'project')],
    ];
    body = groups
      .filter(([, items]) => items.length)
      .map(([label, items]) => `<div class="skills-group">${esc(label)}</div>${items.map(rowHtml).join('')}`)
      .join('');
    body += `<div class="chg-note">${esc(t('skills.note'))}</div>`;
  }
  const error = failure ? `<div class="skills-error">${esc(failure)}</div>` : '';

  container.innerHTML = header + error + `<div class="skills-list">${body}</div>`;
  container.scrollTop = scrollTop;
  container.querySelector('.usage-panel-close')!.addEventListener('click', opts.onClose);
  container.querySelector('.skills-refresh')!.addEventListener('click', () => void refreshSkills(opts.rerender));
  container.querySelectorAll<HTMLButtonElement>('.skill-switch').forEach((btn) => {
    const skill = list.find((s) => key(s) === btn.dataset.key);
    if (skill) btn.addEventListener('click', () => void toggle(skill, opts.rerender));
  });
}
