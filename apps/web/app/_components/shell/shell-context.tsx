'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface ShellApi {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  newTaskOpen: boolean;
  setNewTaskOpen: (open: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
}

const Ctx = createContext<ShellApi | null>(null);

/** Shell-level overlays (palette, new task, shortcut help, mobile navigation) that any page can open. */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const value = useMemo(
    () => ({ paletteOpen, setPaletteOpen, newTaskOpen, setNewTaskOpen, helpOpen, setHelpOpen, mobileNavOpen, setMobileNavOpen }),
    [paletteOpen, newTaskOpen, helpOpen, mobileNavOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useShell must be used inside <ShellProvider>');
  return ctx;
}
