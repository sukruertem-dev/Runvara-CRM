'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, request, type ModuleList, type ModuleToggle } from '../../../../lib/api';
import { messageForCode } from '../../../../lib/errors';
import { moduleLabel, t } from '../../../../lib/i18n';
import { isAdminRole as isAdmin, useApp } from '../../../../lib/app-context';
import { PageContainer } from '../../../_components/app-shell';
import { Alert } from '../../../_components/ui';

type ModuleState = ModuleList['data'][number];

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asGroups(value: unknown): string[][] {
  return Array.isArray(value) ? value.map(asStringArray) : [];
}

export default function ModulesPage() {
  const { me } = useApp();
  const [modules, setModules] = useState<ModuleState[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[][] | null>(null);
  const [confirmFor, setConfirmFor] = useState<{ id: string; dependents: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await request<ModuleList>('/v1/modules');
      setModules(res.data);
    } catch (err) {
      setError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
    }
  }, []);

  useEffect(() => {
    if (isAdmin(me)) void load();
  }, [me, load]);


  if (!isAdmin(me)) {
    return (
      <PageContainer>
        <h1>{t('mod.title')}</h1>
        <Alert kind="error">{t('inv.noAccess')}</Alert>
      </PageContainer>
    );
  }

  async function toggle(m: ModuleState, cascade = false): Promise<void> {
    setBusy(m.id);
    setError(null);
    setMissing(null);
    setConfirmFor(null);
    const action = m.enabled ? 'disable' : 'enable';
    try {
      const res = await request<ModuleToggle>(`/v1/modules/${m.id}/${action}${cascade ? '?cascade=true' : ''}`, { method: 'POST' });
      setModules(res.modules);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MODULE_HAS_DEPENDENTS') {
        setConfirmFor({ id: m.id, dependents: asStringArray(err.problem.dependents) });
      } else if (err instanceof ApiError && err.code === 'MODULE_DEPENDENCY_UNMET') {
        setMissing(asGroups(err.problem.missing));
        setError(messageForCode(err.code));
      } else {
        setError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
      }
    } finally {
      setBusy(null);
    }
  }

  const confirmModule = confirmFor ? modules.find((m) => m.id === confirmFor.id) : undefined;

  return (
    <PageContainer>
      <h1>{t('mod.title')}</h1>
      <p className="muted">{t('mod.lead')}</p>
      {error ? (
        <Alert kind="error">
          <span>{error}</span>
          {missing && missing.length > 0 ? (
            <>
              {' '}
              <span>{t('mod.missing.title')}</span>
              <ul>
                {missing.map((group) => (
                  <li key={group.join('|')}>{group.map(moduleLabel).join(` ${t('mod.or')} `)}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Alert>
      ) : null}
      {confirmFor && confirmModule ? (
        <div className="alert alert-warning" role="alertdialog" aria-labelledby="confirm-h" style={{ display: 'block' }}>
          <h2 id="confirm-h">{t('mod.confirm.title')}</h2>
          <ul>
            {confirmFor.dependents.map((d) => (
              <li key={d}>{moduleLabel(d)}</li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              void toggle(confirmModule, true);
            }}
          >
            {t('mod.confirm.yes')}
          </button>{' '}
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              setConfirmFor(null);
            }}
          >
            {t('mod.confirm.no')}
          </button>
        </div>
      ) : null}
      <section className="card">
        <ul className="list">
          {modules.map((m) => {
            const labelId = `mod-${m.id}`;
            return (
              <li key={m.id} className="switch-row">
                <span id={labelId}>
                  {moduleLabel(m.displayNameKey)}
                  {m.alwaysOn ? <span className="badge">{t('mod.alwaysOn')}</span> : null}
                </span>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={m.enabled}
                  aria-labelledby={labelId}
                  disabled={m.alwaysOn || busy !== null}
                  onClick={() => {
                    void toggle(m);
                  }}
                />
              </li>
            );
          })}
        </ul>
      </section>
    </PageContainer>
  );
}
