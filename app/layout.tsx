import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Suspense } from 'react';
import { Toaster } from '@/components/ui/sonner';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
  ),
  title: 'ByteForge — Binary file editor',
  description:
    'Inspect, search, and patch binary files in a fast, private hex editor. Files are processed in memory and expire automatically.',
  applicationName: 'ByteForge',
  openGraph: {
    title: 'ByteForge — Binary file editor',
    description: 'A fast, private workspace for inspecting and editing binary files.',
    siteName: 'ByteForge',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'ByteForge — Binary file editor',
    description: 'A fast, private workspace for inspecting and editing binary files.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Suspense fallback={<main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Opening ByteForge session…</main>}>
          {children}
        </Suspense>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
