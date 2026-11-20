'use client';

import Link from 'next/link';
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { t } from '../../lib/i18n';

export function Brand({ context, large = false }: { context: 'surface' | 'panel'; large?: boolean }) {
  return (
    <span className={`brand ctx-${context}${large ? ' brand-lg' : ''}`}>
      {/* Official symbol artwork has not been supplied yet (docs/brand.md); the wordmark stands alone. */}
      <span className="wordmark">{t('brand.name')}</span>
    </span>
  );
}

export function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5v4.5M8 10.8v.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AuthLayout({ title, lead, children }: { title: string; lead?: string | undefined; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-panel">
        <Brand context="panel" large />
        <p className="tagline">{t('brand.tagline')}</p>
      </div>
      <main className="auth-main">
        <div className="card auth-card">
          <h1>{title}</h1>
          {lead ? <p className="muted">{lead}</p> : null}
          {children}
        </div>
      </main>
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'warning'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'success' ? <CheckIcon /> : <ErrorIcon />}
      <div>{children}</div>
    </div>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export function Field({ label, error, hint, id, ...rest }: FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const errId = `${inputId}-err`;
  const hintId = `${inputId}-hint`;
  const described = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="field-error" role="alert">
          <ErrorIcon />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  children: ReactNode;
}

export function SelectField({ label, children, id, ...rest }: SelectFieldProps) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <div className="field">
      <label htmlFor={selectId}>{label}</label>
      <select id={selectId} className="input" {...rest}>
        {children}
      </select>
    </div>
  );
}

export function SubmitButton({ pending, children, block = true }: { pending: boolean; children: ReactNode; block?: boolean }) {
  return (
    <button type="submit" className={`btn${block ? ' btn-block' : ''}`} disabled={pending} aria-busy={pending}>
      {pending ? t('common.pending') : children}
    </button>
  );
}

export function FormMessage({ message }: { message: string | null }) {
  return message ? <Alert kind="error">{message}</Alert> : null;
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href}>{children}</Link>;
}
