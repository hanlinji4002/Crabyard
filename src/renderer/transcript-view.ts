import DOMPurify from 'dompurify';
import { renderMarkdownWithMath } from './markdown-math.js';

// The conversation view (排版视图): a Claude Code transcript read straight
// from its JSONL, so Claude's replies show as written — Markdown and LaTeX
// intact, before the CLI's own terminal renderer rewrites `\\`, `\[` and `$$`
// lines — with formulas typeset. Each user prompt starts a turn; everything
// Claude says until the next prompt (text across several API calls, with the
// tools it ran in between as small chips) is one reply. Tool results,
// thinking, subagent side-chains and meta entries are left out.

export type TranscriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string };

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  parts: TranscriptPart[];
}

interface Entry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown };
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function firstLine(s: string, max = 72): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A short label for what a tool call worked on: a file name, a command, a pattern. */
export function toolDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  const file = str('file_path') || str('notebook_path') || str('path');
  if (file) return basename(file);
  const text = str('command') || str('pattern') || str('url') || str('query') || str('description') || str('prompt') || str('skill');
  return text ? firstLine(text) : '';
}

/** A user prompt without the reminders and wrappers Claude Code adds around it. */
function cleanPrompt(text: string): TranscriptPart[] {
  const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(stripped);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(stripped)?.[1]?.trim() ?? '';
    return [{ kind: 'tool', name: command[1].trim(), detail: args }];
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(stripped);
  if (bash) return [{ kind: 'tool', name: '!', detail: firstLine(bash[1]) }];
  // Command output and other wrappers of Claude Code's own aren't the user's words.
  if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|command-message)>/.test(stripped)) return [];
  return stripped ? [{ kind: 'text', text: stripped }] : [];
}

export function parseTranscript(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const reply = (): TranscriptTurn => {
    const last = turns[turns.length - 1];
    if (last?.role === 'assistant') return last;
    const turn: TranscriptTurn = { role: 'assistant', parts: [] };
    turns.push(turn);
    return turn;
  };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      let parts: TranscriptPart[] = [];
      if (typeof content === 'string') {
        parts = cleanPrompt(content);
      } else if (Array.isArray(content)) {
        // Tool results come back as user entries; only real text is the user speaking.
        const text = (content as Block[]).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n');
        parts = text ? cleanPrompt(text) : [];
      }
      if (parts.length) turns.push({ role: 'user', parts });
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block.type === 'text' && block.text?.trim()) {
          reply().parts.push({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use' && block.name) {
          reply().parts.push({ kind: 'tool', name: block.name, detail: toolDetail(block.input) });
        }
      }
    }
  }
  return turns;
}

// ─── Rendering ──────────────────────────────────────────────────────

const htmlCache = new Map<string, string>();
const CACHE_LIMIT = 800;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Markdown + math, sanitized; cached by source so a live update only renders what's new. */
function markdownHtml(text: string): string {
  let html = htmlCache.get(text);
  if (html === undefined) {
    html = DOMPurify.sanitize(renderMarkdownWithMath(text));
    if (htmlCache.size >= CACHE_LIMIT) htmlCache.delete(htmlCache.keys().next().value!);
    htmlCache.set(text, html);
  }
  return html;
}

function toolsHtml(tools: Array<{ name: string; detail: string }>): string {
  return `<div class="tv-tools">${tools
    .map((tool) => `<span class="tv-tool"><b>${escapeHtml(tool.name)}</b>${tool.detail ? ` ${escapeHtml(tool.detail)}` : ''}</span>`)
    .join('')}</div>`;
}

export function turnHtml(turn: TranscriptTurn, labels: { user: string; assistant: string }): string {
  let body = '';
  let tools: Array<{ name: string; detail: string }> = [];
  const flush = () => {
    if (tools.length) body += toolsHtml(tools);
    tools = [];
  };
  for (const part of turn.parts) {
    if (part.kind === 'tool') {
      tools.push(part);
    } else {
      flush();
      body += `<div class="file-reader-markdown tv-text">${markdownHtml(part.text)}</div>`;
    }
  }
  flush();
  const who = turn.role === 'user' ? labels.user : labels.assistant;
  return `<section class="tv-turn tv-${turn.role}"><div class="tv-who">${escapeHtml(who)}</div>${body}</section>`;
}
