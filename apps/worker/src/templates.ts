import type { MailJob } from '@runvara/contracts';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// E-mail clients ignore CSS variables; these literals mirror tokens.json (light theme) and are the only
// colour literals outside the token file. Keep in sync with packages/ui/tokens.json.
const C = { canvas: '#F4F1EA', surface: '#FFFFFF', text: '#2B2D31', muted: '#5C5F66', button: '#2B2D31', onButton: '#F4F1EA', border: '#E2DDD3' };

function layout(title: string, paragraphs: string[], action: { label: string; url: string } | null, footer: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;font:16px/1.5 Inter,Arial,sans-serif;color:${C.text}">${escape(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escape(action.url)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:${C.button};color:${C.onButton};font:500 16px Inter,Arial,sans-serif;text-decoration:none">${escape(action.label)}</a></p>
       <p style="margin:0 0 16px;font:14px/1.5 Inter,Arial,sans-serif;color:${C.muted};word-break:break-all">${escape(action.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:${C.canvas}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};padding:32px 16px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.surface};border:1px solid ${C.border};border-radius:16px;padding:32px">
<tr><td><p style="margin:0 0 24px;font:700 22px 'Space Grotesk',Arial,sans-serif;letter-spacing:-0.045em;color:${C.text}">runvara</p>
<h1 style="margin:0 0 16px;font:700 20px 'Space Grotesk',Arial,sans-serif;color:${C.text}">${escape(title)}</h1>${body}${button}
<p style="margin:24px 0 0;font:12px/1.5 Inter,Arial,sans-serif;color:${C.muted}">${escape(footer)}</p></td></tr></table></td></tr></table></body></html>`;
}

function make(title: string, paragraphs: string[], action: { label: string; url: string } | null, footer: string): RenderedMail {
  const text = [title, '', ...paragraphs, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', footer].join('\n');
  return { subject: title, text, html: layout(title, paragraphs, action, footer) };
}

export function render(job: MailJob): RenderedMail {
  const tr = job.locale === 'tr-TR';
  switch (job.template) {
    case 'verify_email':
      return tr
        ? make('E-posta adresinizi doğrulayın', [`Merhaba ${job.vars.displayName},`, 'Runvara hesabınızı etkinleştirmek için e-posta adresinizi doğrulayın. Bağlantı 30 dakika geçerlidir.'], { label: 'E-postamı doğrula', url: job.vars.url }, 'Bu işlemi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.')
        : make('Verify your e-mail address', [`Hello ${job.vars.displayName},`, 'Verify your e-mail address to activate your Runvara account. The link is valid for 30 minutes.'], { label: 'Verify my e-mail', url: job.vars.url }, 'If you did not request this, you can ignore this e-mail.');
    case 'reset_password':
      return tr
        ? make('Parola sıfırlama', [`Merhaba ${job.vars.displayName},`, 'Parolanızı sıfırlamak için aşağıdaki bağlantıyı kullanın. Bağlantı 30 dakika geçerlidir ve tüm oturumlarınız kapatılır.'], { label: 'Yeni parola belirle', url: job.vars.url }, 'Bu talebi siz yapmadıysanız parolanız değişmez; bu e-postayı yok sayabilirsiniz.')
        : make('Reset your password', [`Hello ${job.vars.displayName},`, 'Use the link below to reset your password. It is valid for 30 minutes and signs you out everywhere.'], { label: 'Set a new password', url: job.vars.url }, 'If you did not request this, your password stays unchanged.');
    case 'signup_exists':
      return tr
        ? make('Bu e-posta ile zaten bir hesabınız var', ['Bu adresle yeni bir kayıt denendi. Hesabınız zaten mevcut; giriş yapabilir veya parolanızı sıfırlayabilirsiniz.', `Parolanızı unuttuysanız: ${job.vars.resetUrl}`], { label: 'Giriş yap', url: job.vars.loginUrl }, 'Bu denemeyi siz yapmadıysanız herhangi bir işlem gerekmez.')
        : make('You already have an account', ['Someone tried to sign up with this address. Your account already exists; sign in or reset your password.', `Forgot your password: ${job.vars.resetUrl}`], { label: 'Sign in', url: job.vars.loginUrl }, 'If this was not you, no action is needed.');
    case 'invitation':
      return tr
        ? make(`${job.vars.tenantName} sizi Runvara'ya davet ediyor`, [`${job.vars.inviterName}, sizi ${job.vars.tenantName} çalışma alanına davet etti. Davet 7 gün geçerlidir.`], { label: 'Daveti kabul et', url: job.vars.url }, 'Bu daveti beklemiyorsanız yok sayabilirsiniz.')
        : make(`${job.vars.tenantName} invited you to Runvara`, [`${job.vars.inviterName} invited you to the ${job.vars.tenantName} workspace. The invitation is valid for 7 days.`], { label: 'Accept invitation', url: job.vars.url }, 'If you were not expecting this, you can ignore it.');
  }
}
