import { cn } from '@flexa/ui';
import type { ReactNode } from 'react';

/** Content column inside the app frame (the frame itself is app/(app)/layout.tsx). */
export function PageContainer({ children, wide = false, className }: { children: ReactNode; wide?: boolean; className?: string }) {
  return <div className={cn('mx-auto w-full px-4 py-6 md:px-6', wide ? 'max-w-7xl' : 'max-w-4xl', className)}>{children}</div>;
}
