import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  resolveTransition,
  validateWorkflow,
  type TransitionFacts,
  type WfStatus,
  type WfTransition,
  type Workflow,
} from './index.js';

const statuses: WfStatus[] = [
  { id: 's-open', key: 'open', category: 'open', isInitial: true },
  { id: 's-prog', key: 'in_progress', category: 'in_progress', isInitial: false },
  { id: 's-review', key: 'in_review', category: 'in_progress', isInitial: false },
  { id: 's-done', key: 'done', category: 'closed', isInitial: false },
  { id: 's-cancel', key: 'cancelled', category: 'closed', isInitial: false },
];

function tr(p: Partial<WfTransition> & Pick<WfTransition, 'id' | 'key' | 'toStatusId'>): WfTransition {
  return { fromStatusId: null, conditions: [], validators: [], postFunctions: [], ...p };
}

const wf: Workflow = {
  statuses,
  transitions: [
    tr({
      id: 't1',
      key: 'start',
      fromStatusId: 's-open',
      toStatusId: 's-prog',
      postFunctions: [{ kind: 'assign_to_actor' }],
    }),
    tr({ id: 't2', key: 'to_review', fromStatusId: 's-prog', toStatusId: 's-review' }),
    tr({
      id: 't3',
      key: 'complete',
      fromStatusId: 's-review',
      toStatusId: 's-done',
      conditions: [{ kind: 'role', anyOf: ['manager', 'admin'] }],
      validators: [
        { kind: 'required_fields', fields: ['title', 'result', 'tags'] },
        { kind: 'subtasks_closed' },
        { kind: 'no_open_blockers' },
      ],
      postFunctions: [
        { kind: 'set_field', field: 'progress', value: 100 },
        { kind: 'clear_field', field: 'snooze_until' },
        { kind: 'set_field', field: 'progress', value: 99 },
      ],
    }),
    tr({ id: 't4', key: 'reopen', fromStatusId: 's-done', toStatusId: 's-open' }),
    tr({
      id: 't5',
      key: 'cancel',
      fromStatusId: null,
      toStatusId: 's-cancel',
      conditions: [{ kind: 'is_owner' }],
    }),
  ],
};

const facts = (over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  actorUserId: 'u1',
  actorRoleKeys: ['manager'],
  ownerUserId: 'u1',
  record: { title: 'T', result: 'ok', tags: ['a'] },
  openSubtaskCount: 0,
  openBlockerCount: 0,
  ...over,
});

describe('validateWorkflow', () => {
  it('accepts a realistic workflow', () => {
    expect(() => {
      validateWorkflow(wf);
    }).not.toThrow();
  });

  const bad = (w: Workflow, msg: RegExp): void => {
    expect(() => {
      validateWorkflow(w);
    }).toThrow(msg);
  };

  it('rejects zero or multiple initial statuses', () => {
    bad({ statuses: statuses.map((s) => ({ ...s, isInitial: false })), transitions: wf.transitions }, /none/);
    bad(
      { statuses: statuses.map((s) => ({ ...s, isInitial: s.id !== 's-done' })), transitions: [] },
      /exactly one initial/,
    );
  });

  it('rejects duplicate status keys and ids', () => {
    const [a, ...rest] = statuses;
    if (a === undefined) throw new Error('fixture');
    bad({ statuses: [...statuses, { ...a, id: 'x', isInitial: false }], transitions: [] }, /Duplicate status key/);
    bad({ statuses: [...statuses, { ...a, key: 'x', isInitial: false }], transitions: [] }, /Duplicate status id/);
    expect(rest.length).toBe(4);
  });

  it('rejects duplicate transition keys', () => {
    bad({ statuses, transitions: [...wf.transitions, tr({ id: 'dup', key: 'start', toStatusId: 's-prog' })] }, /Duplicate transition key/);
  });

  it('rejects unknown status references', () => {
    bad({ statuses, transitions: [...wf.transitions, tr({ id: 'x', key: 'x', toStatusId: 'nope' })] }, /unknown to status/);
    bad(
      { statuses, transitions: [...wf.transitions, tr({ id: 'x', key: 'x', fromStatusId: 'nope', toStatusId: 's-open' })] },
      /unknown from status/,
    );
  });

  it('rejects self-transitions', () => {
    bad(
      { statuses, transitions: [...wf.transitions, tr({ id: 'x', key: 'x', fromStatusId: 's-open', toStatusId: 's-open' })] },
      /self-transition/,
    );
  });

  it('rejects unreachable statuses', () => {
    bad({ statuses, transitions: wf.transitions.filter((t) => t.id !== 't2') }, /unreachable.*in_review/);
  });

  it('treats a wildcard transition as reaching its target from the initial status', () => {
    expect(() => {
      validateWorkflow({ statuses: statuses.slice(0, 1).concat(statuses.slice(4)), transitions: [wf.transitions[4] as WfTransition] });
    }).not.toThrow();
  });
});

