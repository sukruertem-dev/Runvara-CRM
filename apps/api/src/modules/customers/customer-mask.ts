import { hiddenFields } from '../../common/record-access';
import type { TenantRequestContext } from '../../common/request-context';

/** Contact field policies apply here as on `/v1/contacts`: a hidden name or hidden contact points are not shown
 *  and cannot be searched. */
export function contactMask(t: TenantRequestContext): { name: boolean; points: boolean } {
  const hidden = hiddenFields(t, 'contact');
  return { name: !['fullName', 'firstName', 'lastName'].some((f) => hidden.has(f)), points: !hidden.has('contactPoints') };
}
