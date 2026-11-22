'use client';
import { ccc } from '@ckb-ccc/connector-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Leaderboard, Stats } from './Board';
import { EXPLORER, FAUCET, ckb, copyText } from './lib';
import { Play } from './Play';
import { Session } from './Session';
import { Verify } from './Verify';

const client = new ccc.ClientPublicTestnet();

// Local self-testing only: a throwaway testnet key, never bundled outside `next dev`.
const DEV_KEY = process.env.NODE_ENV === 'development' ? process.env.NEXT_PUBLIC_DEV_PRIVATE_KEY : undefined;

type Tab = 'play' | 'single' | 'verify' | 'leaderboard' | 'stats';
// `single` (one on-chain bet per game) still works at #single, but is left out of the menu:
// sessions are the way to play, and single games tie up far more operator capacity.
const TABS: { id: Tab; label: string; hidden?: boolean }[] = [
  { id: 'play', label: 'Play' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'stats', label: 'Stats' },
  { id: 'verify', label: 'Verify' },
  { id: 'single', label: 'Single game', hidden: true },
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
          {TABS.filter((t) => !t.hidden || t.id === tab).map((t) => (
            <button key={t.id} className="tab" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {signer ? (
          <WalletMenu
            address={address}
            balance={balance}
            name={useDev ? 'dev key' : wallet?.name}
            onDisconnect={() => (useDev ? setUseDev(false) : disconnect())}
          />
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
        {tab === 'play' && <Session signer={signer} balance={balance} address={address} onConnect={open} />}
        {tab === 'single' && <Play signer={signer} balance={balance} walletName={useDev ? 'dev key' : wallet?.name} onConnect={open} />}
        {tab === 'verify' && <Verify />}
        {tab === 'leaderboard' && <Leaderboard />}
        {tab === 'stats' && <Stats />}
      </main>
      <footer className="foot note">
        CKB testnet only, tokens have no value.{' '}
        <a href="https://github.com/Bachhsunkid/ckbuilder/blob/main/my-project/docs/PLAY.md" target="_blank" rel="noreferrer">
          How to play
        </a>
        {' · '}Open source:{' '}
        <a href="https://github.com/Bachhsunkid/ckbuilder/tree/main/my-project" target="_blank" rel="noreferrer">
          code and protocol
        </a>
        .
      </footer>
    </div>
  );
}

function WalletMenu(p: { address?: string; balance?: bigint; name?: string; onDisconnect: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [copied, setCopied] = useState(false);
  // close on a click outside or Escape
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details className="wmenu" ref={ref}>
      <summary className="wallet mono" aria-label="Wallet menu">
        <span>{p.address ? `${p.address.slice(0, 9)}…${p.address.slice(-4)}` : '…'}</span>
        <span>{p.balance !== undefined ? `${ckb(p.balance)} CKB` : ''}</span>
        <span aria-hidden>▾</span>
      </summary>
      <div className="wmenu-pop">
        <span className="note mono" style={{ fontSize: 13 }}>
          {p.name ? `Connected with ${p.name}` : 'Connected'}
        </span>
        <span className="addr mono">{p.address}</span>
        {p.address && (
          <button
            className="btn ghost"
            onClick={() =>
              void copyText(p.address!).then((ok) => {
                setCopied(ok);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? 'Copied ✓' : 'Copy address'}
          </button>
        )}
        {p.address && (
          <a className="mono" href={`${EXPLORER}/address/${p.address}`} target="_blank" rel="noreferrer">
            View on explorer ↗
          </a>
        )}
        <a className="mono" href={FAUCET} target="_blank" rel="noreferrer">
          Get testnet CKB (faucet) ↗
        </a>
        <button className="btn ghost" onClick={p.onDisconnect}>
          Disconnect
        </button>
      </div>
    </details>
  );
}
