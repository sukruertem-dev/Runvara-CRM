import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@runvara/ui/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Runvara', template: '%s · Runvara' },
  description: 'Runvara',
  icons: { icon: '/runvara-mark.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
