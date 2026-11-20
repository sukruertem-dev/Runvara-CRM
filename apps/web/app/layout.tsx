import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@flexa/ui/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Flexa', template: '%s · Flexa' },
  description: 'İşini Tek Platformda Yönet',
  icons: { icon: { url: '/flexa-symbol.svg', type: 'image/svg+xml' } },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
