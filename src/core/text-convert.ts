/**
 * AuraFlow Web — local text / Markdown / HTML conversion
 *
 * Deliberately small and predictable: a safe Markdown subset, HTML text
 * extraction, and downloadable standalone documents. No external assets are
 * embedded in generated HTML, and dangerous link schemes are rejected.
 */

import type { PdfTextBlock } from './pdf-tools.js';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function safeHref(raw: string): string {
  const url = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(url) || /^(#|\/|\.{1,2}\/)/.test(url)) return escapeHtml(url);
  return '#';
}

function inlineHtml(raw: string): string {
  const codeSpans: string[] = [];
  let s = escapeHtml(raw).replace(/`([^`]+)`/g, (_m, code: string) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  // Images become their alt text: generated documents never fetch remote assets.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, label: string, href: string) => {
    return `<a href="${safeHref(href)}" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string, b: string) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*|(^|[\s(])_([^_\n]+)_/g, (_m, p1: string, a: string, p2: string, b: string) => {
    return `${p1 || p2}<em>${a ?? b}</em>`;
  });
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)] ?? '');
  return s;
}

function inlinePlain(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*]+)\*|_([^_]+)_/g, '$1$2')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1');
}

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; text: string; index: number }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'hr' };

const BLOCK_START = /^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+| {0,3}([-*_])(?:\s*\1){2,}\s*$)/;

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let codeFence = '';

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };

  for (const line of lines) {
    if (code) {
      const trimmed = line.trim();
      if (trimmed.startsWith(codeFence)) {
        blocks.push({ type: 'code', text: code.join('\n') });
        code = null;
        codeFence = '';
      } else {
        code.push(line);
      }
      continue;
    }

    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      flush();
      code = [];
      codeFence = fence[1] ?? '```';
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'hr' });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      blocks.push({ type: 'quote', text: quote[1]!.trim() });
      continue;
    }

    const list = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (list) {
      flush();
      const ordered = /\d/.test(list[1]!);
      blocks.push({
        type: 'list',
        ordered,
        index: ordered ? Number.parseInt(list[1]!, 10) || 1 : 1,
        text: list[2]!.trim(),
      });
      continue;
    }

    paragraph.push(line.trim());
    // A line that starts the next block should break the paragraph first.
    if (BLOCK_START.test(line) && paragraph.length > 1) {
      const last = paragraph.pop()!;
      flush();
      paragraph.push(last);
    }
  }

  if (code) blocks.push({ type: 'code', text: code.join('\n') });
  flush();
  return blocks;
}

function markdownBody(markdown: string): string {
  const blocks = parseMarkdown(markdown);
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const block of blocks) {
    if (block.type !== 'list') closeList();
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.level));
        out.push(`<h${level}>${inlineHtml(block.text)}</h${level}>`);
        break;
      }
      case 'paragraph':
        out.push(`<p>${inlineHtml(block.text)}</p>`);
        break;
      case 'quote':
        out.push(`<blockquote><p>${inlineHtml(block.text)}</p></blockquote>`);
        break;
      case 'code':
        out.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
        break;
      case 'hr':
        out.push('<hr />');
        break;
      case 'list': {
        const type = block.ordered ? 'ol' : 'ul';
        if (list !== type) {
          closeList();
          list = type;
          out.push(`<${type}>`);
        }
        out.push(`<li>${inlineHtml(block.text)}</li>`);
        break;
      }
    }
  }
  closeList();
  return out.join('\n');
}

function documentTemplate(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; font: 17px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; color: #20232a; background: #fff; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 2rem 0 .7rem; }
  p, li, blockquote { color: #333842; }
  a { color: #2855d9; }
  code { font-family: ui-monospace, Consolas, monospace; background: #f1f2f5; padding: .12em .35em; border-radius: 4px; }
  pre { overflow: auto; padding: 1rem; background: #f1f2f5; border-radius: 8px; }
  pre code { padding: 0; background: none; }
  blockquote { margin: 1.2rem 0; padding: .2rem 1rem; border-left: 3px solid #2855d9; background: #f7f8fb; }
  hr { border: 0; border-top: 1px solid #d9dce3; margin: 2rem 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #14161c; color: #ece9e2; }
    p, li, blockquote { color: #c9c6bf; }
    code, pre { background: #20242c; }
    blockquote { background: #1a1d24; }
    a { color: #7ea2ff; }
    hr { border-color: #343842; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function markdownToHtmlDocument(markdown: string, title = 'Converted document'): string {
  return documentTemplate(title, markdownBody(markdown));
}

export function plainTextToHtmlDocument(text: string, title = 'Converted document'): string {
  const paragraphs = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
  return documentTemplate(title, paragraphs || '<p></p>');
}

export function markdownToPlainText(markdown: string): string {
  const blocks = parseMarkdown(markdown);
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(inlinePlain(block.text));
        break;
      case 'paragraph':
        out.push(inlinePlain(block.text));
        break;
      case 'list':
        out.push(`${block.ordered ? `${block.index}.` : '•'} ${inlinePlain(block.text)}`);
        break;
      case 'quote':
        out.push(`> ${inlinePlain(block.text)}`);
        break;
      case 'code':
        out.push(block.text);
        break;
      case 'hr':
        out.push('---');
        break;
    }
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

let entityMap: Record<string, string> | null = null;
function decodeEntities(value: string): string {
  if (!entityMap) {
    entityMap = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
      mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
      euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•',
    };
  }
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (m, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return entityMap?.[body.toLowerCase()] ?? m;
  });
}

/** Best-effort HTML text extraction; scripts, styles and remote assets are dropped. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n?/g, '\n');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textToMarkdown(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

export function blocksForPdf(markdown: string, plain = false): PdfTextBlock[] {
  if (plain) {
    return markdown
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ kind: 'p', text: text.replace(/\n/g, ' ') }));
  }
  return parseMarkdown(markdown).flatMap<PdfTextBlock>((block) => {
    if (block.type === 'heading') {
      const kind = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
      return [{ kind, text: inlinePlain(block.text) }];
    }
    if (block.type === 'paragraph') return [{ kind: 'p', text: inlinePlain(block.text) }];
    if (block.type === 'quote') return [{ kind: 'quote', text: inlinePlain(block.text) }];
    if (block.type === 'code') return [{ kind: 'code', text: block.text }];
    if (block.type === 'hr') return [{ kind: 'hr', text: '' }];
    return [{ kind: 'li', text: `${block.ordered ? `${block.index}.` : '•'} ${inlinePlain(block.text)}` }];
  });
}
