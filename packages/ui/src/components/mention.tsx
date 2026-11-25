import { Node, type Editor, type Range } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { UserRound, UsersRound } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '../lib/cn';

// `@` mentions in the rich-text editor (ADR-0017 §1): a structural node {kind, id}. The name is never stored; it
// is looked up when shown, so renaming someone never breaks a document.

export interface MentionItem {
  kind: 'user' | 'team';
  id: string;
  label: string;
  hint?: string | undefined;
}

export interface MentionConfig {
  search: (query: string) => Promise<MentionItem[]>;
  /** The current name, or null while unknown. */
  labelOf: (kind: 'user' | 'team', id: string) => string | null;
  labels: { list: string; empty: string; loading: string };
}

const CHIP = 'rounded-input border border-line bg-subtle px-1 font-semibold text-fg';
export const mentionText = (label: string | null): string => `@${label ?? '…'}`;

interface Session {
  query: string;
  range: Range;
  rect: DOMRect | null;
}

/** What the editor plugin and the React picker share; refs, because ProseMirror calls back outside React. */
export interface MentionBridge {
  onSession: (s: Session | null) => void;
  onKey: (key: string) => boolean;
  labelOf: MentionConfig['labelOf'];
  enabled: boolean;
}

export function mentionNode(bridge: RefObject<MentionBridge>) {
  return Node.create({
    name: 'mention',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: false,
    addAttributes() {
      return {
        kind: { default: 'user', parseHTML: (el: HTMLElement) => el.getAttribute('data-kind') ?? 'user' },
        id: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-id') },
      };
    },
    parseHTML() {
      return [{ tag: 'span.mention[data-id]' }];
    },
    renderHTML({ node }) {
      return ['span', { class: 'mention', 'data-kind': String(node.attrs.kind), 'data-id': String(node.attrs.id) }];
    },
    renderText() {
      return '@';
    },
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('span');
        dom.className = `${CHIP} mention`;
        dom.contentEditable = 'false';
        dom.dataset.kind = String(node.attrs.kind);
        dom.dataset.id = String(node.attrs.id);
        dom.textContent = mentionText(bridge.current.labelOf(node.attrs.kind as 'user' | 'team', String(node.attrs.id)));
        // The label is filled in later when names arrive: not a document change.
        return { dom, ignoreMutation: () => true };
      };
    },
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: '@',
          allow: () => bridge.current.enabled,
          items: () => [],
          render: () => ({
            onStart: (p) => { bridge.current.onSession({ query: p.query, range: p.range, rect: p.clientRect?.() ?? null }); },
            onUpdate: (p) => { bridge.current.onSession({ query: p.query, range: p.range, rect: p.clientRect?.() ?? null }); },
            onKeyDown: (p) => bridge.current.onKey(p.event.key),
            onExit: () => { bridge.current.onSession(null); },
          }),
        }),
      ];
    },
  });
}

/** Refreshes the names of the chips already in the document. */
export function refreshMentionLabels(root: HTMLElement, labelOf: MentionConfig['labelOf']): void {
  for (const el of root.querySelectorAll<HTMLElement>('span.mention[data-id]')) {
    const text = mentionText(labelOf(el.dataset.kind === 'team' ? 'team' : 'user', el.dataset.id ?? ''));
    if (el.textContent !== text) el.textContent = text;
  }
}

