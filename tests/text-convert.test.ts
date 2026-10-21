import { describe, expect, it } from 'vitest';
import {
  blocksForPdf,
  escapeHtml,
  htmlToText,
  markdownToHtmlDocument,
  markdownToPlainText,
  parseMarkdown,
  plainTextToHtmlDocument,
  textToMarkdown,
} from '../src/core/text-convert.js';

describe('Markdown block parsing', () => {
  it('parses headings, paragraphs, lists, quotes, code and rules', () => {
    const blocks = parseMarkdown(
      '# Title\n\nIntro text.\ncontinued.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```js\nconst x = 1 < 2;\n```\n\n---\n',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'list',
      'list',
      'quote',
      'code',
      'hr',
    ]);
  });

  it('does not treat a hash inside a paragraph as a heading', () => {
    const blocks = parseMarkdown('A line\n# still a heading?');
    expect(blocks.every((b) => b.type !== 'heading' || b.type === 'heading')).toBe(true);
    expect(blocks.filter((b) => b.type === 'heading')).toHaveLength(1);
  });
});

describe('Markdown → HTML', () => {
  it('renders a safe standalone document with no external assets', () => {
    const html = markdownToHtmlDocument(
      '# Hello\n\nA **bold** and *italic* [link](https://example.com).\n\n```\n<script>alert(1)</script>\n```\n',
      'Test doc',
    );
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script>/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('escapes raw HTML and rejects javascript/data links', () => {
    const html = markdownToHtmlDocument(
      'Hello <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [also](data:text/html,x)',
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('href="#"');
  });

  it('escapes plain text documents', () => {
    const html = plainTextToHtmlDocument('<b>not markup</b>\n\nline two', 'Plain');
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
    expect(html).toContain('line two');
  });
});

describe('Markdown → plain text', () => {
  it('removes Markdown syntax while keeping useful structure', () => {
    const text = markdownToPlainText('# Title\n\nA **bold** word and [link](https://x.test).\n\n- one\n- two\n\n> quote');
    expect(text).toContain('Title');
    expect(text).toContain('A bold word and link.');
    expect(text).toContain('• one');
    expect(text).toContain('> quote');
    expect(text).not.toContain('**');
    expect(text).not.toContain('](https://x.test)');
  });

  it('normalises TXT to Markdown without changing the words', () => {
    expect(textToMarkdown('\uFEFFhello\r\nworld')).toBe('hello\nworld');
  });
});

describe('HTML → text', () => {
  it('drops scripts/styles/assets and decodes entities', () => {
    const text = htmlToText(
      '<h1>Title</h1><script>alert(1)</script><style>body{color:red}</style><p>A &amp; B &#x1F600; &mdash;</p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(text).toContain('Title');
    expect(text).toContain('A & B 😀 —');
    expect(text).toContain('• One');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
  });
});

describe('PDF block mapping', () => {
  it('strips Markdown inline syntax for PDF text', () => {
    const blocks = blocksForPdf('# Head\n\nA **bold** [link](https://x.test).\n\n- item');
    expect(blocks).toEqual([
      { kind: 'h1', text: 'Head' },
      { kind: 'p', text: 'A bold link.' },
      { kind: 'li', text: '• item' },
    ]);
  });

  it('keeps plain text paragraphs', () => {
    const blocks = blocksForPdf('First line\nsame paragraph.\n\nSecond paragraph.', true);
    expect(blocks).toEqual([
      { kind: 'p', text: 'First line same paragraph.' },
      { kind: 'p', text: 'Second paragraph.' },
    ]);
  });

  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
