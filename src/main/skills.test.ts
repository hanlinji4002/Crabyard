import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  return { ...real, homedir: () => home.dir };
});

import { listSkills, readFrontMatter, setSkillEnabled } from './skills';

function writeSkill(root: string, dir: string, frontMatter: string): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'SKILL.md'), `---\n${frontMatter}\n---\n\n# body\n`);
}

describe('readFrontMatter', () => {
  it('reads single-line, quoted and block values', () => {
    expect(readFrontMatter('---\nname: archify\ndescription: "Draw diagrams"\n---\nbody')).toEqual({ name: 'archify', description: 'Draw diagrams' });
    expect(readFrontMatter('---\nname: mingli\ndescription: |\n  line one\n  line two\n---\n')).toEqual({ name: 'mingli', description: 'line one line two' });
    expect(readFrontMatter('no front matter')).toEqual({});
  });
});

describe('skills', () => {
  let userSkills: string;
  let settings: string;
  let project: string;

  beforeEach(() => {
    home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-skills-'));
    userSkills = path.join(home.dir, '.claude', 'skills');
    settings = path.join(home.dir, '.claude', 'settings.json');
    project = path.join(home.dir, 'proj');
    writeSkill(userSkills, 'archify', 'name: archify\ndescription: Diagrams');
    writeSkill(userSkills, 'folder-name', 'description: No name field');
    fs.mkdirSync(path.join(userSkills, 'not-a-skill'), { recursive: true });
    writeSkill(path.join(project, '.claude', 'skills'), 'deploy', 'name: deploy\ndescription: Ship it');
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skillOverrides: { archify: 'off' } }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(home.dir, { recursive: true, force: true });
  });

  it("lists the user's skills and the project's, with their overrides", () => {
    const skills = listSkills(project);
    expect(skills.map((s) => [s.scope, s.name, s.enabled])).toEqual([
      ['user', 'archify', false],
      ['user', 'folder-name', true],
      ['project', 'deploy', true],
    ]);
    expect(skills[0].override).toBe('off');
  });

  it('turns a user skill back on by removing its override, keeping other settings', () => {
    expect(setSkillEnabled('archify', 'user', undefined, true)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('turns a project skill off in the project settings.local.json', () => {
    expect(setSkillEnabled('deploy', 'project', project, false)).toEqual({ ok: true });
    const local = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    expect(local).toEqual({ skillOverrides: { deploy: 'off' } });
    expect(listSkills(project).find((s) => s.name === 'deploy')?.enabled).toBe(false);
  });

  it('refuses to rewrite settings it cannot parse', () => {
    fs.writeFileSync(settings, '{ not json');
    expect(setSkillEnabled('archify', 'user', undefined, true).ok).toBe(false);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ not json');
  });
});
