'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, bootstrapSession, isSupportEnded, request, type Me } from './api';

/** Protected-page guard: resumes the session, loads /v1/me, redirects to /login on failure. */
export function useRequireSession(): { me: Me | null } {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    const live = { cancelled: false };
    void (async () => {
      const ok = await bootstrapSession();
      if (!ok) {
        router.replace('/login');
        return;
      }
      try {
        const data = await request<Me>('/v1/me');
        if (!live.cancelled) setMe(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && !isSupportEnded(err)) router.replace('/login');
      }
    })();
    return () => {
      live.cancelled = true;
    };
  }, [router]);

  return { me };
}

export function isAdmin(me: Me): boolean {
  return me.tenant?.roles.includes('admin') ?? false;
}
