import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://daybreak.run'),
  title: 'Daybreak',
  description: "A dynamic training calendar, to make sure you don't get injured.",
  icons: {
    icon: '/daybreak-icon.png',
    shortcut: '/daybreak-icon.png',
    apple: '/daybreak-icon.png',
  },
  openGraph: {
    title: 'Daybreak',
    description: "A dynamic training calendar, to make sure you don't get injured.",
    url: 'https://daybreak.run',
    siteName: 'Daybreak',
    images: [{ url: '/daybreak-icon.png' }],
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Daybreak',
    description: "A dynamic training calendar, to make sure you don't get injured.",
    images: ['/daybreak-icon.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
