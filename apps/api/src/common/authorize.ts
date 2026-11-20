import { can, type Decision, type GrantMode } from '@runvara/authz';
import { ProblemError } from './problem';
import type { TenantRequestContext } from './request-context';

/** Throws the problem matching an authz denial (404 module disabled, 403 otherwise). */
export function authorize(t: TenantRequestContext, permission: string, mode: GrantMode = 'full'): Extract<Decision, { allow: true }> {
  const d = can(t.authz, permission, mode);
  if (d.allow) return d;
  if (d.reason === 'module_disabled') throw new ProblemError('MODULE_DISABLED');
  throw new ProblemError('FORBIDDEN');
}
