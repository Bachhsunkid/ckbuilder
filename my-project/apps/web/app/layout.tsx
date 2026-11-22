import type { Metadata, Viewport } from 'next';
import { Courier_Prime, Familjen_Grotesk } from 'next/font/google';
import './globals.css';

const sans = Familjen_Grotesk({ subsets: ['latin'], variable: '--font-sans', weight: ['400', '500', '600', '700'] });
const mono = Courier_Prime({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '700'] });

const description = 'A 3×3 mines game on CKB testnet where the operator cannot rig the board or keep your winnings. Deposit once, play instant rounds, withdraw any time.';

export const metadata: Metadata = {
  // absolute URLs for the share preview; Vercel's own URL is used when this is unset
  metadataBase: process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL) : undefined,
  title: 'CKB Mines',
  description,
  openGraph: { title: 'CKB Mines', description, type: 'website' },
  twitter: { card: 'summary_large_image', title: 'CKB Mines', description },
};

export const viewport: Viewport = { themeColor: '#eceff3' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
