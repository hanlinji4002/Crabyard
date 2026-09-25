import { appState } from '../state.js';
import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';
import type { PluginInfo, SkillInfo } from '../../shared/types.js';

// The right column's Skills pane: switches for what Claude Code loads — the
// user's skills (~/.claude/skills), the open project's (.claude/skills) and
// the installed plugins. A skill is switched off with a `skillOverrides` entry
// in Claude Code's settings (see main/skills.ts), which Claude Code picks up
// live; a plugin through `claude plugin enable|disable` (main/plugins.ts),
// which takes effect in conversations started afterwards.

const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';

let skills: SkillInfo[] | null = null;
let plugins: PluginInfo[] | null = null;
let loadedFor: string | undefined;
let loading = false;
let failure = '';
let pluginsFailure = '';
/** Switches being written, so a double click can't race them. */
const pending = new Set<string>();

function projectPath(): string | undefined {
  return appState.activeProject?.path;
}

function skillKey(skill: SkillInfo): string {
  return `skill:${skill.scope}:${skill.name}`;
}

function pluginKey(plugin: PluginInfo): string {
  return `plugin:${plugin.id}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-read the skills and plugins, then `rerender` the pane. */
export async function refreshSkills(rerender: () => void): Promise<void> {
  if (loading) return;
  loading = true;
  const project = projectPath();
  const [skillRes, pluginRes] = await Promise.allSettled([window.vibeyard.skills.list(project), window.vibeyard.plugins.list()]);
  if (skillRes.status === 'fulfilled') {
    skills = skillRes.value;
    loadedFor = project;
    failure = '';
  } else {
    failure = errorText(skillRes.reason);
  }
  if (pluginRes.status === 'fulfilled') {
    plugins = pluginRes.value;
    pluginsFailure = '';
  } else {
    plugins = plugins ?? [];
    pluginsFailure = errorText(pluginRes.reason);
  }
  loading = false;
  rerender();
}

async function flip(key: string, apply: (on: boolean) => void, current: boolean, write: (on: boolean) => Promise<{ ok: boolean; error?: string }>, rerender: () => void): Promise<void> {
  if (pending.has(key)) return;
  pending.add(key);
  const next = !current;
  apply(next);
  rerender();
  const res = await write(next).catch((err: unknown) => ({ ok: false, error: errorText(err) }));
  pending.delete(key);
  if (!res.ok) {
    apply(current);
    failure = res.error ?? t('skills.writeFailed');
  } else {
    failure = '';
  }
  rerender();
}

function switchHtml(key: string, on: boolean, label: string): string {
  return `<button type="button" class="skill-switch${pending.has(key) ? ' busy' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-key="${esc(key)}"><span class="skill-knob"></span></button>`;
}

function skillRowHtml(skill: SkillInfo): string {
  const partial = skill.enabled && skill.override && skill.override !== 'on' ? `<span class="skill-tag">${esc(skill.override)}</span>` : '';
  return `
    <div class="skill-row${skill.enabled ? '' : ' off'}" title="${esc(skill.dir)}">
      <div class="skill-text">
        <div class="skill-name-line"><span class="skill-name">${esc(skill.name)}</span>${partial}</div>
        ${skill.description ? `<div class="skill-desc">${esc(skill.description)}</div>` : ''}
      </div>
      ${switchHtml(skillKey(skill), skill.enabled, skill.name)}
    </div>`;
}

function pluginRowHtml(plugin: PluginInfo): string {
  const meta = [plugin.marketplace, plugin.version && `v${plugin.version}`].filter(Boolean).join(' · ');
  return `
    <div class="skill-row${plugin.enabled ? '' : ' off'}" title="${esc(plugin.id)}">
      <div class="skill-text">
        <div class="skill-name-line"><span class="skill-name">${esc(plugin.name)}</span>${meta ? `<span class="skill-tag">${esc(meta)}</span>` : ''}</div>
        ${plugin.description ? `<div class="skill-desc">${esc(plugin.description)}</div>` : ''}
      </div>
      ${switchHtml(pluginKey(plugin), plugin.enabled, plugin.id)}
    </div>`;
}

export function renderSkillsPane(container: HTMLElement, opts: { onClose: () => void; rerender: () => void }): void {
  if ((skills === null || loadedFor !== projectPath()) && !loading) void refreshSkills(opts.rerender);
  const skillList = skills ?? [];
  const pluginList = plugins ?? [];
  const total = skillList.length + pluginList.length;
  const on = skillList.filter((s) => s.enabled).length + pluginList.filter((p) => p.enabled).length;
  const scrollTop = container.scrollTop;

  const header = `
    <div class="sidebar-view-header">
      <span class="sidebar-view-title">${esc(t('skills.title'))}</span>
      <div class="sidebar-view-actions">
        ${total ? `<span class="skills-count">${esc(t('skills.count', { on, total }))}</span>` : ''}
        <button type="button" class="icon-btn skills-refresh${loading ? ' spinning' : ''}" title="${esc(t('skills.refresh'))}" aria-label="${esc(t('skills.refresh'))}">${ICON_REFRESH}</button>
        <button type="button" class="icon-btn usage-panel-close" title="${esc(t('usagePanel.hide'))}" aria-label="${esc(t('usagePanel.hide'))}">&times;</button>
      </div>
    </div>`;

  let body: string;
  if (skills === null) {
    body = `<div class="chg-empty">${esc(t('skills.loading'))}</div>`;
  } else {
    const groups: [string, string[]][] = [
      [t('skills.user'), skillList.filter((s) => s.scope === 'user').map(skillRowHtml)],
      [t('skills.project'), skillList.filter((s) => s.scope === 'project').map(skillRowHtml)],
      [t('skills.plugins'), pluginList.map(pluginRowHtml)],
    ];
    body = groups
      .filter(([, rows]) => rows.length)
      .map(([label, rows]) => `<div class="skills-group">${esc(label)}</div>${rows.join('')}`)
      .join('');
    if (!total) body = `<div class="chg-empty">${esc(t('skills.empty'))}</div>`;
    if (pluginsFailure) body += `<div class="skills-error">${esc(t('skills.pluginsFailed', { error: pluginsFailure }))}</div>`;
    if (total) body += `<div class="chg-note">${esc(t('skills.note'))}</div>`;
  }
  const error = failure ? `<div class="skills-error">${esc(failure)}</div>` : '';

  container.innerHTML = header + error + `<div class="skills-list">${body}</div>`;
  container.scrollTop = scrollTop;
  container.querySelector('.usage-panel-close')!.addEventListener('click', opts.onClose);
  container.querySelector('.skills-refresh')!.addEventListener('click', () => void refreshSkills(opts.rerender));
  container.querySelectorAll<HTMLButtonElement>('.skill-switch').forEach((btn) => {
    const key = btn.dataset.key ?? '';
    const skill = skillList.find((s) => skillKey(s) === key);
    const plugin = pluginList.find((p) => pluginKey(p) === key);
    btn.addEventListener('click', () => {
      if (skill) {
        void flip(key, (v) => {
          skill.enabled = v;
          skill.override = v ? null : 'off';
        }, skill.enabled, (v) => window.vibeyard.skills.setEnabled(skill.name, skill.scope, projectPath(), v), opts.rerender);
      } else if (plugin) {
        void flip(key, (v) => {
          plugin.enabled = v;
        }, plugin.enabled, (v) => window.vibeyard.plugins.setEnabled(plugin.id, v), opts.rerender);
      }
    });
  });
}
