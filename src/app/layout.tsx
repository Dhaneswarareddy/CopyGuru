import type { Metadata, Viewport } from 'next';
import { THEME_INIT_SCRIPT } from '@/components/ui/ThemeToggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Visual Q&A Sessions',
  description: 'Post a picture and an answer. See, live, where the group agrees — and challenge what it does not.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5fd' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0a1c' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // the theme script sets a class on <html> before React hydrates
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
