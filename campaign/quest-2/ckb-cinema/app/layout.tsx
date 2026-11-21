import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Self-hosted at build time: the page is cross-origin isolated (COEP), so fonts must be same-origin.
const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

export const metadata = {
  title: 'CKB Cinema · pay per title over Fiber',
  description: 'Watch the trailer free, pay only for the film you want with a Fiber payment on CKB Testnet.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}><body>{children}</body></html>;
}
