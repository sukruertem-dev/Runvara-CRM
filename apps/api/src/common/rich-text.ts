import { ProblemError } from './problem';

// Server-side rendering of ProseMirror JSON (ADR-0017 §1): only the listed nodes and marks are accepted; the
// HTML is produced here (never taken from the client), every text is escaped and links are limited to
// http(s)/mailto. Mentions are structural nodes {type: 'mention', attrs: {kind: 'user'|'team', id}} whose
// labels are resolved on read, never stored.

export interface RenderedRichText {
  html: string;
  text: string;
  mentions: { users: Set<string>; teams: Set<string> };
}

type Node = { type?: unknown; text?: unknown; attrs?: unknown; marks?: unknown; content?: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NODES = 5000;
const MAX_DEPTH = 20;
export const MAX_USER_MENTIONS = 20;
export const MAX_TEAM_MENTIONS = 3;

const BLOCKS: Record<string, string> = {
  paragraph: 'p', blockquote: 'blockquote', bulletList: 'ul', orderedList: 'ol', listItem: 'li', codeBlock: 'pre',
};
const MARKS: Record<string, string> = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code' };

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function invalid(msg: string): never {
  throw new ProblemError('VALIDATION_FAILED', `body: ${msg}`);
}

function safeHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > 2000) return null;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function renderRichText(doc: unknown): RenderedRichText {
  const mentions = { users: new Set<string>(), teams: new Set<string>() };
  let count = 0;
  const textParts: string[] = [];

  const renderText = (n: Node): string => {
    if (typeof n.text !== 'string' || n.text.length === 0) invalid('text nodes need text');
    textParts.push(n.text);
    let html = escape(n.text);
    const marks = n.marks === undefined ? [] : n.marks;
    if (!Array.isArray(marks)) invalid('marks must be an array');
    for (const m of marks as Node[]) {
      const type = typeof m.type === 'string' ? m.type : '';
      if (type === 'link') {
        const href = safeHref((m.attrs as { href?: unknown } | undefined)?.href);
        if (!href) invalid('links must be http(s) or mailto');
        html = `<a href="${escape(href)}" rel="noopener noreferrer nofollow" target="_blank">${html}</a>`;
        continue;
      }
      const tag = MARKS[type];
      if (!tag) invalid(`mark "${type}" is not allowed`);
      html = `<${tag}>${html}</${tag}>`;
    }
    return html;
  };

  const render = (raw: unknown, depth: number): string => {
    if (++count > MAX_NODES) invalid('too many nodes');
    if (depth > MAX_DEPTH) invalid('nested too deeply');
    if (typeof raw !== 'object' || raw === null) invalid('nodes must be objects');
    const n = raw as Node;
    const type = typeof n.type === 'string' ? n.type : '';
    const children = (): string => {
      if (n.content === undefined) return '';
      if (!Array.isArray(n.content)) invalid('content must be an array');
      return (n.content as Node[]).map((c) => render(c, depth + 1)).join('');
    };
    switch (type) {
      case 'text':
        return renderText(n);
      case 'hardBreak':
        textParts.push('\n');
        return '<br>';
      case 'horizontalRule':
        textParts.push('\n');
        return '<hr>';
      case 'heading': {
        const level = (n.attrs as { level?: unknown } | undefined)?.level;
        const l = level === 1 || level === 2 || level === 3 ? level : 3;
        const inner = children();
        textParts.push('\n');
        return `<h${l}>${inner}</h${l}>`;
      }
      case 'mention': {
        const attrs = (n.attrs ?? {}) as { kind?: unknown; id?: unknown };
        if ((attrs.kind !== 'user' && attrs.kind !== 'team') || typeof attrs.id !== 'string' || !UUID.test(attrs.id)) invalid('mention needs {kind: user|team, id}');
        (attrs.kind === 'user' ? mentions.users : mentions.teams).add(attrs.id.toLowerCase());
        textParts.push('@');
        return `<span class="mention" data-kind="${attrs.kind}" data-id="${escape(attrs.id)}"></span>`;
      }
      case 'doc':
        if (depth !== 0) invalid('doc must be the root');
        return children();
      default: {
        const tag = BLOCKS[type];
        if (!tag) invalid(`node "${type}" is not allowed`);
        const inner = children();
        if (tag === 'p' || tag === 'pre' || tag === 'li') textParts.push('\n');
        return tag === 'pre' ? `<pre><code>${inner}</code></pre>` : `<${tag}>${inner}</${tag}>`;
      }
    }
  };

  if (typeof doc !== 'object' || doc === null || (doc as Node).type !== 'doc') invalid('must be a ProseMirror doc');
  const html = render(doc, 0);
  const text = textParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (mentions.users.size > MAX_USER_MENTIONS || mentions.teams.size > MAX_TEAM_MENTIONS) {
    throw new ProblemError('LIMIT_EXCEEDED', `at most ${MAX_USER_MENTIONS} people and ${MAX_TEAM_MENTIONS} teams can be mentioned`);
  }
  return { html, text, mentions };
}
