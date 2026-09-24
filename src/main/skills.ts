import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { SkillInfo, SkillScope } from '../shared/types';

// Claude Code skills for the right column's Skills pane: the user's
// (~/.claude/skills) and the open project's (<project>/.claude/skills). A skill
// is switched off the way Claude Code's own /skills menu does it — a
// `"skillOverrides": {"<name>": "off"}` entry, in ~/.claude/settings.json for a
// user skill and in the project's .claude/settings.local.json for a project
// skill — and back on by removing that entry. Claude Code watches its settings,
// so running conversations pick the change up too.

type Settings = Record<string, unknown>;

function skillsDir(scope: SkillScope, projectPath?: string): string | null {
  if (scope === 'user') return path.join(homedir(), '.claude', 'skills');
  return projectPath ? path.join(projectPath, '.claude', 'skills') : null;
}

function settingsFile(scope: SkillScope, projectPath?: string): string | null {
  if (scope === 'user') return path.join(homedir(), '.claude', 'settings.json');
  return projectPath ? path.join(projectPath, '.claude', 'settings.local.json') : null;
}

/** The settings object, `{}` when the file doesn't exist, or null when it can't be parsed. */
function readSettings(file: string): Settings | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Settings) : null;
  } catch {
    return null;
  }
}

function overridesOf(settings: Settings | null): Record<string, string> {
  const raw = settings?.skillOverrides;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
}

/** `name` and `description` from a SKILL.md's YAML front matter (single-line or block values). */
export function readFrontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-' || value === '') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    value = value.replace(/^(['"])(.*)\1$/, '$2');
    out[m[1] as 'name' | 'description'] = value;
  }
  return out;
}

function scan(scope: SkillScope, projectPath?: string): SkillInfo[] {
  const dir = skillsDir(scope, projectPath);
  const file = settingsFile(scope, projectPath);
  if (!dir || !file) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const overrides = overridesOf(readSettings(file));
  const out: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const skillFile = path.join(dir, entry, 'SKILL.md');
    let text: string;
    try {
      text = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const fm = readFrontMatter(text);
    const name = fm.name || entry;
    const override = overrides[name];
    out.push({
      name,
      description: fm.description ?? '',
      scope,
      dir: path.join(dir, entry),
      enabled: override !== 'off',
      override: override ?? null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkills(projectPath?: string): SkillInfo[] {
  const user = scan('user');
  // A project whose folder is the home directory would list the user skills twice.
  const project = projectPath && path.resolve(projectPath) !== homedir() ? scan('project', projectPath) : [];
  return [...user, ...project];
}

/**
 * Turn a skill on (drop its override) or off (`"off"`). Leaves every other
 * setting untouched, and refuses to rewrite a settings file it can't parse.
 */
export function setSkillEnabled(name: string, scope: SkillScope, projectPath: string | undefined, enabled: boolean): { ok: boolean; error?: string } {
  const file = settingsFile(scope, projectPath);
  if (!file || !name) return { ok: false, error: 'no settings file' };
  const settings = readSettings(file);
  if (!settings) return { ok: false, error: `${file} is not valid JSON` };
  const overrides = { ...overridesOf(settings) };
  if (enabled) delete overrides[name];
  else overrides[name] = 'off';
  if (Object.keys(overrides).length) settings.skillOverrides = overrides;
  else delete settings.skillOverrides;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
