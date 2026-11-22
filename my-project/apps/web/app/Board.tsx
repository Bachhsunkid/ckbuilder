'use client';
import { useEffect, useState } from 'react';
import { API, DIFFICULTY, EXPLORER, ckb } from './lib';
import { Row } from './Play';

interface Summary {
  sessions: number;
  liveSessions: number;
  players: number;
  rounds: number;
  roundsWon: number;
  volume: string;
  paidInRounds: string;
  biggestWin: string;
  bestMultiplier100: number;
  withdrawnOnChain: string;
  byDifficulty: { m: number; rounds: number; won: number }[];
  houseBalance: string;
  houseLargestFree: string;
}

interface Player {
  address: string;
  rounds: number;
  wagered: string;
  net: string;
  biggestWin: string;
  bestMultiplier100: number;
}

function useApi<T>(path: string, refreshMs = 30_000): { data?: T; error?: string } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`${API}${path}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`server answered ${r.status}`))))
        .then(
          (d) => live && (setData(d), setError(undefined)),
          (e) => live && setError(String(e.message ?? e)),
        );
    void load();
    const t = setInterval(load, refreshMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [path, refreshMs]);
  return { data, error };
}

const x100 = (v: number) => `${(v / 100).toFixed(2)}×`;
const shortAddr = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

function Paper({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 880 }}>
      <div className="paper-top" />
      <section className="paper">
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>{title}</h1>
          {sub && <p className="note">{sub}</p>}
        </div>
        {children}
      </section>
      <span className="zigzag" />
    </div>
  );
}

export function Leaderboard() {
  const [period, setPeriod] = useState<'week' | 'all'>('week');
  const [sort, setSort] = useState<'net' | 'best'>('net');
  const { data, error } = useApi<{ players: Player[] }>(`/api/leaderboard?period=${period}`);
  const players = [...(data?.players ?? [])].sort((a, b) => (sort === 'net' ? Number(BigInt(b.net) - BigInt(a.net)) : b.bestMultiplier100 - a.bestMultiplier100));

  return (
    <Paper title="Leaderboard" sub="Settled session rounds, per wallet. Testnet CKB, no value: bragging rights only.">
      <div className="seg-row">
        <div className="seg" role="group" aria-label="Period">
          {(['week', 'all'] as const).map((p) => (
            <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {p === 'week' ? 'Last 7 days' : 'All time'}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Rank by">
          {(['net', 'best'] as const).map((s) => (
            <button key={s} aria-pressed={sort === s} onClick={() => setSort(s)}>
              {s === 'net' ? 'Profit' : 'Best multiplier'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="err">Cannot load the leaderboard: {error}</p>}
      {!data && !error && <p className="note">Loading…</p>}
      {data && players.length === 0 && <p className="note">No settled rounds yet in this period. Be the first on the board.</p>}
      {players.length > 0 && (
        <div className="table-wrap">
          <table className="table mono">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Wallet</th>
                <th scope="col" className="num">
                  Profit
                </th>
                <th scope="col" className="num">
                  Best
                </th>
                <th scope="col" className="num hide-sm">
                  Biggest win
                </th>
                <th scope="col" className="num hide-sm">
                  Rounds
                </th>
              </tr>
            </thead>
            <tbody>
              {players.slice(0, 25).map((p, i) => {
                const net = BigInt(p.net);
                return (
                  <tr key={p.address}>
                    <td>{i + 1}</td>
                    <td>
                      <a href={`${EXPLORER}/address/${p.address}`} target="_blank" rel="noreferrer">
                        {shortAddr(p.address)}
                      </a>
                    </td>
                    <td className="num" style={{ color: net < 0n ? 'var(--stamp)' : undefined }}>
                      {net > 0n ? '+' : ''}
                      {ckb(net)}
                    </td>
                    <td className="num">{p.bestMultiplier100 ? x100(p.bestMultiplier100) : '—'}</td>
                    <td className="num hide-sm">{ckb(p.biggestWin)}</td>
                    <td className="num hide-sm">{p.rounds}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Paper>
  );
}

export function Stats() {
  const { data, error } = useApi<Summary>('/api/stats');
  if (error) return <p className="err">Cannot load stats: {error}</p>;
  if (!data) return <p className="note">Loading…</p>;
  const volume = BigInt(data.volume);
  const paid = BigInt(data.paidInRounds);
  const result = volume - paid;
  const edge = volume > 0n ? Number((result * 10000n) / volume) / 100 : 0;
  const tiles: [string, string, string?][] = [
    ['Players', String(data.players)],
    ['Sessions', String(data.sessions), `${data.liveSessions} live now`],
    ['Rounds', data.rounds.toLocaleString('en-US'), `${data.roundsWon} banked`],
    ['Wagered', `${ckb(volume, 0)} CKB`],
    ['Biggest win', `${ckb(data.biggestWin)} CKB`],
    ['Best multiplier', data.bestMultiplier100 ? x100(data.bestMultiplier100) : '—'],
  ];
  return (
    <Paper title="Stats" sub="Live numbers from the operator, refreshed every 30 s. Deposits and payouts are on chain; rounds are signed off-chain.">
      <div className="stat-grid">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="stat">
            <span className="mono stat-k">{k}</span>
            <b className="stat-v">{v}</b>
            {sub && <span className="note">{sub}</span>}
          </div>
        ))}
      </div>
      <dl className="kv mono dash">
        <Row k="Paid back in rounds" v={`${ckb(paid)} CKB`} />
        <Row k="Operator result" v={`${result >= 0n ? '+' : ''}${ckb(result)} CKB (${edge.toFixed(2)}% of wagered)`} />
        <Row k="Withdrawn on chain" v={`${ckb(data.withdrawnOnChain)} CKB`} />
        <Row k="Operator capacity" v={`${ckb(data.houseBalance, 0)} CKB`} />
      </dl>
      <div className="dash">
        <p className="mono" style={{ margin: '0 0 10px', fontSize: 14 }}>
          ROUNDS BY DIFFICULTY
        </p>
        {data.byDifficulty.map((d) => {
          const pct = data.rounds ? (d.rounds / data.rounds) * 100 : 0;
          return (
            <div key={d.m} className="bar-row">
              <span className="mono" style={{ minWidth: 72 }}>
                {DIFFICULTY[d.m]}
              </span>
              <span className="bar" aria-hidden>
                <span style={{ width: `${pct}%` }} />
              </span>
              <span className="mono note" style={{ minWidth: 150, textAlign: 'right' }}>
                {d.rounds} rounds · {d.rounds ? Math.round((d.won / d.rounds) * 100) : 0}% won
              </span>
            </div>
          );
        })}
        <p className="note" style={{ marginTop: 10 }}>
          The game is fair before the 5% fee on profit: expected operator result is about 1–5% of wagered, depending on how deep players go.
        </p>
      </div>
    </Paper>
  );
}
