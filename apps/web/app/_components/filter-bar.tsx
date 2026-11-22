'use client';

import { Button, cn, focusRing } from '@flexa/ui';
import { CircleAlert, Filter, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../lib/i18n';
import { useRqlFields, validateRql, type Resource, type RqlField } from '../../lib/records';

interface Suggestion {
  label: string;
  insert: string;
  hint: string;
}

const KEYWORDS = ['AND', 'OR', 'NOT'];
const OPS: Record<string, string[]> = {
  text: ['=', '!=', '~', 'IN', 'IS EMPTY', 'IS NOT EMPTY'],
  enum: ['=', '!=', 'IN', 'NOT IN'],
  user: ['=', '!=', 'IN', 'IS EMPTY'],
  uuid: ['=', '!=', 'IN', 'IS EMPTY'],
  number: ['=', '!=', '<', '<=', '>', '>='],
  date: ['=', '<', '<=', '>', '>=', 'IS EMPTY'],
  datetime: ['<', '<=', '>', '>=', 'IS EMPTY'],
  bool: ['=', '!='],
};
const DATE_VALUES = ['today()', 'now()', 'startOfWeek()', 'startOfMonth()', '-7d', '+7d'];

/** What the cursor is in: a field name, an operator after a field, or a value after an operator. */
function contextAt(text: string, caret: number, fields: Map<string, RqlField>): { kind: 'field' | 'op' | 'value'; prefix: string; field?: RqlField; start: number } {
  const before = text.slice(0, caret);
  const m = /([A-Za-z_][\w.]*|"[^"]*|[=!<>~]+)?$/.exec(before);
  const prefix = m?.[1] ?? '';
  const start = caret - prefix.length;
  const tokens = before.slice(0, start).trim().split(/\s+/).filter(Boolean);
  const last = tokens.at(-1);
  const prev = tokens.at(-2);
  if (!last || KEYWORDS.includes(last.toUpperCase()) || last === '(') return { kind: 'field', prefix, start };
  const lastField = fields.get(last);
  if (lastField) return { kind: 'op', prefix, field: lastField, start };
  const prevField = prev ? fields.get(prev) : undefined;
  if (prevField && /^(=|!=|<|<=|>|>=|~)$/.test(last)) return { kind: 'value', prefix, field: prevField, start };
  return { kind: 'field', prefix, start };
}

/**
 * RQL filter bar (ADR-0008): suggestions for fields, operators and values; the query is validated by the API
 * (same compiler as the list) and an error shows its position. Enter applies, Escape restores.
 */
