import type { Metadata } from 'next';
import { Courier_Prime, Familjen_Grotesk } from 'next/font/google';
import './globals.css';

const sans = Familjen_Grotesk({ subsets: ['latin'], variable: '--font-sans', weight: ['400', '500', '600', '700'] });
const mono = Courier_Prime({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '700'] });

export const metadata: Metadata = {
  title: 'CKB Mines',
  description: 'A 3×3 mines game on CKB testnet where the operator cannot rig the board or keep your winnings.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
