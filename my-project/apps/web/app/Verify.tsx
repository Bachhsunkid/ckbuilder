'use client';
import { ccc } from '@ckb-ccc/connector-react';
import { H, OPERATOR_FEE, argsFromJson, bytes, decodeBetLock, receiptFromJson } from '@ckb-mines/chain';
import * as P from '@ckb-mines/protocol';
import { useEffect, useState } from 'react';
import { ACTIVE, API, DIFFICULTY, EXPLORER, ckb, loadGames, short, type SavedGame } from './lib';

interface Result {
  checks: P.Check[];
  layout: boolean[];
  args: P.BetArgs;
  S: string;
  paid: bigint;
}

function idFromHash() {
  return window.location.hash.split('/')[1] ?? '';
}

/** Net CKB that moved to the player's lock in a settlement, read from the chain. */
async function playerFlow(client: ccc.Client, txHash: string, playerLockHash: string): Promise<bigint> {
  const r = await client.getTransaction(txHash);
  if (!r || r.status !== 'committed') throw new Error(`settlement ${short(txHash)} is not committed yet`);
  const tx = r.transaction;
  let flow = 0n;
  for (const o of tx.outputs) if (o.lock.hash() === playerLockHash) flow += o.capacity;
  for (const i of tx.inputs) {
    await i.completeExtraInfos(client);
    if (i.cellOutput!.lock.hash() === playerLockHash) flow -= i.cellOutput!.capacity;
  }
  return flow;
}

