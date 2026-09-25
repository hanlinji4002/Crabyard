// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseTranscript, toolDetail, turnHtml } from './transcript-view';

const line = (o: unknown) => JSON.stringify(o);

describe('parseTranscript', () => {
  it('makes one reply per prompt, with the tools Claude ran as chips', () => {
    const jsonl = [
      line({ type: 'custom-title', title: 'x' }),
      line({ type: 'user', message: { role: 'user', content: '推导 $E=mc^2$' } }),
      line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/b/notes.md' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'file body' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '结果：$$E=mc^2$$' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\nmore' } }] } }),
      '{ not json',
      line({ type: 'user', message: { content: '谢谢' } }),
    ].join('\n');
    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: '推导 $E=mc^2$' }] },
      {
        role: 'assistant',
        parts: [
          { kind: 'tool', name: 'Read', detail: 'notes.md' },
          { kind: 'text', text: '结果：$$E=mc^2$$' },
          { kind: 'tool', name: 'Bash', detail: 'npm test' },
        ],
      },
      { role: 'user', parts: [{ kind: 'text', text: '谢谢' }] },
    ]);
  });

  it('shows slash commands as chips and drops reminders, meta, side-chains and command output', () => {
    const jsonl = [
      line({ type: 'user', message: { content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>ultracode</command-args>' } }),
      line({ type: 'user', message: { content: '<local-command-stdout>Set effort level to ultracode</local-command-stdout>' } }),
      line({ type: 'user', isMeta: true, message: { content: 'Caveat: …' } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent talk' }] } }),
      line({ type: 'user', message: { content: '<system-reminder>be nice</system-reminder>\n真正的问题' } }),
    ].join('\n');
    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', parts: [{ kind: 'tool', name: '/effort', detail: 'ultracode' }] },
      { role: 'user', parts: [{ kind: 'text', text: '真正的问题' }] },
    ]);
  });
});

describe('toolDetail', () => {
  it('names the file, command or pattern a tool worked on', () => {
    expect(toolDetail({ file_path: '/x/y/z.ts' })).toBe('z.ts');
    expect(toolDetail({ pattern: 'TODO' })).toBe('TODO');
    expect(toolDetail({ command: `echo ${'a'.repeat(100)}` })).toHaveLength(72);
    expect(toolDetail(undefined)).toBe('');
  });
});

describe('turnHtml', () => {
  it('typesets the reply and escapes tool labels', () => {
    const html = turnHtml(
      { role: 'assistant', parts: [{ kind: 'text', text: 'Area $\\pi r^2$' }, { kind: 'tool', name: 'Bash', detail: '<rm -rf>' }] },
      { user: '你', assistant: 'Claude' },
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('&lt;rm -rf&gt;');
    expect(html).toContain('<div class="tv-who">Claude</div>');
  });
});
