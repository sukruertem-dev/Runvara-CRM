'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setSegmentHeader } from './api';

export type ThemePref = 'system' | 'light' | 'dark';
export type DensityPref = 'comfortable' | 'compact';
export type SegmentPref = 'all' | 'b2b' | 'b2c';

export interface Preferences {
  theme: ThemePref;
  density: DensityPref;
  segment: SegmentPref;
  sidebarCollapsed: boolean;
}

const KEY = 'fx.prefs';
const DEFAULTS: Preferences = { theme: 'system', density: 'comfortable', segment: 'all', sidebarCollapsed: false };

function read(): Preferences {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system',
      density: v.density === 'compact' ? 'compact' : 'comfortable',
      segment: v.segment === 'b2b' || v.segment === 'b2c' ? v.segment : 'all',
      sidebarCollapsed: v.sidebarCollapsed === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function apply(p: Preferences): void {
  const root = document.documentElement;
  if (p.theme === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = p.theme;
  root.dataset['density'] = p.density;
  setSegmentHeader(p.segment === 'all' ? null : p.segment);
}

/** Runs before first paint (inline in <head>) so the stored theme never flashes. Mirrors `apply`. */
export const PREFERENCES_BOOT_SCRIPT = `try{var p=JSON.parse(localStorage.getItem('${KEY}')||'{}');var r=document.documentElement;if(p.theme==='light'||p.theme==='dark')r.dataset.theme=p.theme;r.dataset.density=p.density==='compact'?'compact':'comfortable'}catch(e){}`;

interface PreferencesApi extends Preferences {
  set: (patch: Partial<Preferences>) => void;
  /** The theme actually shown (system resolved). */
  resolvedTheme: 'light' | 'dark';
}

const Ctx = createContext<PreferencesApi | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const initial = read();
    setPrefs(initial);
    apply(initial);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => {
      setSystemDark(e.matches);
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, []);

  const set = useCallback((patch: Partial<Preferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      apply(next);
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private mode: the preference lasts for this page only.
      }
      return next;
    });
  }, []);

  const value = useMemo<PreferencesApi>(
    () => ({ ...prefs, set, resolvedTheme: prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme }),
    [prefs, set, systemDark],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePreferences(): PreferencesApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePreferences must be used inside <PreferencesProvider>');
  return ctx;
}