/** The `@` list: arrow keys move, Enter or Tab picks, Escape closes; focus stays in the editor. */
export function MentionPicker({ editor, bridge, config, wrapper }: { editor: Editor | null; bridge: RefObject<MentionBridge>; config: MentionConfig | undefined; wrapper: RefObject<HTMLDivElement | null> }) {
  const listId = useId();
  const [session, setSession] = useState<Session | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [found, setFound] = useState<{ query: string; items: MentionItem[] } | null>(null);
  const [index, setIndex] = useState(0);
  const open = session !== null && config !== undefined && dismissed !== session.range.from;
  const items = open && found ? found.items : [];
  const active = Math.min(index, Math.max(0, items.length - 1));
  const query = open ? session.query : null;
  const search = useRef(config?.search);

  useEffect(() => { search.current = config?.search; });

  // One request per pause in typing; a late answer to an older query is dropped.
  useEffect(() => {
    if (query === null) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      search.current?.(query).then(
        (list) => { if (live) { setFound({ query, items: list }); setIndex(0); } },
        () => { if (live) setFound({ query, items: [] }); },
      );
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  const pick = (item: MentionItem): void => {
    if (!editor || !session) return;
    editor.chain().focus().insertContentAt({ from: session.range.from, to: editor.state.selection.from }, [{ type: 'mention', attrs: { kind: item.kind, id: item.id } }, { type: 'text', text: ' ' }]).run();
  };

  useEffect(() => {
    bridge.current.onSession = (s) => {
      setSession(s);
      if (!s) { setDismissed(null); setFound(null); }
    };
    bridge.current.onKey = (key) => {
      if (!open) return false;
      if (key === 'Escape') { setDismissed(session.range.from); return true; }
      if (items.length === 0) return false;
      if (key === 'ArrowDown') { setIndex((active + 1) % items.length); return true; }
      if (key === 'ArrowUp') { setIndex((active - 1 + items.length) % items.length); return true; }
      const item = items[active];
      if ((key === 'Enter' || key === 'Tab') && item) { pick(item); return true; }
      return false;
    };
  });

  // The editor keeps the focus and points at the highlighted option.
  useEffect(() => {
    const dom = editor && !editor.isDestroyed ? editor.view.dom : null;
    if (!dom) return undefined;
    if (open && items.length > 0) {
      dom.setAttribute('aria-controls', listId);
      dom.setAttribute('aria-activedescendant', `${listId}-${String(active)}`);
    }
    return () => {
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-activedescendant');
    };
  }, [editor, open, items.length, active, listId]);

  if (!open) return null;
  const box = wrapper.current?.getBoundingClientRect();
  const left = session.rect && box ? Math.max(0, Math.min(session.rect.left - box.left, box.width - 256)) : 0;
  const top = session.rect && box ? session.rect.bottom - box.top + 4 : 0;
  const status: ReactNode = found === null ? config.labels.loading : items.length === 0 ? config.labels.empty : null;
  return (
    <div className="absolute z-50 w-64 max-w-full rounded-card border border-line bg-raised p-1 shadow-popover" style={{ left, top }} data-testid="mention-picker">
      {status ? <p className="m-0 px-2 py-1.5 text-sm text-fg-muted" role="status">{status}</p> : null}
      <ul id={listId} role="listbox" aria-label={config.labels.list} className={cn('m-0 max-h-56 list-none overflow-y-auto p-0', items.length === 0 && 'hidden')}>
        {items.map((item, i) => (
          <li
            key={`${item.kind}${item.id}`}
            id={`${listId}-${String(i)}`}
            role="option"
            aria-selected={i === active}
            // Keeps the focus (and the selection) in the editor.
            onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            onMouseEnter={() => { setIndex(i); }}
            className={cn('flex cursor-default items-center gap-2 rounded-input px-2 py-1.5 text-sm', i === active && 'bg-subtle')}
          >
            {item.kind === 'team' ? <UsersRound aria-hidden size={14} className="shrink-0" /> : <UserRound aria-hidden size={14} className="shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{item.label}</span>
              {item.hint ? <span className="block text-xs text-fg-muted">{item.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- read-only rendering
type DocNode = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; marks?: unknown; content?: unknown };

function safeHref(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function renderNode(raw: unknown, key: number, labelOf: MentionConfig['labelOf'], depth: number): ReactNode {
  if (typeof raw !== 'object' || raw === null || depth > 20) return null;
  const n = raw as DocNode;
  const kids = (): ReactNode => (Array.isArray(n.content) ? n.content.map((c, i) => renderNode(c, i, labelOf, depth + 1)) : null);
  switch (n.type) {
    case 'text': {
      let out: ReactNode = typeof n.text === 'string' ? n.text : '';
      for (const m of Array.isArray(n.marks) ? (n.marks as DocNode[]) : []) {
        if (m.type === 'bold') out = <strong>{out}</strong>;
        else if (m.type === 'italic') out = <em>{out}</em>;
        else if (m.type === 'underline') out = <u>{out}</u>;
        else if (m.type === 'strike') out = <s>{out}</s>;
        else if (m.type === 'code') out = <code>{out}</code>;
        else if (m.type === 'link') {
          const href = safeHref(m.attrs?.href);
          if (href) out = <a href={href} target="_blank" rel="noopener noreferrer nofollow">{out}</a>;
        }
      }
      return <span key={key}>{out}</span>;
    }
    case 'mention': {
      const kind = n.attrs?.kind === 'team' ? 'team' : 'user';
      return <span key={key} className={CHIP} data-testid="mention">{mentionText(labelOf(kind, String(n.attrs?.id)))}</span>;
    }
    case 'hardBreak': return <br key={key} />;
    case 'horizontalRule': return <hr key={key} />;
    case 'paragraph': return <p key={key}>{kids()}</p>;
    case 'heading': return n.attrs?.level === 3 ? <h3 key={key}>{kids()}</h3> : <h2 key={key}>{kids()}</h2>;
    case 'blockquote': return <blockquote key={key}>{kids()}</blockquote>;
    case 'bulletList': return <ul key={key}>{kids()}</ul>;
    case 'orderedList': return <ol key={key}>{kids()}</ol>;
    case 'listItem': return <li key={key}>{kids()}</li>;
    case 'codeBlock': return <pre key={key}><code>{kids()}</code></pre>;
    default: return null;
  }
}

/** A stored document as React elements: known nodes only, never HTML. */
export function RichTextView({ doc, labelOf, className }: { doc: unknown; labelOf: MentionConfig['labelOf']; className?: string }) {
  const content = (doc as DocNode | null)?.content;
  return <div className={cn('fx-prose text-sm', className)}>{Array.isArray(content) ? content.map((c, i) => renderNode(c, i, labelOf, 0)) : null}</div>;
}

/** Ids mentioned in documents, for looking their names up. */
export function mentionedIds(docs: readonly unknown[]): { users: string[]; teams: string[] } {
  const users = new Set<string>();
  const teams = new Set<string>();
  const walk = (raw: unknown, depth: number): void => {
    if (typeof raw !== 'object' || raw === null || depth > 20) return;
    const n = raw as DocNode;
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') (n.attrs.kind === 'team' ? teams : users).add(n.attrs.id);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c, depth + 1);
  };
  for (const d of docs) walk(d, 0);
  return { users: [...users], teams: [...teams] };
}
