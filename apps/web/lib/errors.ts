import { ApiError } from './api';
import { t, tOptional } from './i18n';

export interface FormErrors {
  form: string | null;
  fields: Record<string, string>;
}

export const NO_ERRORS: FormErrors = { form: null, fields: {} };

export function messageForCode(code: string): string {
  return tOptional(`error.${code}`) ?? t('error.fallback');
}

export function reasonsText(reasons: string[]): string {
  return reasons.map((r) => tOptional(`reason.${r}`) ?? r).join(' ');
}

/** Maps an API problem to a form-level message plus per-field messages (Turkish). */
export function parseFormError(err: unknown): FormErrors {
  if (!(err instanceof ApiError)) return { form: t('error.fallback'), fields: {} };
  const fields: Record<string, string> = {};
  if (err.code === 'PASSWORD_POLICY') {
    fields.password = reasonsText(err.reasons) || messageForCode(err.code);
    return { form: null, fields };
  }
  if (err.code === 'SLUG_TAKEN') {
    fields.tenantSlug = messageForCode(err.code);
    return { form: null, fields };
  }
  if (err.code === 'VALIDATION_FAILED') {
    for (const e of err.fieldErrors) fields[e.path] = messageForCode('VALIDATION_FAILED');
    return { form: messageForCode(err.code), fields };
  }
  return { form: messageForCode(err.code), fields };
}
