import type { Workflow, WorkflowDraft } from '../../../../../lib/settings';
import { labelOf, toKey } from '../../../../../lib/settings';

export type Category = 'open' | 'in_progress' | 'closed';

export interface DraftStatus {
  /** Stable identity inside the editor (React keys); the stored id when there is one. */
  uid: string;
  /** Absent for a status added in this editing session. */
  id?: string;
  key: string;
  /** Turkish label as edited; `labels` keeps the other languages. */
  label: string;
  labels: Record<string, string>;
  category: Category;
  colorToken: string;
  isInitial: boolean;
  wipLimit: number | null;
  probability?: number;
}

export interface DraftTransition {
  uid: string;
  /** True for a transition added in this session: its key still follows its label. */
  fresh?: boolean;
  key: string;
  label: string;
  labels: Record<string, string>;
  from: string | null;
  to: string;
  conditions: unknown[];
  validators: unknown[];
  postFunctions: unknown[];
}

export interface Draft {
  name: string;
  statuses: DraftStatus[];
  transitions: DraftTransition[];
}

export const COLOR_TOKENS = ['text-secondary', 'info', 'accent', 'success', 'warning', 'danger'] as const;

export function fromWorkflow(wf: Workflow, probabilities?: Map<string, number>): Draft {
  const keyOf = new Map(wf.statuses.map((s) => [s.id, s.key]));
  return {
    name: wf.name,
    statuses: wf.statuses.map((s) => ({
      uid: s.id, id: s.id, key: s.key, label: labelOf(s.label, s.key), labels: s.label, category: s.category, colorToken: s.colorToken,
      isInitial: s.isInitial, wipLimit: s.wipLimit,
      ...(probabilities?.has(s.id) ? { probability: probabilities.get(s.id) ?? 0 } : {}),
    })),
    transitions: wf.transitions.map((x) => ({
      uid: x.id, key: x.key, label: labelOf(x.label, x.key), labels: x.label, from: x.fromStatusId ? (keyOf.get(x.fromStatusId) ?? null) : null, to: keyOf.get(x.toStatusId) ?? '',
      conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions,
    })),
  };
}

const withTr = (labels: Record<string, string>, tr: string, fallback: string): Record<string, string> => ({ ...labels, tr: tr.trim() || fallback });

export function toBody(d: Draft, statusMap: Record<string, string> = {}, isOpportunity = false): WorkflowDraft {
  return {
    name: d.name.trim(),
    statuses: d.statuses.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      key: s.key, label: withTr(s.labels, s.label, s.key), category: s.category, colorToken: s.colorToken, isInitial: s.isInitial, wipLimit: s.wipLimit,
      ...(isOpportunity && s.probability !== undefined ? { probability: s.probability } : {}),
    })),
    transitions: d.transitions.map((x) => ({
      key: x.key, label: withTr(x.labels, x.label, x.key), from: x.from, to: x.to,
      conditions: x.conditions as WorkflowDraft['transitions'][number]['conditions'],
      validators: x.validators as WorkflowDraft['transitions'][number]['validators'],
      postFunctions: x.postFunctions as WorkflowDraft['transitions'][number]['postFunctions'],
    })),
    statusMap,
  };
}

/** A key not yet used in `taken`, derived from a label. */
export function uniqueKey(label: string, taken: Iterable<string>, fallback: string): string {
  const used = new Set(taken);
  const base = toKey(label || fallback) || fallback;
  if (!used.has(base) && base.length >= 2) return base;
  for (let i = 2; i < 1000; i++) {
    const k = `${base.slice(0, 44)}_${String(i)}`;
    if (!used.has(k)) return k;
  }
  return `${fallback}_${String(Date.now())}`;
}

export type Problem =
  | { kind: 'initial'; count: number }
  | { kind: 'unreachable'; label: string }
  | { kind: 'noTransitions' }
  | { kind: 'tooFew' }
  | { kind: 'emptyName' }
  | { kind: 'duplicateTransition'; label: string }
  | { kind: 'selfTransition'; label: string };

/** The engine's rules (packages/workflow validateWorkflow), checked live so the editor can explain them. */
export function problemsOf(d: Draft): Problem[] {
  const out: Problem[] = [];
  if (!d.name.trim()) out.push({ kind: 'emptyName' });
  if (d.statuses.length < 2) out.push({ kind: 'tooFew' });
  const initial = d.statuses.filter((s) => s.isInitial);
  if (initial.length !== 1) out.push({ kind: 'initial', count: initial.length });
  if (d.transitions.length === 0) out.push({ kind: 'noTransitions' });
  const seen = new Set<string>();
  for (const x of d.transitions) {
    if (seen.has(x.key)) out.push({ kind: 'duplicateTransition', label: x.label || x.key });
    seen.add(x.key);
    if (x.from === x.to) out.push({ kind: 'selfTransition', label: x.label || x.key });
  }
  const start = initial[0];
  if (start) {
    const reached = new Set([start.key]);
    const queue = [start.key];
    for (let i = 0; i < queue.length; i++) {
      for (const x of d.transitions) {
        if ((x.from === queue[i] || x.from === null) && !reached.has(x.to)) {
          reached.add(x.to);
          queue.push(x.to);
        }
      }
    }
    for (const s of d.statuses) if (!reached.has(s.key)) out.push({ kind: 'unreachable', label: s.label || s.key });
  }
  return out;
}

/** Re-derives the key of a status added in this session from its label (transitions follow). Stored statuses keep theirs. */
export function rekeyStatus(d: Draft, key: string): Draft {
  const s = d.statuses.find((x) => x.key === key);
  if (!s || s.id) return d;
  const next = uniqueKey(s.label, d.statuses.filter((x) => x.key !== key).map((x) => x.key), 'status');
  if (next === key) return d;
  return {
    ...d,
    statuses: d.statuses.map((x) => (x.key === key ? { ...x, key: next } : x)),
    transitions: d.transitions.map((x) => ({ ...x, from: x.from === key ? next : x.from, to: x.to === key ? next : x.to })),
  };
}

/** Same for a transition added in this session. */
export function rekeyTransition(d: Draft, i: number): Draft {
  const x = d.transitions[i];
  if (!x?.fresh) return d;
  const next = uniqueKey(x.label, d.transitions.filter((_, j) => j !== i).map((y) => y.key), 'move');
  return next === x.key ? d : { ...d, transitions: d.transitions.map((y, j) => (j === i ? { ...y, key: next } : y)) };
}