export function FilterBar({ resource, value, onChange, className }: { resource: Resource; value: string; onChange: (q: string) => void; className?: string }) {
  const fieldsQ = useRqlFields(resource);
  const fields = useMemo(() => new Map((fieldsQ.data?.data ?? []).map((f) => [f.name, f])), [fieldsQ.data]);
  const [text, setText] = useState(value);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<{ message: string; position?: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    setText(value);
  }, [value]);

  // Live validation against the API (debounced).
  useEffect(() => {
    if (!text.trim()) {
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    const id = window.setTimeout(() => {
      validateRql(resource, text, ctrl.signal)
        .then((r) => {
          setError(r.ok || !r.error ? null : { message: r.error.message, ...(r.error.position === undefined ? {} : { position: r.error.position }) });
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      window.clearTimeout(id);
      ctrl.abort();
    };
  }, [text, resource]);

  const ctx = contextAt(text, caret, fields);
  const suggestions: Suggestion[] = useMemo(() => {
    const p = ctx.prefix.toLowerCase();
    if (ctx.kind === 'field') {
      return [
        ...[...fields.values()].filter((f) => f.name.toLowerCase().startsWith(p)).map((f) => ({ label: f.name, insert: `${f.name} `, hint: f.type })),
        ...(p ? KEYWORDS.filter((k) => k.toLowerCase().startsWith(p)).map((k) => ({ label: k, insert: `${k} `, hint: t('filter.keyword') })) : []),
      ].slice(0, 12);
    }
    if (ctx.kind === 'op' && ctx.field) {
      return (OPS[ctx.field.type] ?? ['=']).filter((o) => o.toLowerCase().startsWith(p)).map((o) => ({ label: o, insert: `${o} `, hint: t('filter.operator') }));
    }
    if (ctx.kind === 'value' && ctx.field) {
      const values =
        ctx.field.type === 'enum'
          ? (ctx.field.enumValues ?? [])
          : ctx.field.type === 'user'
            ? ['me()']
            : ctx.field.type === 'bool'
              ? ['true', 'false']
              : ctx.field.type === 'date' || ctx.field.type === 'datetime'
                ? DATE_VALUES
                : [];
      return values.filter((v) => v.toLowerCase().startsWith(p.replace(/^"/, ''))).map((v) => ({ label: v, insert: `${v} `, hint: ctx.field?.name ?? '' }));
    }
    return [];
  }, [ctx.kind, ctx.prefix, ctx.field, fields]);

  function accept(s: Suggestion): void {
    const next = text.slice(0, ctx.start) + s.insert + text.slice(caret);
    const pos = ctx.start + s.insert.length;
    setText(next);
    setCaret(pos);
    setActive(0);
    window.requestAnimationFrame(() => {
      input.current?.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    const showing = open && suggestions.length > 0;
    if (showing && e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (showing && e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (showing && (e.key === 'Tab' || (e.key === 'Enter' && ctx.prefix !== ''))) {
      const s = suggestions[active];
      if (s) {
        e.preventDefault();
        accept(s);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!error) {
        setOpen(false);
        onChange(text.trim());
      }
    } else if (e.key === 'Escape') {
      if (open) setOpen(false);
      else {
        setText(value);
        input.current?.blur();
      }
    }
  }

  const dirty = text.trim() !== value.trim();
  return (
    <div className={cn('relative flex min-w-0 flex-1 flex-col gap-1', className)}>
      <div className={cn('flex h-8 items-center gap-2 rounded-input border bg-surface px-2', error ? 'border-danger' : 'border-line-strong', 'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent')}>
        <Filter aria-hidden size={14} className="shrink-0 text-fg-muted" />
        <input
          ref={input}
          value={text}
          role="combobox"
          aria-label={t('filter.label')}
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && suggestions[active] ? `${listId}-${String(active)}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${listId}-err` : undefined}
          placeholder={t('filter.placeholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setOpen(true);
            setActive(0);
          }}
          onSelect={(e) => {
            setCaret(e.currentTarget.selectionStart ?? 0);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setOpen(false);
            }, 120);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-body placeholder:text-fg-muted"
          data-testid="filter-input"
        />
        {text ? (
          <button
            type="button"
            aria-label={t('filter.clear')}
            onClick={() => {
              setText('');
              onChange('');
            }}
            className={cn('rounded-input p-0.5 text-fg-muted hover:text-fg', focusRing)}
          >
            <X aria-hidden size={14} />
          </button>
        ) : null}
        {dirty ? (
          <Button size="sm" className="h-6 px-2 text-xs" disabled={Boolean(error)} onClick={() => { onChange(text.trim()); }}>
            {t('filter.apply')}
          </Button>
        ) : null}
      </div>
      {open && suggestions.length > 0 ? (
        <ul id={listId} role="listbox" aria-label={t('filter.suggestions')} className="absolute left-0 top-9 z-30 m-0 max-h-64 w-72 list-none overflow-y-auto rounded-input border border-line bg-raised p-1 shadow-popover">
          {suggestions.map((s, i) => (
            <li
              key={`${s.label}-${s.hint}`}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
              className={cn('flex cursor-default items-center justify-between gap-3 rounded-input px-2 py-1.5 font-mono text-xs', i === active && 'bg-subtle')}
            >
              <span>{s.label}</span>
              <span className="font-body text-fg-muted">{s.hint}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p id={`${listId}-err`} className="m-0 flex items-center gap-1 text-xs text-danger" role="status">
          <CircleAlert aria-hidden size={12} />
          {error.position === undefined ? error.message : t('filter.errorAt', { position: String(error.position + 1), message: error.message })}
        </p>
      ) : null}
    </div>
  );
}
