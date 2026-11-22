import type { ReactNode } from 'react';
import { SettingsNav } from './_parts/settings-nav';

/** Settings area: secondary navigation beside (or above, on phones) the settings screens. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <SettingsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
