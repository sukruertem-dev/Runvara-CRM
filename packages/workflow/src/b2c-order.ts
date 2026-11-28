// B2C order workflow (B2C-03, docs/p9-plan.md §31): new → confirmed → preparing → shipped → delivered, cancel before
// shipping, returned only through an approved return. Who may take a step is tenant configuration
// (`sales_b2c.order_workflow`): a list of role keys per step, checked with the caller's roles.

export const B2C_ORDER_STATUSES = ['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled', 'returned'] as const;
export type B2cOrderStatus = (typeof B2C_ORDER_STATUSES)[number];
export const B2C_ORDER_STEPS = ['confirm', 'prepare', 'ship', 'deliver', 'cancel'] as const;
export type B2cOrderStep = (typeof B2C_ORDER_STEPS)[number];
/** Role keys allowed per step; `payment` is who may change the payment status. */
export type B2cOrderRoles = Record<B2cOrderStep | 'payment', readonly string[]>;

const STEPS: Record<B2cOrderStep, { from: readonly B2cOrderStatus[]; to: B2cOrderStatus }> = {
  confirm: { from: ['new'], to: 'confirmed' },
  prepare: { from: ['confirmed'], to: 'preparing' },
  ship: { from: ['preparing'], to: 'shipped' },
  deliver: { from: ['shipped'], to: 'delivered' },
  cancel: { from: ['new', 'confirmed', 'preparing'], to: 'cancelled' },
};

export const DEFAULT_B2C_ORDER_ROLES: B2cOrderRoles = {
  confirm: ['admin', 'manager', 'sales_rep', 'call_agent'],
  prepare: ['admin', 'manager'],
  ship: ['admin', 'manager'],
  deliver: ['admin', 'manager'],
  cancel: ['admin', 'manager', 'sales_rep'],
  payment: ['admin', 'manager', 'sales_rep', 'call_agent'],
};

export type B2cStepResult =
  | { ok: true; to: B2cOrderStatus }
  | { ok: false; code: 'ORDER_STATE' | 'FORBIDDEN'; reason: 'wrong_status' | 'not_allowed_for_role' };

/** May `roleKeys` take `step` from `status`? The state is checked first: a step that does not apply is a conflict. */
export function b2cOrderStep(status: B2cOrderStatus, step: B2cOrderStep, roleKeys: readonly string[], roles: B2cOrderRoles): B2cStepResult {
  const s = STEPS[step];
  if (!s.from.includes(status)) return { ok: false, code: 'ORDER_STATE', reason: 'wrong_status' };
  if (!roleKeys.some((r) => roles[step].includes(r))) return { ok: false, code: 'FORBIDDEN', reason: 'not_allowed_for_role' };
  return { ok: true, to: s.to };
}

/** The steps `roleKeys` may take from `status` now (for buttons). */
export function b2cOrderSteps(status: B2cOrderStatus, roleKeys: readonly string[], roles: B2cOrderRoles): B2cOrderStep[] {
  return B2C_ORDER_STEPS.filter((step) => b2cOrderStep(status, step, roleKeys, roles).ok);
}

/** Delivery stage shown with the order, from its status. */
export function b2cDeliveryStatus(status: B2cOrderStatus): 'pending' | 'preparing' | 'shipped' | 'delivered' | 'none' {
  switch (status) {
    case 'new':
    case 'confirmed': return 'pending';
    case 'preparing': return 'preparing';
    case 'shipped': return 'shipped';
    case 'delivered':
    case 'returned': return 'delivered';
    case 'cancelled': return 'none';
  }
}
