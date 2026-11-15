'use client';
import { ccc } from '@ckb-ccc/connector-react';
import { useEffect, useMemo, useState } from 'react';
import { ckb } from './lib';
import { Play } from './Play';
import { Session } from './Session';
import { Verify } from './Verify';

const client = new ccc.ClientPublicTestnet();

// Local self-testing only: a throwaway testnet key, never bundled outside `next dev`.
const DEV_KEY = process.env.NODE_ENV === 'development' ? process.env.NEXT_PUBLIC_DEV_PRIVATE_KEY : undefined;

type Tab = 'play' | 'single' | 'verify' | 'pool' | 'analytics' | 'leaderboard';
const TABS: { id: Tab; label: string; soon?: boolean }[] = [
  { id: 'play', label: 'Play' },
  { id: 'single', label: 'Single game' },
  { id: 'verify', label: 'Verify' },
  { id: 'pool', label: 'Pool', soon: true },
  { id: 'analytics', label: 'Analytics', soon: true },
  { id: 'leaderboard', label: 'Leaderboard', soon: true },
];

export default function MinesApp() {
  return (
    <ccc.Provider defaultClient={client} clientOptions={[{ name: 'CKB Testnet', client }]}>
      <Shell />
    </ccc.Provider>
  );
}

function useHashTab(): [Tab, (t: Tab) => void] {
  const read = () => {
    const h = window.location.hash.replace('#', '').split('/')[0] as Tab;
    return TABS.some((t) => t.id === h) ? h : 'play';
  };
  const [tab, setTab] = useState<Tab>(read);
  useEffect(() => {
    const on = () => setTab(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [tab, (t) => (window.location.hash = t)];
}

function Shell() {
  const { open, disconnect, wallet } = ccc.useCcc();
  const walletSigner = ccc.useSigner();
  const [useDev, setUseDev] = useState(false);
  const devSigner = useMemo(() => (DEV_KEY ? new ccc.SignerCkbPrivateKey(client, DEV_KEY) : undefined), []);
  const signer = useDev ? devSigner : walletSigner;
  const [tab, setTab] = useHashTab();
  const [address, setAddress] = useState<string>();
  const [balance, setBalance] = useState<bigint>();

  useEffect(() => {
    let live = true;
    setAddress(undefined);
    setBalance(undefined);
    if (!signer) return;
    const load = async () => {
      const [a, b] = await Promise.all([signer.getRecommendedAddress(), signer.getBalance()]);
      if (live) {
        setAddress(a);
        setBalance(b);
      }
    };
    void load();
    const t = setInterval(() => void load().catch(() => {}), 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [signer]);

  return (
    <div className="wrap">
      <header className="header">
        <div className="brand">
          <b>CKB Mines</b>
          <span className="badge mono">TESTNET</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className="tab" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
              {t.soon && <span className="soon">soon</span>}
            </button>
          ))}
        </nav>
        {signer ? (
          <button
            className="wallet mono"
            onClick={() => (useDev ? setUseDev(false) : disconnect())}
            title="Disconnect"
          >
            <span>{address ? `${address.slice(0, 9)}…${address.slice(-4)}` : '…'}</span>
            <span>{balance !== undefined ? `${ckb(balance)} CKB` : ''}</span>
            {useDev && <span>(dev key)</span>}
          </button>
        ) : (
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="wallet connect" onClick={open}>
              Connect wallet
            </button>
            {devSigner && (
              <button className="wallet" onClick={() => setUseDev(true)}>
                Use dev key
              </button>
            )}
          </span>
        )}
      </header>
      <main>
        {tab === 'play' && <Session signer={signer} balance={balance} onConnect={open} />}
        {tab === 'single' && <Play signer={signer} balance={balance} walletName={useDev ? 'dev key' : wallet?.name} onConnect={open} />}
        {tab === 'verify' && <Verify />}
        {(tab === 'pool' || tab === 'analytics' || tab === 'leaderboard') && <Soon what={TABS.find((t) => t.id === tab)!.label} />}
      </main>
    </div>
  );
}

const SOON: Record<string, string> = {
  Pool: 'Back the house with your own CKB and share in its results. Every bet is covered by collateral locked on chain.',
  Analytics: 'Live house edge, payouts paid, exits taken, and how often the operator answered on time.',
  Leaderboard: 'Biggest cash-outs and longest safe streaks, all read from the chain.',
};

function Soon({ what }: { what: string }) {
  return (
    <div style={{ maxWidth: 560 }}>
      <div className="paper-top" />
      <section className="paper">
        <h1 style={{ margin: 0, fontSize: 32 }}>{what}</h1>
        <p className="mono" style={{ margin: 0 }}>Not printed yet. Coming in phase 2.</p>
        <p className="note">{SOON[what]}</p>
      </section>
      <span className="zigzag" />
    </div>
  );
}
