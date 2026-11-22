'use client';
import { ccc } from '@ckb-ccc/connector-react';
import { H, bytes } from '@ckb-mines/chain';
import { decodeSessionLock, sessionArgsToJson } from '@ckb-mines/chain/session';
import type { RoundRecord, SessionRecord } from '@ckb-mines/chain/session-player';
import * as P from '@ckb-mines/protocol';
import { useEffect, useMemo, useState } from 'react';
import { DIFFICULTY, EXPLORER, ckb, loadSessions, short } from './lib';
import { roundChecks } from './Session';

interface Pick {
  rec: SessionRecord;
  r: RoundRecord;
  i: number;
}

/**
 * Re-checks a finished session round from what this browser holds: the signed state that opened it
 * (which binds R, C, Q, m and the stake), the seed S the operator revealed, the receipts and the payout.
 * The session terms themselves are read from the deposit transaction on chain.
 */
export function SessionVerify() {
  const { client } = ccc.useCcc();
  const all = useMemo(() => {
    const out: Pick[] = [];
    for (const rec of loadSessions()) rec.rounds.forEach((r, i) => (r.status === 'won' || r.status === 'lost') && out.push({ rec, r, i }));
    return out;
  }, []);
  const [key, setKey] = useState(all[0] ? `${all[0].rec.id}/${all[0].r.id}` : '');
  const pick = all.find((x) => `${x.rec.id}/${x.r.id}` === key);
  const [onChain, setOnChain] = useState<{ ok: boolean; detail: string }>();

  useEffect(() => {
    setOnChain(undefined);
    if (!pick?.rec.depositTx) return;
    let live = true;
    void (async () => {
      try {
        const t = await client.getTransaction(pick.rec.depositTx!);
        const args = t ? decodeSessionLock(t.transaction.outputs[0].lock) : null;
        const same = !!args && JSON.stringify(sessionArgsToJson(args)) === JSON.stringify(pick.rec.args);
        if (live) setOnChain({ ok: same, detail: same ? 'Session cell on chain locks the same keys and window' : 'Session cell on chain differs from what this browser signed' });
      } catch (e) {
        if (live) setOnChain({ ok: false, detail: `Could not read the deposit: ${String(e).slice(0, 120)}` });
      }
    })();
    return () => {
      live = false;
    };
  }, [client, pick?.rec.id, pick?.rec.depositTx]);

  if (all.length === 0) return <p className="note">No finished session rounds in this browser yet. Play a round on the Play tab, then come back.</p>;

  const checks = pick ? roundChecks(pick.rec, pick.r) : null;
  const layout =
    pick?.r.S && pick.r.C
      ? (() => {
          const states = P.buildLayout(bytes(pick.r.S!), pick.r.m, H).states;
          const pi = P.tileMap(bytes(pick.r.C!), H);
          return Array.from({ length: 9 }, (_, t) => states[pi[t]] === 1);
        })()
      : null;
  const passed = checks?.every((c) => c.ok) && onChain?.ok !== false;

  return (
    <>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 460 }}>
        <span className="mono" style={{ fontSize: 14 }}>
          YOUR SESSION ROUNDS
        </span>
        <select
          value={key}
          onChange={(e) => setKey(e.target.value)}
          style={{ minHeight: 48, fontSize: 16, padding: '0 8px', border: '2px solid var(--ink)', background: 'var(--paper)', fontFamily: 'inherit' }}
        >
          {all.map((x) => (
            <option key={`${x.rec.id}/${x.r.id}`} value={`${x.rec.id}/${x.r.id}`}>
              No. {x.rec.id.slice(0, 8)} · round {x.i + 1} · {DIFFICULTY[x.r.m]} {ckb(x.r.stake)} CKB → {x.r.status === 'lost' ? 'mine' : `${ckb(x.r.paid ?? '0')} CKB`}
            </option>
          ))}
        </select>
      </label>
      {pick && layout && (
        <>
          <div className="grid" aria-label="Revealed layout">
            {layout.map((mine, t) => {
              const o = pick.r.opened.find((x) => x.t === t);
              const cls = o ? (o.safe ? 'safe' : 'mine') : mine ? 'ghost-mine' : 'ghost-safe';
              return (
                <div key={t} className={`tile ${cls}`} aria-label={`Tile ${t + 1}: ${mine ? 'mine' : 'safe'}${o ? ', opened' : ''}`}>
                  <span className="num mono">{t + 1}</span>
                  <span className="cap mono">{mine ? 'mine' : o ? 'safe' : ''}</span>
                </div>
              );
            })}
          </div>
          <p className="note">Filled tiles were opened. Dashed tiles show the rest of the layout the operator sealed before your seed existed.</p>
        </>
      )}
      {pick && (
        <section aria-label="Checks">
          <p className="hero-l1" style={{ marginBottom: 10 }}>
            {checks === null ? 'Not enough data in this browser to check this round.' : passed ? 'FAIR: every check passed' : 'A check failed'}
          </p>
          <ul className="checks">
            {onChain && (
              <li className={onChain.ok ? 'ok' : 'bad'}>
                <span className="st mono">{onChain.ok ? 'PASS' : 'FAIL'}</span>
                <span>
                  {onChain.detail}
                  {pick.rec.depositTx && (
                    <>
                      {' · '}
                      <a href={`${EXPLORER}/transaction/${pick.rec.depositTx}`} target="_blank" rel="noreferrer" className="mono">
                        {short(pick.rec.depositTx)}
                      </a>
                    </>
                  )}
                </span>
              </li>
            )}
            {checks?.map((c) => (
              <li key={c.name} className={c.ok ? 'ok' : 'bad'}>
                <span className="st mono">{c.ok ? 'PASS' : 'FAIL'}</span>
                <span>
                  <b>{c.name}</b>
                  {c.detail ? <span className="note"> · {c.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
