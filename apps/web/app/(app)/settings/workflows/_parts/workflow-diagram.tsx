'use client';

import { cn, focusRing, StatusBadge } from '@flexa/ui';
import { t } from '../../../../../lib/i18n';
import type { DraftStatus, DraftTransition } from './draft';

const COL_W = 240;
const NODE_W = 176;
const NODE_H = 44;
const ROW_H = 104;
const TOP = 72;
const CATEGORIES = ['open', 'in_progress', 'closed'] as const;

interface Edge {
  i: number;
  kind: 'any' | 'pair';
  x: DraftTransition;
  path: string;
  lx: number;
  ly: number;
}

interface Box {
  key: string;
  cx: number;
  cy: number;
}

/** Point where the line from the box centre towards `p` leaves the box. */
function edgePoint(b: Box, px: number, py: number): [number, number] {
  const dx = px - b.cx;
  const dy = py - b.cy;
  if (dx === 0 && dy === 0) return [b.cx, b.cy];
  const s = Math.min((NODE_W / 2 + 4) / Math.abs(dx || 1e-9), (NODE_H / 2 + 4) / Math.abs(dy || 1e-9));
  return [b.cx + dx * s, b.cy + dy * s];
}

/**
 * State-machine diagram (§Faz 6 "görsel durum makinesi"): statuses in one column per category, transitions as
 * curved arrows with their labels, "from any status" transitions as a dashed entry. The diagram is a picture of
 * the lists below it (where everything is edited with the keyboard); nodes are buttons that select a status.
 */
