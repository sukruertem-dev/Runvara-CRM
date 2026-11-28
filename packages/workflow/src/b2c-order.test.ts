import { describe, expect, it } from 'vitest';
import { b2cDeliveryStatus, b2cOrderStep, b2cOrderSteps, DEFAULT_B2C_ORDER_ROLES as R } from './b2c-order';

describe('B2C order workflow (B2C-03)', () => {
  it('walks new → confirmed → preparing → shipped → delivered', () => {
    expect(b2cOrderStep('new', 'confirm', ['sales_rep'], R)).toEqual({ ok: true, to: 'confirmed' });
    expect(b2cOrderStep('confirmed', 'prepare', ['manager'], R)).toEqual({ ok: true, to: 'preparing' });
    expect(b2cOrderStep('preparing', 'ship', ['admin'], R)).toEqual({ ok: true, to: 'shipped' });
    expect(b2cOrderStep('shipped', 'deliver', ['manager'], R)).toEqual({ ok: true, to: 'delivered' });
  });

  it('steps are role based; a step that does not apply is a conflict whoever asks', () => {
    expect(b2cOrderStep('confirmed', 'prepare', ['sales_rep'], R)).toEqual({ ok: false, code: 'FORBIDDEN', reason: 'not_allowed_for_role' });
    expect(b2cOrderStep('new', 'ship', ['admin'], R)).toEqual({ ok: false, code: 'ORDER_STATE', reason: 'wrong_status' });
    expect(b2cOrderStep('shipped', 'cancel', ['admin'], R)).toMatchObject({ ok: false, code: 'ORDER_STATE' });
    expect(b2cOrderStep('new', 'confirm', ['analyst'], R)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(b2cOrderStep('new', 'confirm', ['analyst'], { ...R, confirm: ['analyst'] })).toMatchObject({ ok: true });
  });

  it('offers only the steps the roles may take now', () => {
    expect(b2cOrderSteps('new', ['sales_rep'], R)).toEqual(['confirm', 'cancel']);
    expect(b2cOrderSteps('confirmed', ['call_agent'], R)).toEqual([]);
    expect(b2cOrderSteps('delivered', ['admin'], R)).toEqual([]);
    expect(b2cOrderSteps('returned', ['admin'], R)).toEqual([]);
  });

  it('delivery stage follows the status', () => {
    expect(['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled', 'returned'].map((s) => b2cDeliveryStatus(s as never)))
      .toEqual(['pending', 'pending', 'preparing', 'shipped', 'delivered', 'none', 'delivered']);
  });
});
