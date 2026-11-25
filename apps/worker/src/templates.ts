import type { MailJob } from '@flexa/contracts';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// E-mail clients ignore CSS variables; these literals mirror tokens.json (light theme) and are the only
// colour literals outside the token file. Keep in sync with packages/ui/tokens.json.
const C = { canvas: '#F8F9FC', surface: '#FFFFFF', text: '#1A1B1F', muted: '#646B7E', button: '#7B3CFF', onButton: '#FFFFFF', border: '#E7E7EF' };

function layout(title: string, paragraphs: string[], action: { label: string; url: string } | null, footer: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;font:16px/1.5 Inter,Arial,sans-serif;color:${C.text}">${escape(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escape(action.url)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:${C.button};color:${C.onButton};font:600 16px Inter,Arial,sans-serif;text-decoration:none">${escape(action.label)}</a></p>
       <p style="margin:0 0 16px;font:14px/1.5 Inter,Arial,sans-serif;color:${C.muted};word-break:break-all">${escape(action.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:${C.canvas}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};padding:32px 16px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.surface};border:1px solid ${C.border};border-radius:14px;padding:32px">
<tr><td><p style="margin:0 0 24px;font:700 22px Inter,Arial,sans-serif;letter-spacing:-0.02em;color:${C.text}">Flexa</p>
<h1 style="margin:0 0 16px;font:700 20px Inter,Arial,sans-serif;color:${C.text}">${escape(title)}</h1>${body}${button}
<p style="margin:24px 0 0;font:12px/1.5 Inter,Arial,sans-serif;color:${C.muted}">${escape(footer)}</p></td></tr></table></td></tr></table></body></html>`;
}

function make(title: string, paragraphs: string[], action: { label: string; url: string } | null, footer: string): RenderedMail {
  const text = [title, '', ...paragraphs, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', footer].join('\n');
  return { subject: title, text, html: layout(title, paragraphs, action, footer) };
}

const PARAGRAPH_BREAK = /\n{2,}/;

export function render(job: MailJob): RenderedMail {
  const tr = job.locale === 'tr-TR';
  switch (job.template) {
    case 'verify_email':
      return tr
        ? make('E-posta adresinizi doğrulayın', [`Merhaba ${job.vars.displayName},`, 'Flexa hesabınızı etkinleştirmek için e-posta adresinizi doğrulayın. Bağlantı 30 dakika geçerlidir.'], { label: 'E-postamı doğrula', url: job.vars.url }, 'Bu işlemi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.')
        : make('Verify your e-mail address', [`Hello ${job.vars.displayName},`, 'Verify your e-mail address to activate your Flexa account. The link is valid for 30 minutes.'], { label: 'Verify my e-mail', url: job.vars.url }, 'If you did not request this, you can ignore this e-mail.');
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
        ? make(`${job.vars.tenantName} sizi Flexa'ya davet ediyor`, [`${job.vars.inviterName}, sizi ${job.vars.tenantName} çalışma alanına davet etti. Davet 7 gün geçerlidir.`], { label: 'Daveti kabul et', url: job.vars.url }, 'Bu daveti beklemiyorsanız yok sayabilirsiniz.')
        : make(`${job.vars.tenantName} invited you to Flexa`, [`${job.vars.inviterName} invited you to the ${job.vars.tenantName} workspace. The invitation is valid for 7 days.`], { label: 'Accept invitation', url: job.vars.url }, 'If you were not expecting this, you can ignore it.');
    case 'notification_digest': {
      // Only titles the recipient may still see (checked when the digest was built); no record content.
      const lines = job.vars.items.map((i) => `• ${i.title}${i.message ? ` — ${i.message}` : ''}`);
      const more = job.vars.more > 0 ? [tr ? `ve ${job.vars.more} bildirim daha` : `and ${job.vars.more} more`] : [];
      return tr
        ? make(`${job.vars.tenantName}: okunmamış bildirimleriniz var`, [...lines, ...more], { label: 'Bildirimleri aç', url: job.vars.url }, 'Bu özeti bildirim tercihlerinizden kapatabilirsiniz.')
        : make(`${job.vars.tenantName}: you have unread notifications`, [...lines, ...more], { label: 'Open notifications', url: job.vars.url }, 'You can turn this digest off in your notification preferences.');
    }
    case 'automation_notice':
      // Subject and body come from a rule written by the workspace Admin; they are escaped like all text.
      return tr
        ? make(job.vars.subject, job.vars.body.split(PARAGRAPH_BREAK), { label: 'Kaydı aç', url: job.vars.url }, `${job.vars.tenantName} çalışma alanındaki bir otomasyon kuralı tarafından gönderildi.`)
        : make(job.vars.subject, job.vars.body.split(PARAGRAPH_BREAK), { label: 'Open record', url: job.vars.url }, `Sent by an automation rule in the ${job.vars.tenantName} workspace.`);
    case 'quote': {
      // The sender's own words; the document is attached. No link: the customer has no account.
      const extra = job.vars.message ? job.vars.message.split(PARAGRAPH_BREAK) : [];
      return tr
        ? make(`${job.vars.tenantName}: teklif ${job.vars.number}`, [...extra, `Teklifimiz ektedir. Genel toplam: ${job.vars.total}. Geçerlilik: ${job.vars.validUntil}.`], null, `${job.vars.tenantName} adına gönderildi. Yanıtınız teklifi gönderen kişiye ulaşır.`)
        : make(`${job.vars.tenantName}: quote ${job.vars.number}`, [...extra, `Our quote is attached. Grand total: ${job.vars.total}. Valid until: ${job.vars.validUntil}.`], null, `Sent on behalf of ${job.vars.tenantName}. Your reply goes to the person who sent the quote.`);
    }
    case 'quota_warning': {
      // ADR-0014 §3: 80 % warns, 100 % stops new invitations and uploads, 120 % stops the related writes.
      const what = (tr ? QUOTA_TR : QUOTA_EN)[job.vars.dimension];
      const usage = `${job.vars.used} / ${job.vars.limit}`;
      const effect = tr
        ? { warning: 'Sınıra yaklaşıyorsunuz; şimdilik her şey çalışmaya devam ediyor.', soft: 'Sınıra ulaşıldı: yeni kullanıcı daveti ve yeni dosya yükleme durduruldu. Mevcut çalışma sürüyor.', hard: 'Sınır %20 aşıldı: yeni kayıt oluşturma durduruldu. Okuma ve dışa aktarma her zaman açıktır.' }[job.vars.level]
        : { warning: 'You are close to the limit; everything keeps working for now.', soft: 'The limit is reached: new invitations and new uploads are stopped. Existing work continues.', hard: 'The limit is exceeded by 20 %: creating new records is stopped. Reading and exporting always stay available.' }[job.vars.level];
      return tr
        ? make(`${job.vars.tenantName}: ${what} kotası`, [`Kullanım: ${usage}.`, effect, 'Planınızı yükseltmek veya sınırı artırmak için Flexa desteğiyle iletişime geçin.'], { label: 'Kullanımı görüntüle', url: job.vars.url }, 'Bu e-postayı çalışma alanı yöneticisi olduğunuz için aldınız.')
        : make(`${job.vars.tenantName}: ${what} quota`, [`Usage: ${usage}.`, effect, 'Contact Flexa support to upgrade your plan or raise the limit.'], { label: 'View usage', url: job.vars.url }, 'You receive this e-mail because you administer the workspace.');
    }
    case 'support_request': {
      // TEN-08: nothing happens until an Admin approves; the operator's reason is shown as written.
      const hours = (job.vars.minutes / 60).toLocaleString(tr ? 'tr-TR' : 'en-US', { maximumFractionDigits: 1 });
      return tr
        ? make(`${job.vars.tenantName}: destek erişimi talebi`, [`Flexa destek ekibinden ${job.vars.operatorName}, çalışma alanınıza ${hours} saatlik salt okuma erişimi istiyor.`, `Gerekçe: ${job.vars.reason}`, 'Onaylamadığınız sürece hiçbir erişim verilmez. Onaylarsanız erişimi istediğiniz an sonlandırabilirsiniz.'], { label: 'Talebi incele', url: job.vars.url }, 'Bu e-postayı çalışma alanı yöneticisi olduğunuz için aldınız.')
        : make(`${job.vars.tenantName}: support access request`, [`${job.vars.operatorName} from Flexa support asks for ${hours} hours of read-only access to your workspace.`, `Reason: ${job.vars.reason}`, 'No access is given unless you approve. If you approve, you can end it at any moment.'], { label: 'Review the request', url: job.vars.url }, 'You receive this e-mail because you administer the workspace.');
    }
  }
}

const QUOTA_TR: Record<string, string> = { users: 'Kullanıcı', storage_bytes: 'Depolama', records: 'Kayıt', call_minutes: 'Arama dakikası', ai_tokens: 'AI kullanımı' };
const QUOTA_EN: Record<string, string> = { users: 'User', storage_bytes: 'Storage', records: 'Record', call_minutes: 'Call minute', ai_tokens: 'AI usage' };
