import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui';

export const metadata: Metadata = {
  title: 'PAVIDEZ DOCS — Portal de Documentos',
  description: 'Portal de Documentos — Pavidez Engenharia',
  robots: { index: false, follow: false },
  icons: { icon: '/logo-pavidez.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1F1F1F',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
