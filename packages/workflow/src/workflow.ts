export type StatusCategory = 'open' | 'in_progress' | 'closed';
export interface WfStatus {
  id: string;
  key: string;
  category: StatusCategory;
  isInitial: boolean;
}
export type Condition =
  | { kind: 'role'; anyOf: string[] }
  | { kind: 'is_owner' }
  | { kind: 'field_present'; field: string }
  | { kind: 'field_equals'; field: string; value: string | number | boolean | null };
export type Validator =
  | { kind: 'required_fields'; fields: string[] }
  | { kind: 'subtasks_closed' }
  | { kind: 'no_open_blockers' };
export type PostFunction =
  | { kind: 'set_field'; field: string; value: string | number | boolean | null }
  | { kind: 'clear_field'; field: string }
  | { kind: 'assign_to_actor' };
export interface WfTransition {
  id: string;
  key: string;
  fromStatusId: string | null;
  toStatusId: string;
  conditions: Condition[];
  validators: Validator[];
  postFunctions: PostFunction[];
}
export interface Workflow {
  statuses: WfStatus[];
  transitions: WfTransition[];
}
export interface TransitionFacts {
  actorUserId: string;
  actorRoleKeys: readonly string[];
  ownerUserId: string | null;
  record: Readonly<Record<string, unknown>>;
  openSubtaskCount: number;
  openBlockerCount: number;
}
export type TransitionResult =
  | { ok: true; transition: WfTransition; patch: Record<string, unknown> }
  | { ok: false; code: 'WORKFLOW_TRANSITION_NOT_ALLOWED'; allowed: string[] }
  | { ok: false; code: 'WORKFLOW_CONDITION_FAILED'; failed: Condition[] }
  | {
      ok: false;
      code: 'WORKFLOW_VALIDATION_FAILED';
      failed: { validator: Validator; fields?: string[] }[];
    };

/** Throws an Error describing the first structural problem found in the workflow. */
export function validateWorkflow(wf: Workflow): void {
  const initial = wf.statuses.filter((s) => s.isInitial);
  if (initial.length === 0) throw new Error('Workflow must have exactly one initial status, found none');
  if (initial.length > 1) {
    throw new Error(
      `Workflow must have exactly one initial status, found ${String(initial.length)}: ${initial.map((s) => s.key).join(', ')}`,
    );
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const s of wf.statuses) {
    if (ids.has(s.id)) throw new Error(`Duplicate status id: ${s.id}`);
    if (keys.has(s.key)) throw new Error(`Duplicate status key: ${s.key}`);
    ids.add(s.id);
    keys.add(s.key);
  }
  const tKeys = new Set<string>();
  for (const t of wf.transitions) {
    if (tKeys.has(t.key)) throw new Error(`Duplicate transition key: ${t.key}`);
    tKeys.add(t.key);
    if (t.fromStatusId !== null && !ids.has(t.fromStatusId)) {
      throw new Error(`Transition ${t.key} references unknown from status: ${t.fromStatusId}`);
    }
    if (!ids.has(t.toStatusId)) {
      throw new Error(`Transition ${t.key} references unknown to status: ${t.toStatusId}`);
    }
    if (t.fromStatusId === t.toStatusId) {
      throw new Error(`Transition ${t.key} is a self-transition on status ${t.toStatusId}`);
    }
  }
  const start = initial[0];
  if (start === undefined) return;
  const reached = new Set<string>([start.id]);
  const queue: string[] = [start.id];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const t of wf.transitions) {
      if ((t.fromStatusId === cur || t.fromStatusId === null) && !reached.has(t.toStatusId)) {
        reached.add(t.toStatusId);
        queue.push(t.toStatusId);
      }
    }
  }
  const unreachable = wf.statuses.filter((s) => !reached.has(s.id));
  if (unreachable.length > 0) {
    throw new Error(
      `Statuses unreachable from the initial status: ${unreachable.map((s) => s.key).join(', ')}`,
    );
  }
}

function conditionPasses(c: Condition, facts: TransitionFacts): boolean {
  switch (c.kind) {
    case 'role':
      return c.anyOf.some((r) => facts.actorRoleKeys.includes(r));
    case 'is_owner':
      return facts.ownerUserId !== null && facts.ownerUserId === facts.actorUserId;
    case 'field_present':
      return Object.hasOwn(facts.record, c.field) && facts.record[c.field] !== undefined;
    case 'field_equals':
      return facts.record[c.field] === c.value;
  }
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function candidates(wf: Workflow, fromStatusId: string): WfTransition[] {
  return wf.transitions.filter((t) => t.fromStatusId === fromStatusId || t.fromStatusId === null);
}

/** Transitions leaving `fromStatusId` whose conditions pass (validators are not evaluated). */
export function allowedTransitions(
  wf: Workflow,
  fromStatusId: string,
  facts: TransitionFacts,
): WfTransition[] {
  return candidates(wf, fromStatusId).filter(
    (t) => t.toStatusId !== fromStatusId && t.conditions.every((c) => conditionPasses(c, facts)),
  );
}

export function resolveTransition(
  wf: Workflow,
  fromStatusId: string,
  target: { transitionKey: string } | { toStatusId: string },
  facts: TransitionFacts,
): TransitionResult {
  const matches = candidates(wf, fromStatusId).filter((t) =>
    'transitionKey' in target ? t.key === target.transitionKey : t.toStatusId === target.toStatusId,
  );
  const transition =
    matches.find((t) => t.fromStatusId === fromStatusId) ?? matches.find((t) => t.fromStatusId === null);
  if (transition === undefined || transition.toStatusId === fromStatusId) {
    return {
      ok: false,
      code: 'WORKFLOW_TRANSITION_NOT_ALLOWED',
      allowed: allowedTransitions(wf, fromStatusId, facts).map((t) => t.key),
    };
  }

  const failedConditions = transition.conditions.filter((c) => !conditionPasses(c, facts));
  if (failedConditions.length > 0) {
    return { ok: false, code: 'WORKFLOW_CONDITION_FAILED', failed: failedConditions };
  }

  const failedValidators: { validator: Validator; fields?: string[] }[] = [];
  for (const v of transition.validators) {
    switch (v.kind) {
      case 'required_fields': {
        const missing = v.fields.filter((f) => isMissing(facts.record[f]));
        if (missing.length > 0) failedValidators.push({ validator: v, fields: missing });
        break;
      }
      case 'subtasks_closed':
        if (facts.openSubtaskCount > 0) failedValidators.push({ validator: v });
        break;
      case 'no_open_blockers':
        if (facts.openBlockerCount > 0) failedValidators.push({ validator: v });
        break;
    }
  }
  if (failedValidators.length > 0) {
    return { ok: false, code: 'WORKFLOW_VALIDATION_FAILED', failed: failedValidators };
  }

  const patch: Record<string, unknown> = {};
  for (const p of transition.postFunctions) {
    switch (p.kind) {
      case 'set_field':
        patch[p.field] = p.value;
        break;
      case 'clear_field':
        patch[p.field] = null;
        break;
      case 'assign_to_actor':
        patch['assignee_user_id'] = facts.actorUserId;
        break;
    }
  }
  return { ok: true, transition, patch };
}
