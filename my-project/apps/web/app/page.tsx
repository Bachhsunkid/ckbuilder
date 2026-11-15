'use client';
import dynamic from 'next/dynamic';

// The wallet connector registers web components, so the app only renders in the browser.
const MinesApp = dynamic(() => import('./MinesApp'), { ssr: false, loading: () => <p className="wrap">Loading…</p> });

export default function Page() {
  return <MinesApp />;
}
