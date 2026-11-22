'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, startTransition, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, bootstrapSession, request, type Me, type Navigation, type Tenant } from './api';
import { qk } from './query';

export type Capability = Navigation['capabilities'][number];

interface AppContextValue {
  me: Me;
  tenant: Tenant | undefined;
  nav: Navigation | undefined;
  can: (capability: Capability) => boolean;
}

const Ctx = createContext<AppContextValue | null>(null);

type SessionState = { status: 'loading' } | { status: 'ready'; me: Me };

/**
 * Resumes the session once for every page under the app layout; no tenant → tenant selection, no session →
 * login. Navigation (menu, roles, segments, capabilities) is server-decided (`/v1/me/navigation`).
 */
export function useAppSession(): SessionState {
  const router = useRouter();
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  useEffect(() => {
    const live = { cancelled: false };
    void (async () => {
      if (!(await bootstrapSession())) {
        router.replace('/login');
        return;
      }
      try {
        const me = await request<Me>('/v1/me');
        if (live.cancelled) return;
        if (!me.tenant) {
          router.replace('/select-tenant');
          return;
        }
        // The first full render (shell + page) is large: as a transition React renders it in slices and keeps
        // the main thread responsive (the loading skeleton stays until it commits).
        startTransition(() => {
          setState({ status: 'ready', me });
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
      }
    })();
    return () => {
      live.cancelled = true;
    };
  }, [router]);
  return state;
}

export function AppContextProvider({ me, children }: { me: Me; children: ReactNode }) {
  const router = useRouter();
  const nav = useQuery({ queryKey: qk.navigation, queryFn: () => request<Navigation>('/v1/me/navigation'), staleTime: 60_000 });
  const tenant = useQuery({ queryKey: qk.tenant, queryFn: () => request<Tenant>('/v1/tenant'), staleTime: 300_000 });

  useEffect(() => {
    const err = nav.error ?? tenant.error;
    if (err instanceof ApiError && err.code === 'TENANT_REQUIRED') router.replace('/select-tenant');
  }, [nav.error, tenant.error, router]);

  const caps = new Set(nav.data?.capabilities ?? []);
  const value: AppContextValue = { me, tenant: tenant.data, nav: nav.data, can: (c) => caps.has(c) };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside the app layout');
  return ctx;
}

export function isAdminRole(me: Me): boolean {
  return me.tenant?.roles.includes('admin') ?? false;
}
