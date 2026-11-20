import { describe, expect, it } from 'vitest';
import { render } from './templates';

describe('mail templates', () => {
  it('renders Turkish and English with the action link in text and HTML', () => {
    const url = 'https://app.runvara.test/verify-email?token=abc';
    const tr = render({ template: 'verify_email', to: 'a@b.c', locale: 'tr-TR', vars: { displayName: 'Ayşe', url } });
    expect(tr.subject).toBe('E-posta adresinizi doğrulayın');
    expect(tr.text).toContain(url);
    expect(tr.html).toContain(url);
    const en = render({ template: 'verify_email', to: 'a@b.c', locale: 'en-US', vars: { displayName: 'Ayse', url } });
    expect(en.subject).toBe('Verify your e-mail address');
  });

  it('escapes user-controlled values in HTML', () => {
    const m = render({ template: 'invitation', to: 'a@b.c', locale: 'tr-TR', vars: { tenantName: '<script>x</script>', inviterName: 'A&B', url: 'https://x.test/?a=1&b="2"' } });
    expect(m.html).not.toContain('<script>x</script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('A&amp;B');
    expect(m.html).toContain('&quot;2&quot;');
  });

  it('covers every template in both locales', () => {
    const vars = { displayName: 'x', url: 'https://x.test', loginUrl: 'https://x.test/l', resetUrl: 'https://x.test/r', tenantName: 't', inviterName: 'i' };
    for (const template of ['verify_email', 'reset_password', 'signup_exists', 'invitation'] as const) {
      for (const locale of ['tr-TR', 'en-US'] as const) {
        const m = render({ template, to: 'a@b.c', locale, vars } as never);
        expect(m.subject.length, `${template} ${locale}`).toBeGreaterThan(5);
      }
    }
  });
});
