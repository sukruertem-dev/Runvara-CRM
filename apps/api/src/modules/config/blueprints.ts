import { BLUEPRINTS } from '@flexa/config';
import { BlueprintSummary, ConfigBundle, type z } from '@flexa/contracts';
import { ProblemError } from '../../common/problem';

// Industry blueprints (CFG-04): the data lives in packages/config; here each one is checked against the
// bundle contract.

const BlueprintFile = BlueprintSummary.pick({ id: true, version: true, nameKey: true, descriptionKey: true }).extend({ bundle: ConfigBundle });
export type Blueprint = z.infer<typeof BlueprintFile>;

/** Parsed once at start-up: an invalid blueprint stops the process instead of failing a tenant's onboarding. */
export const BLUEPRINT_LIST: readonly Blueprint[] = BLUEPRINTS.map((raw, i) => {
  const r = BlueprintFile.safeParse(raw);
  if (!r.success) throw new Error(`blueprint #${String(i)} is invalid: ${r.error.message}`);
  return r.data;
});

export function blueprint(id: string): Blueprint {
  const b = BLUEPRINT_LIST.find((x) => x.id === id);
  if (!b) throw new ProblemError('BLUEPRINT_UNKNOWN', `unknown blueprint "${id}"`);
  return b;
}
