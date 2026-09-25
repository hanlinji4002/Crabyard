import { describe, it, expect } from 'vitest';
import { renderMarkdownWithMath } from './markdown-math';

describe('renderMarkdownWithMath', () => {
  it('typesets inline and display formulas', () => {
    const html = renderMarkdownWithMath('Energy is $E=mc^2$ here.\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n');
    expect(html).toContain('<span class="katex">');
    expect(html).toContain('class="md-math-block"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('$E=mc^2$');
  });

  it('understands \\( \\) and \\[ \\] as Claude often writes them', () => {
    const html = renderMarkdownWithMath('Inline \\(a^2+b^2=c^2\\) and\n\n\\[\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2}\n\\]\n');
    expect(html.match(/class="katex"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('katex-display');
    expect(html).not.toContain('\\(');
  });

  it('leaves prices, code spans and code blocks alone', () => {
    const html = renderMarkdownWithMath('It costs $5 and $10.\n\nUse `$HOME/$USER` in shell.\n\n```\n$$ not math $$\n```\n');
    expect(html).not.toContain('katex');
    expect(html).toContain('$5 and $10');
    expect(html).toContain('<code>$HOME/$USER</code>');
    expect(html).toContain('$$ not math $$');
  });

  it('keeps going past LaTeX it cannot typeset', () => {
    const html = renderMarkdownWithMath('Broken $\\frac{1}{$ but **bold** stays.');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('keeps ordinary Markdown working', () => {
    const html = renderMarkdownWithMath('# Title\n\n| a | b |\n|---|---|\n| 1 | $x$ |\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('class="katex"');
  });
});