export function Verify() {
  const { client } = ccc.useCcc();
  const [games, setGames] = useState<SavedGame[]>([]);
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Result>();

  useEffect(() => {
    setGames(loadGames().filter((g) => !ACTIVE.has(g.state.status) && g.state.status !== 'failed'));
    const h = idFromHash();
    if (h) setId(h);
  }, []);

  useEffect(() => {
    if (id) void run(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function run(betId: string) {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const saved = loadGames().find((g) => g.state.betId === betId);
      if (!saved) throw new Error('This browser does not hold the pick secrets for that game. Open Verify on the device you played on.');
      const st = saved.state;

      // 1. the bet terms come from the bet cell on chain, not from the server or this browser
      const betTx = await client.getTransaction(st.betTx!);
      if (!betTx) throw new Error('bet transaction not found on chain');
      const onChain = decodeBetLock(betTx.transaction.outputs[0].lock);
      if (!onChain) throw new Error('output 0 of the bet transaction is not a Mines bet cell');
      const local = argsFromJson(st.args);
      if (P.toHex(P.encodeArgs(onChain)) !== P.toHex(P.encodeArgs(local))) throw new Error('bet cell on chain differs from what this browser signed');

      // 2. the seed S is published once the game is over
      let S = st.S;
      let settleTx = st.settleTx;
      if (!S || !settleTx) {
        const v = await (await fetch(`${API}/api/bets/${betId}`)).json();
        S = S ?? v.S ?? undefined;
        settleTx = settleTx ?? v.settleTx ?? undefined;
      }
      if (!S) throw new Error('the operator has not published the seed S yet');
      if (!settleTx) throw new Error('no settlement transaction yet');

      // 3. what was actually paid, from the settlement on chain (an exit pays its own fee)
      const flow = await playerFlow(client, settleTx, ccc.hexFrom(onChain.playerLockHash));
      const outcome = st.status === 'lost' ? 'lost' : st.status === 'won' ? 'won' : 'exit';
      const paid = outcome === 'exit' ? flow + OPERATOR_FEE : flow;

      const record: P.GameRecord = {
        args: onChain,
        S: bytes(S),
        picks: st.opened.map((o) => o.t),
        pickSecrets: st.picks.map(bytes),
        receipts: st.receipts.map(receiptFromJson),
        outcome,
        hit: st.hit,
        paid,
      };
      const checks = P.verifyGame(record, H);
      const states = P.buildLayout(bytes(S), onChain.m, H).states;
      const pi = P.tileMap(onChain.C, H);
      setResult({ checks, layout: Array.from({ length: 9 }, (_, t) => states[pi[t]] === 1), args: onChain, S, paid });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const passed = result?.checks.every((c) => c.ok);
  const saved = games.find((g) => g.state.betId === id);

  return (
    <div className="row">
      <section className="board-col">
        <h1 style={{ margin: 0, fontSize: 40, lineHeight: 1.1 }}>Verify a game</h1>
        <p className="note" style={{ fontSize: 17 }}>
          Rebuilds the layout from the seed, checks it against the root locked on chain before you played, and replays every receipt and the payout.
        </p>
        {games.length === 0 ? (
          <p className="note">No finished games in this browser yet.</p>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 460 }}>
            <span className="mono" style={{ fontSize: 14 }}>
              YOUR GAMES
            </span>
            <select
              value={id}
              onChange={(e) => {
                window.location.hash = `verify/${e.target.value}`;
                setId(e.target.value);
              }}
              style={{ minHeight: 48, fontSize: 16, padding: '0 8px', border: '2px solid var(--ink)', background: 'var(--paper)', fontFamily: 'inherit' }}
            >
              <option value="">Choose a game…</option>
              {games.map((g) => (
                <option key={g.state.betId} value={g.state.betId}>
                  {g.state.betId.slice(0, 8)} · {DIFFICULTY[g.state.m]} · {ckb(g.state.stake)} CKB · {g.state.status}
                </option>
              ))}
            </select>
          </label>
        )}
        {busy && <p className="status">Reading the chain…</p>}
        {error && <p className="err">{error}</p>}
        {result && (
          <>
            <div className="grid" aria-label="Revealed layout">
              {result.layout.map((mine, t) => {
                const o = saved?.state.opened.find((x) => x.t === t);
                const cls = o ? (o.safe ? 'safe' : 'mine') : mine ? 'ghost-mine' : 'ghost-safe';
                return (
                  <div key={t} className={`tile ${cls}`} aria-label={`Tile ${t + 1}: ${mine ? 'mine' : 'safe'}${o ? ', opened' : ''}`}>
                    <span className="num mono">{t + 1}</span>
                    <span className="cap mono">{mine ? 'mine' : o ? 'safe' : ''}</span>
                  </div>
                );
              })}
            </div>
            <p className="note">Filled tiles were opened. Dashed tiles show the rest of the committed layout.</p>
          </>
        )}
      </section>
      <aside className="receipt-col">
        <div className="paper-top" />
        <div className="paper">
          {result && (
            <span className="stamp mono" style={{ color: passed ? 'var(--blue)' : 'var(--stamp)', borderColor: passed ? 'var(--blue)' : 'var(--stamp)' }}>
              {passed ? 'FAIR' : 'FAILED'}
            </span>
          )}
          <b className="mono" style={{ fontSize: 14 }}>
            VERIFICATION
          </b>
          {result ? (
            <>
              <dl className="kv mono" style={{ fontSize: 13 }}>
                {[
                  ['Bet', id.slice(0, 8)],
                  ['Difficulty', `${DIFFICULTY[result.args.m]} (${result.args.m} mines)`],
                  ['Stake', `${ckb(result.args.stake)} CKB`],
                  ['Paid to you', `${ckb(result.paid, 8)} CKB`],
                  ['Root R', short(P.toHex(result.args.R))],
                  ['Your seed C', short(P.toHex(result.args.C))],
                  ['Picks Q', short(P.toHex(result.args.Q))],
                  ['Seed S', short(result.S)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <span className="lead" />
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <ol className="checks">
                {result.checks.map((c) => (
                  <li key={c.name} className={c.ok ? 'ok' : 'bad'}>
                    <span className="st mono">{c.ok ? 'PASS' : 'FAIL'}</span>
                    <span>
                      <b>{c.name}</b>
                      <br />
                      <span className="note">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {saved?.state.betTx && (
                <a href={`${EXPLORER}/transaction/${saved.state.betTx}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 14 }}>
                  Bet cell on the explorer
                </a>
              )}
            </>
          ) : (
            <p className="note">Pick a finished game to run the five checks.</p>
          )}
        </div>
        <span className="zigzag" />
      </aside>
    </div>
  );
}
