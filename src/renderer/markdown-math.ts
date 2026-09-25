import katex from 'katex';
import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';

// Markdown with typeset formulas, for the file preview and the conversation
// view. A marked extension picks out the math — `$…$` and `\(…\)` inline,
// `$$…$$` and `\[…\]` as display — before Markdown can eat the backslashes,
// and KaTeX typesets it. Code spans and blocks are left alone (marked
// tokenizes them first), and so are prices: an inline `$` must hug its
// formula on both sides and the closing one can't be followed by a digit, so
// "$5 and $10" stays text. KaTeX escapes its input and runs with `trust`
// off, so its HTML is safe to put through DOMPurify with the rest.

interface MathToken extends Tokens.Generic {
  type: 'blockMath' | 'inlineMath';
  raw: string;
  text: string;
  display: boolean;
}

export function typeset(tex: string, display: boolean): string {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
}

const BLOCK_RE = /^ {0,3}(\$\$|\\\[)[ \t]*\n?([\s\S]+?)\n?[ \t]*(\$\$|\\\])[ \t]*(?:\n+|$)/;

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const m = /(^|\n) {0,3}(\$\$|\\\[)/.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = BLOCK_RE.exec(src);
    if (!m || (m[1] === '$$') !== (m[3] === '$$')) return undefined;
    return { type: 'blockMath', raw: m[0], text: m[2].trim(), display: true } satisfies MathToken;
  },
  renderer(token) {
    return `<div class="md-math-block">${typeset((token as MathToken).text, true)}</div>\n`;
  },
};

const INLINE_RULES: Array<[RegExp, boolean]> = [
  [/^\$\$([\s\S]+?)\$\$/, true],
  [/^\\\[([\s\S]+?)\\\]/, true],
  [/^\\\(([\s\S]+?)\\\)/, false],
  [/^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/, false],
];

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const i = src.search(/\$|\\\(|\\\[/);
    return i === -1 ? undefined : i;
  },
  tokenizer(src) {
    for (const [re, display] of INLINE_RULES) {
      const m = re.exec(src);
      if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display } satisfies MathToken;
    }
    return undefined;
  },
  renderer(token) {
    const { text, display } = token as MathToken;
    return display ? `<span class="md-math-display">${typeset(text, true)}</span>` : typeset(text, false);
  },
};

const markdown = new Marked({ extensions: [blockMath, inlineMath] });

/** Markdown to HTML, formulas typeset. The caller still sanitizes the result. */
export function renderMarkdownWithMath(src: string): string {
  return markdown.parse(src, { async: false }) as string;
}