export function WorkflowDiagram({ statuses, transitions, selected, onSelect }: { statuses: DraftStatus[]; transitions: DraftTransition[]; selected: string | null; onSelect: (key: string) => void }) {
  const boxes = new Map<string, Box>();
  const rows = [0, 0, 0];
  for (const s of statuses) {
    const col = CATEGORIES.indexOf(s.category);
    const row = rows[col] ?? 0;
    rows[col] = row + 1;
    // The middle column starts a row lower, so arrows between the outer columns can arc above it.
    boxes.set(s.key, { key: s.key, cx: col * COL_W + COL_W / 2, cy: TOP + (row + (col === 1 ? 1 : 0)) * ROW_H + NODE_H / 2 });
  }
  const height = TOP + Math.max(1, ...rows.map((n, c) => n + (c === 1 ? 1 : 0))) * ROW_H;
  const width = COL_W * CATEGORIES.length;
  const pairs = new Set(transitions.filter((x) => x.from !== null).map((x) => `${String(x.from)}>${x.to}`));

  const edges = transitions.flatMap((x, i): Edge[] => {
    const b = boxes.get(x.to);
    if (!b) return [];
    if (x.from === null) {
      return [{ i, kind: 'any', x, path: `M ${String(b.cx)} ${String(b.cy - NODE_H / 2 - 26)} L ${String(b.cx)} ${String(b.cy - NODE_H / 2 - 4)}`, lx: b.cx, ly: b.cy - NODE_H / 2 - 34 }];
    }
    const a = boxes.get(x.from);
    if (!a) return [];
    const mx = (a.cx + b.cx) / 2;
    const my = (a.cy + b.cy) / 2;
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const len = Math.hypot(dx, dy) || 1;
    // Same column → bulge sideways; skipping a column → arc around it; a reverse pair → each to its own side.
    const sameCol = Math.abs(dx) < 1;
    const skips = Math.abs(dx) > COL_W * 1.5;
    const reverse = pairs.has(`${x.to}>${x.from}`);
    // Arcs over the middle column always bend upwards (the perpendicular points down for left-to-right edges).
    const up = (skips ? 40 + (reverse && dx < 0 ? 26 : 0) : 0) * (dx > 0 ? -1 : 1);
    const k = sameCol ? 46 + Math.abs(dy) * 0.12 : skips ? up : reverse ? 20 : 0;
    const cx = mx + (-dy / len) * k;
    const cy = my + (dx / len) * k;
    const [sx, sy] = edgePoint(a, cx, cy);
    const [ex, ey] = edgePoint(b, cx, cy);
    return [{ i, kind: 'pair', x, path: `M ${String(sx)} ${String(sy)} Q ${String(cx)} ${String(cy)} ${String(ex)} ${String(ey)}`, lx: 0.25 * sx + 0.5 * cx + 0.25 * ex, ly: 0.25 * sy + 0.5 * cy + 0.25 * ey }];
  });

  const label = (s: DraftStatus) => s.label || s.key;
  return (
    <figure className="m-0 overflow-x-auto rounded-card border border-line bg-surface" data-testid="workflow-diagram">
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0" aria-hidden>
          <defs>
            <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-secondary)" />
            </marker>
            <marker id="wf-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {CATEGORIES.map((c, i) => (
            <text key={c} x={i * COL_W + COL_W / 2} y={22} textAnchor="middle" className="fill-fg-muted text-xs font-semibold">
              {t(`settings.wf.category.${c}`)}
            </text>
          ))}
          {edges.map((e) => {
            const on = selected !== null && (e.x.from === selected || e.x.to === selected);
            return (
              <g key={`${String(e.i)}-${e.x.key}`} data-testid="workflow-edge" data-from={e.x.from ?? '*'} data-to={e.x.to}>
                <path
                  d={e.path}
                  fill="none"
                  stroke={on ? 'var(--accent)' : 'var(--text-secondary)'}
                  strokeWidth={on ? 2 : 1.25}
                  strokeDasharray={e.kind === 'any' ? '4 3' : undefined}
                  markerEnd={`url(#${on ? 'wf-arrow-on' : 'wf-arrow'})`}
                />
                <text x={e.lx} y={e.ly} textAnchor="middle" dominantBaseline="middle" className="fill-fg text-[11px]" stroke="var(--bg-surface)" strokeWidth={4} paintOrder="stroke">
                  {e.kind === 'any' ? `${e.x.label || e.x.key} · ${t('settings.wf.fromAny')}` : e.x.label || e.x.key}
                </text>
              </g>
            );
          })}
        </svg>
        {statuses.map((s) => {
          const b = boxes.get(s.key);
          if (!b) return null;
          return (
            <button
              key={s.uid}
              type="button"
              onClick={() => { onSelect(s.key); }}
              aria-pressed={selected === s.key}
              data-testid="workflow-node"
              data-key={s.key}
              className={cn(
                'absolute flex items-center justify-center gap-1 whitespace-nowrap rounded-btn border bg-surface px-2 text-sm shadow-card',
                selected === s.key ? 'border-accent ring-2 ring-accent/30' : 'border-line-strong',
                focusRing,
              )}
              style={{ left: b.cx - NODE_W / 2, top: b.cy - NODE_H / 2, width: NODE_W, height: NODE_H }}
            >
              <StatusBadge category={s.category} colorToken={s.colorToken} label={label(s)} />
              {s.isInitial ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" title={t('settings.wf.initial')} /> : null}
              {s.isInitial ? <span className="sr-only">{t('settings.wf.initial')}</span> : null}
            </button>
          );
        })}
      </div>
      <p aria-hidden className="sticky left-0 m-0 flex flex-wrap gap-x-4 gap-y-1 px-3 pb-2 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" />{t('settings.wf.legendInitial')}</span>
        <span className="inline-flex items-center gap-1.5"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="var(--text-secondary)" strokeDasharray="4 3" /></svg>{t('settings.wf.legendAny')}</span>
      </p>
      <figcaption className="sr-only">
        {t('settings.wf.diagramSummary', {
          statuses: statuses.map(label).join(', '),
          transitions: transitions.map((x) => `${x.from === null ? t('settings.wf.fromAny') : (statuses.find((s) => s.key === x.from)?.label ?? x.from)} → ${statuses.find((s) => s.key === x.to)?.label ?? x.to}`).join('; '),
        })}
      </figcaption>
    </figure>
  );
}