describe('resolveTransition', () => {
  it('succeeds by key and by target status, with ordered patch', () => {
    const byKey = resolveTransition(wf, 's-review', { transitionKey: 'complete' }, facts());
    expect(byKey.ok).toBe(true);
    if (byKey.ok) {
      expect(byKey.transition.id).toBe('t3');
      expect(byKey.patch).toEqual({ progress: 99, snooze_until: null });
      expect(Object.keys(byKey.patch)).toEqual(['progress', 'snooze_until']);
    }
    const byTo = resolveTransition(wf, 's-open', { toStatusId: 's-prog' }, facts({ actorUserId: 'u9' }));
    expect(byTo).toMatchObject({ ok: true, patch: { assignee_user_id: 'u9' } });
  });

  it('supports reopen from closed', () => {
    expect(resolveTransition(wf, 's-done', { transitionKey: 'reopen' }, facts())).toMatchObject({ ok: true });
  });

  it('returns NOT_ALLOWED with allowed keys', () => {
    const r = resolveTransition(wf, 's-open', { transitionKey: 'complete' }, facts());
    expect(r).toEqual({ ok: false, code: 'WORKFLOW_TRANSITION_NOT_ALLOWED', allowed: ['start', 'cancel'] });
    expect(resolveTransition(wf, 's-open', { toStatusId: 's-done' }, facts())).toMatchObject({
      code: 'WORKFLOW_TRANSITION_NOT_ALLOWED',
    });
  });

  it('allowed list excludes transitions whose conditions fail', () => {
    const r = resolveTransition(wf, 's-open', { transitionKey: 'nope' }, facts({ ownerUserId: 'other' }));
    expect(r).toMatchObject({ allowed: ['start'] });
    expect(allowedTransitions(wf, 's-done', facts()).map((t) => t.key)).toEqual(['reopen', 'cancel']);
  });

  it('wildcard transition works from any status', () => {
    for (const s of statuses.filter((x) => x.id !== 's-cancel')) {
      expect(resolveTransition(wf, s.id, { transitionKey: 'cancel' }, facts())).toMatchObject({ ok: true });
    }
    expect(resolveTransition(wf, 's-cancel', { transitionKey: 'cancel' }, facts())).toMatchObject({
      code: 'WORKFLOW_TRANSITION_NOT_ALLOWED',
    });
  });

  it('collects every failed condition', () => {
    const w: Workflow = {
      statuses,
      transitions: [
        tr({
          id: 'c',
          key: 'c',
          fromStatusId: 's-open',
          toStatusId: 's-prog',
          conditions: [
            { kind: 'role', anyOf: ['admin'] },
            { kind: 'is_owner' },
            { kind: 'field_present', field: 'a' },
            { kind: 'field_equals', field: 'b', value: 1 },
            { kind: 'field_equals', field: 'c', value: null },
          ],
        }),
      ],
    };
    const r = resolveTransition(w, 's-open', { transitionKey: 'c' }, facts({ ownerUserId: null, record: { b: '1', c: null } }));
    expect(r).toMatchObject({ ok: false, code: 'WORKFLOW_CONDITION_FAILED' });
    if (!r.ok && r.code === 'WORKFLOW_CONDITION_FAILED') {
      expect(r.failed.map((c) => c.kind)).toEqual(['role', 'is_owner', 'field_present', 'field_equals']);
    }
  });

  it('conditions are checked before validators', () => {
    const r = resolveTransition(wf, 's-review', { transitionKey: 'complete' }, facts({ actorRoleKeys: ['member'], record: {} }));
    expect(r).toMatchObject({ code: 'WORKFLOW_CONDITION_FAILED' });
  });

  it('collects every validator failure with missing fields', () => {
    const r = resolveTransition(
      wf,
      's-review',
      { transitionKey: 'complete' },
      facts({ record: { title: '', result: null, tags: [] }, openSubtaskCount: 2, openBlockerCount: 1 }),
    );
    expect(r).toEqual({
      ok: false,
      code: 'WORKFLOW_VALIDATION_FAILED',
      failed: [
        { validator: { kind: 'required_fields', fields: ['title', 'result', 'tags'] }, fields: ['title', 'result', 'tags'] },
        { validator: { kind: 'subtasks_closed' } },
        { validator: { kind: 'no_open_blockers' } },
      ],
    });
  });

  it('required_fields treats 0 and false as present', () => {
    const w: Workflow = {
      statuses,
      transitions: [
        tr({
          id: 'v',
          key: 'v',
          fromStatusId: 's-open',
          toStatusId: 's-prog',
          validators: [{ kind: 'required_fields', fields: ['n', 'b', 'missing'] }],
        }),
      ],
    };
    const r = resolveTransition(w, 's-open', { transitionKey: 'v' }, facts({ record: { n: 0, b: false } }));
    expect(r).toMatchObject({ failed: [{ fields: ['missing'] }] });
  });

  it('prefers the exact-from transition over a wildcard one (by target status)', () => {
    const w: Workflow = {
      statuses,
      transitions: [
        tr({ id: 'w', key: 'wild', fromStatusId: null, toStatusId: 's-prog' }),
        tr({ id: 'e', key: 'exact', fromStatusId: 's-open', toStatusId: 's-prog' }),
      ],
    };
    const r = resolveTransition(w, 's-open', { toStatusId: 's-prog' }, facts());
    expect(r).toMatchObject({ ok: true, transition: { id: 'e' } });
    const r2 = resolveTransition(w, 's-review', { toStatusId: 's-prog' }, facts());
    expect(r2).toMatchObject({ ok: true, transition: { id: 'w' } });
  });

  it('never resolves to the current status', () => {
    const r = resolveTransition(wf, 's-cancel', { toStatusId: 's-cancel' }, facts());
    expect(r).toMatchObject({ code: 'WORKFLOW_TRANSITION_NOT_ALLOWED' });
  });
});
