'use client';
import { ccc } from '@ckb-ccc/connector-react';
import { H, bytes, lockHash, receiptFromJson } from '@ckb-mines/chain';
import { PS, maxStakeFor, mustDecodeState, sessionArgsFromJson } from '@ckb-mines/chain/session';
import { SessionPlayer, type DefendResult, type RoundRecord, type SessionRecord } from '@ckb-mines/chain/session-player';
import * as P from '@ckb-mines/protocol';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { API, CKB, DIFFICULTY, EXPLORER, FAUCET, ckb, getSessionConfig, loadSessions, mult, saveSession, sessionBackupUrl, short, type SessionConfig } from './lib';
import { Hero, Ladder, Row, countdown, useNow, type Phase } from './Play';

const LIVE = new Set(['opening', 'open', 'withdrawing', 'closing']);

/** The five Verify checks, run in the browser on what this round's signed state committed to. */
function roundChecks(rec: SessionRecord, r: RoundRecord): P.Check[] | null {
  if (!r.opening || !r.S || !r.picks || r.paid === undefined) return null;
  const game = mustDecodeState(r.opening.state).game;
  if (!game) return null;
  return P.verifyGame(
    {
      args: PS.roundArgs(sessionArgsFromJson(rec.args), game),
      S: bytes(r.S),
      picks: r.opened.map((o) => o.t),
      pickSecrets: r.picks.map(bytes),
      receipts: r.receipts.map(receiptFromJson),
      outcome: r.status === 'lost' ? 'lost' : 'won',
      hit: r.hit,
      paid: BigInt(r.paid),
    },
    H,
  );
}

function humanWindow(s: number): string {
  return s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`;
}

export function Session(props: { signer?: ccc.Signer; balance?: bigint; onConnect: () => unknown }) {
  const { signer, balance } = props;
  const [cfg, setCfg] = useState<SessionConfig>();
  const [cfgErr, setCfgErr] = useState<string>();
  const [rec, setRec] = useState<SessionRecord | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [depositCkb, setDepositCkb] = useState(150);
  const [maxBetCkb, setMaxBetCkb] = useState(10);
  const [m, setM] = useState(2);
  const [stakeCkb, setStakeCkb] = useState(10);
  const [allIn, setAllIn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [defend, setDefend] = useState<DefendResult>();
  const [serverDown, setServerDown] = useState(false);
  const now = useNow();
  const recRef = useRef(rec);
  recRef.current = rec;

  useEffect(() => {
    getSessionConfig().then(setCfg, (e) => setCfgErr(String(e)));
  }, []);

  // the SDK updates the record in place and calls this before anything irreversible
  const save = useCallback((r: SessionRecord) => {
    saveSession(r);
    bump();
  }, []);
  const player = useMemo(() => (signer ? new SessionPlayer(API, signer, save) : undefined), [signer, save]);

  // resume this wallet's session: the key and states are only in this browser
  useEffect(() => {
    setRec(null);
    if (!signer) return;
    let live = true;
    void (async () => {
      const mine = ccc.hexFrom(lockHash((await signer.getRecommendedAddressObj()).script));
      const saved = loadSessions().find((s) => LIVE.has(s.status) && s.args.playerLockHash === mine);
      if (live && saved) setRec(saved);
    })();
    return () => {
      live = false;
    };
  }, [signer]);

  // a reload during the deposit: wait for it here
  useEffect(() => {
    if (!player || !rec || rec.status !== 'opening' || busy) return;
    player.waitOpen(rec).catch((e) => setError(String(e)));
  }, [player, rec?.id, rec?.status, busy]);

  // watch the chain for us: answer a stale close, post receipts, collect after the window
  useEffect(() => {
    if (!player || !rec || !['open', 'withdrawing', 'closing'].includes(rec.status)) return;
    let live = true;
    const run = async () => {
      const r = recRef.current;
      if (!r) return;
      try {
        const d = await player.defend(r);
        if (live) setDefend(d);
      } catch (e) {
        if (live) setError(String(e));
      }
    };
    void run();
    const t = setInterval(run, rec.status === 'open' ? 30_000 : 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [player, rec?.id, rec?.status]);

  // notice when the operator stops answering
  useEffect(() => {
    if (!player || !rec || rec.status !== 'open') return;
    let live = true;
    const poll = () =>
      player.status(rec.id).then(
        () => live && setServerDown(false),
        () => live && setServerDown(true),
      );
    void poll();
    const t = setInterval(poll, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [player, rec?.id, rec?.status]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setError(undefined);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(null);
      bump();
    }
  }

  // ---------- derived ----------
  const state = rec ? SessionPlayer.state(rec) : null;
  const round = rec?.round;
  const live = round?.status === 'live';
  const ended = round && (round.status === 'won' || round.status === 'lost');
  const k = round?.receipts.length ?? 0;
  const curM = round && round.status !== 'sealed' ? round.m : m;
  const roundStake = round && round.status !== 'sealed' ? BigInt(round.stake) : 0n;
  const cashNow = live ? P.payout(roundStake, k, round!.m).payout : 0n;

  const minStake = cfg ? Number(BigInt(cfg.minStake) / CKB) : 10;
  const cap = state ? maxStakeFor(state, curM) : 0n;
  const p = state?.p ?? 0n;
  const sliderMax = state ? Number(((cap < p - P.MIN_CELL ? cap : p - P.MIN_CELL) > 0n ? (cap < p - P.MIN_CELL ? cap : p - P.MIN_CELL) : 0n) / CKB) : 0;
  const canAllIn = state !== null && p <= cap && p >= BigInt(minStake) * CKB;
  const stake = allIn && canAllIn ? p : BigInt(Math.min(stakeCkb, Math.max(sliderMax, minStake))) * CKB;
  const stakeOk = state !== null && stake >= BigInt(minStake) * CKB && stake <= cap && (stake === p || p - stake >= P.MIN_CELL);
  useEffect(() => {
    setStakeCkb((s) => Math.min(Math.max(s, minStake), Math.max(sliderMax, minStake)));
  }, [minStake, sliderMax]);

  const minDeposit = cfg ? Number(BigInt(cfg.minDeposit) / CKB) : 100;
  const maxDeposit = cfg ? Number(BigInt(cfg.maxDeposit) / CKB) : 2000;
  const maxBetLimit = cfg ? Number(BigInt(cfg.maxBet) / CKB) : 20;
  const deposit = BigInt(depositCkb) * CKB;
  const houseDeposit = (P.binom(9, 4) - 1n) * BigInt(maxBetCkb) * CKB;
  const need = deposit + P.MIN_CELL + CKB;
  const enough = balance !== undefined && balance >= need;
  const dChallenge = rec ? Number(rec.args.dChallenge) : cfg ? Number(cfg.dChallenge) : 0;

  const phase: Phase = !rec || rec.status === 'opening' ? (busy ? 'starting' : 'setup') : live ? 'playing' : ended ? 'done' : 'setup';
  const canPick = live && !busy && !serverDown && rec?.status === 'open';

  const ghost = useMemo(() => {
    if (!ended || !round?.S || !round.C) return undefined;
    const states = P.buildLayout(bytes(round.S), round.m, H).states;
    const pi = P.tileMap(bytes(round.C), H);
    return Array.from({ length: 9 }, (_, t) => states[pi[t]] === 1);
  }, [ended, round?.S, round?.C, round?.m]);

  const checks = useMemo(() => (rec && round && ended ? roundChecks(rec, round) : null), [rec, round, ended, round?.paid]);

  if (cfgErr) {
    return (
      <p className="err">
        Cannot reach the game server at {API}. {cfgErr}
        {rec && ' Your session is saved in this browser: reload when the server is back, or close it alone from here.'}
      </p>
    );
  }

  const status =
    busy ??
    (!rec
      ? 'Deposit once, then play as many rounds as you like. No wallet popup per round.'
      : rec.status === 'opening'
        ? 'Waiting for your deposit to land in a block…'
        : rec.status === 'withdrawing'
          ? 'Paying out both sides in one transaction…'
          : rec.status === 'closing'
            ? 'Closing on chain. This page collects for you when the window ends.'
            : rec.status === 'closed'
              ? 'Session closed and paid out.'
              : serverDown
                ? 'The operator is not answering. Your signed states let you close alone.'
                : live
                  ? k === 0
                    ? 'Pick a tile.'
                    : `Pick a tile or bank ${ckb(cashNow)} CKB.`
                  : ended
                    ? round!.status === 'lost'
                      ? 'Mine. The full layout is shown; the checks below ran in your browser.'
                      : `Banked ${ckb(round!.paid!)} CKB into your balance. Instantly, off-chain.`
                    : 'Choose a difficulty and a stake. The round starts instantly.');

  const closing = defend?.phase === 'challenge' ? defend : undefined;

  return (
    <div className="row">
      <section className="board-col" aria-label="Board">
        <Hero
          phase={phase}
          k={k}
          m={curM}
          left={9 - k}
          stake={live || ended ? roundStake : stake}
          cashNow={cashNow}
          status={ended ? round!.status : undefined}
          paid={round?.status === 'won' ? round.paid : undefined}
        />
        <p className="status" role="status" aria-live="polite">
          {status}
        </p>
        <div className="grid">
          {Array.from({ length: 9 }, (_, t) => {
            const o = (live || ended) && round ? round.opened.find((x) => x.t === t) : undefined;
            let cls = 'idle';
            let cap = '';
            if (o?.safe) {
              cls = 'safe';
              cap = 'safe';
            } else if (o && !o.safe) {
              cls = 'mine';
              cap = 'mine';
            } else if (pending === t) {
              cls = 'pending';
              cap = 'opening';
            } else if (ended && ghost) {
              cls = ghost[t] ? 'ghost-mine' : 'ghost-safe';
              cap = ghost[t] ? 'mine' : '';
            } else if (canPick) cls = 'hidden live';
            const clickable = !!canPick && !o && pending === null;
            return (
              <button
                key={t}
                className={`tile ${cls}`}
                disabled={!clickable}
                onClick={() =>
                  clickable &&
                  (setPending(t),
                  act(`Opening tile ${t + 1}…`, () => player!.reveal(rec!, t)).finally(() => setPending(null)))
                }
                aria-label={`Tile ${t + 1}${cap ? `, ${cap}` : ''}`}
              >
                <span className="num mono">{t + 1}</span>
                <span className="cap mono">{cap}</span>
              </button>
            );
          })}
        </div>
        <Ladder k={k} m={curM} />
      </section>

      <aside className="receipt-col" aria-label="Session">
        <div className="paper-top" />
        <div className="paper">
          {rec?.status === 'closed' && (
            <span className="stamp mono" style={{ color: 'var(--blue)', borderColor: 'var(--blue)' }}>
              PAID
            </span>
          )}
          <div className="mono" style={{ fontSize: 14 }}>
            <b>CKB MINES · SESSION</b>
            <br />
            {rec ? `No. ${rec.id.slice(0, 8)} · state ${state!.n}` : 'Not opened yet'}
          </div>

          {!rec ? (
            <>
              <label className="dash" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="mono" style={{ fontSize: 14 }}>
                  DEPOSIT <b style={{ fontSize: 20 }}>{depositCkb} CKB</b>
                </span>
                <input type="range" min={minDeposit} max={Math.min(maxDeposit, 1000)} step={10} value={depositCkb} disabled={!!busy} onChange={(e) => setDepositCkb(Number(e.target.value))} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="mono" style={{ fontSize: 14 }}>
                  MAX BET <b style={{ fontSize: 20 }}>{maxBetCkb} CKB</b>
                </span>
                <input type="range" min={minStake} max={maxBetLimit} step={1} value={maxBetCkb} disabled={!!busy} onChange={(e) => setMaxBetCkb(Number(e.target.value))} />
                <span className="note">The operator locks enough to pay your best case at this bet, even on Hard.</span>
              </label>
              <dl className="kv mono">
                <Row k="You deposit" v={`${ckb(deposit)} CKB`} />
                <Row k="Operator deposits" v={`${ckb(houseDeposit)} CKB`} />
                <Row k="Wallet signatures" v="1 (deposit only)" />
                <Row k="Fee" v="5% of profit" />
                <Row k="Close alone, window" v={cfg ? humanWindow(Number(cfg.dChallenge)) : '…'} />
              </dl>
              {!signer ? (
                <button className="btn" onClick={() => props.onConnect()}>
                  Connect wallet to play
                </button>
              ) : (
                <>
                  {balance !== undefined && !enough && (
                    <p className="err">
                      You need at least {ckb(need)} CKB (deposit + 61 CKB change + fee). Get testnet CKB from the{' '}
                      <a href={FAUCET} target="_blank" rel="noreferrer">
                        faucet
                      </a>
                      .
                    </p>
                  )}
                  <button
                    className="btn"
                    disabled={!enough || !!busy || !player}
                    onClick={() =>
                      act('Checking the session terms…', async () => {
                        const r = await player!.open(deposit, BigInt(maxBetCkb) * CKB, (s) => {
                          if (s === 'session terms checked') setBusy('Sign the deposit in your wallet…');
                          if (s === 'deposit sent') setBusy('Waiting for the block…');
                        });
                        setRec(r);
                      })
                    }
                  >
                    {busy ? 'Opening…' : `Open session · ${depositCkb} CKB`}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <dl className="kv mono">
                <Row k="Your balance" v={`${ckb(state!.p)} CKB`} />
                <Row k="Operator balance" v={`${ckb(state!.h)} CKB`} />
                {state!.game && <Row k="In this round" v={`${ckb(PS.sessionEscrow(state!.game))} CKB`} />}
                <Row k="Rounds played" v={String(rec.rounds.length)} />
              </dl>

              {rec.status === 'open' && !live && !ended && (
                <>
                  <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }} disabled={!!busy}>
                    <legend className="mono" style={{ fontSize: 14, marginBottom: 8 }}>
                      DIFFICULTY
                    </legend>
                    {[2, 3, 4].map((x) => {
                      const fits = maxStakeFor(state!, x) >= BigInt(minStake) * CKB;
                      return (
                        <button key={x} className="diff" aria-pressed={m === x} disabled={!fits} onClick={() => setM(x)}>
                          <b style={{ minWidth: 72 }}>{DIFFICULTY[x]}</b>
                          <span className="mono" style={{ fontSize: 14 }}>
                            {fits ? `up to ${(maxStakeFor(state!, x) / CKB).toString()} CKB · first tile ${mult(1, x)}` : 'operator deposit too low'}
                          </span>
                        </button>
                      );
                    })}
                  </fieldset>
                  <label className="dash" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 14 }}>
                      STAKE <b style={{ fontSize: 20 }}>{ckb(stake)} CKB</b>
                    </span>
                    <input
                      type="range"
                      min={minStake}
                      max={Math.max(sliderMax, minStake)}
                      step={1}
                      value={stakeCkb}
                      disabled={!!busy || sliderMax < minStake}
                      onChange={(e) => {
                        setAllIn(false);
                        setStakeCkb(Number(e.target.value));
                      }}
                    />
                    {canAllIn && (
                      <button className="btn ghost" aria-pressed={allIn} onClick={() => setAllIn(!allIn)}>
                        {allIn ? 'All in ✓' : `All in · ${ckb(p)} CKB`}
                      </button>
                    )}
                    <span className="note">A round leaves either nothing or at least 61 CKB in your balance, so every balance stays payable.</span>
                  </label>
                  <button className="btn" disabled={!stakeOk || !!busy || serverDown} onClick={() => act('Sealing the layout…', () => player!.startRound(rec, curM, stake))}>
                    Start round · {ckb(stake)} CKB
                  </button>
                </>
              )}

              {rec.status === 'open' && live && (
                <button className="btn" disabled={!!busy || serverDown} onClick={() => act('Banking the round…', () => player!.cashOut(rec))}>
                  {k === 0 ? `End round, keep ${ckb(roundStake)} CKB` : `Bank ${ckb(cashNow)} CKB`}
                </button>
              )}

              {ended && (
                <>
                  {checks && (
                    <ol className="log">
                      {checks.map((c) => (
                        <li key={c.name}>
                          <span className={`mark ${c.ok ? 'chain' : 'warn'}`} aria-hidden />
                          <span className="text">
                            {c.ok ? '✓' : '✗'} {c.name}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {rec.status === 'open' && (
                    <button
                      className="btn"
                      onClick={() => {
                        rec.round = undefined;
                        save(rec);
                      }}
                    >
                      Next round
                    </button>
                  )}
                </>
              )}

              {rec.status === 'open' && !live && (
                <button className="btn ghost" disabled={!!busy || serverDown} onClick={() => act('Withdrawing…', () => player!.withdraw(rec))}>
                  Withdraw {ckb(state!.p)} CKB now
                </button>
              )}

              {(rec.status === 'closing' || (rec.status === 'open' && serverDown)) && (
                <div className="voucher">
                  <b className="mono">CLOSE WITHOUT THE OPERATOR</b>
                  {rec.status === 'open' ? (
                    <>
                      <span style={{ fontSize: 15 }}>
                        Post your latest co-signed state on chain. After {humanWindow(dChallenge)} it pays you {ckb(state!.p)} CKB
                        {live && k > 0 ? ` plus this round's ${ckb(cashNow)} CKB from your ${k} receipt${k === 1 ? '' : 's'}` : ''}.
                      </span>
                      <button className="btn warn" disabled={!!busy} onClick={() => act('Posting your state…', () => player!.closeAlone(rec))}>
                        Close alone
                      </button>
                    </>
                  ) : (
                    <span className="mono" style={{ fontSize: 15 }}>
                      {closing?.settleAt
                        ? now < closing.settleAt
                          ? `Window ends in ${countdown(closing.settleAt - now)}; collecting after that.`
                          : 'Window over; collecting (the chain clock lags a few minutes).'
                        : defend?.phase === 'posted'
                          ? `Posted ${defend.action}; waiting for the block.`
                          : 'Waiting for the chain…'}
                    </span>
                  )}
                </div>
              )}

              {rec.status === 'closed' && (
                <>
                  <p className="hero-l1">Paid {ckb(rec.paidOut ?? '0')} CKB to your wallet</p>
                  {rec.closeTx && (
                    <a className="hash mono" href={`${EXPLORER}/transaction/${rec.closeTx}`} target="_blank" rel="noreferrer">
                      {short(rec.closeTx)}
                    </a>
                  )}
                  <button className="btn" onClick={() => setRec(null)}>
                    New session
                  </button>
                </>
              )}

              {rec.rounds.length > 0 && (
                <details>
                  <summary className="mono" style={{ fontSize: 14, cursor: 'pointer' }}>
                    ROUNDS ({rec.rounds.length})
                  </summary>
                  <ol className="log">
                    {rec.rounds.map((r) => {
                      const ok = roundChecks(rec, r)?.every((c) => c.ok);
                      return (
                        <li key={r.id}>
                          <span className={`mark ${r.status === 'lost' ? 'warn' : 'chain'}`} aria-hidden />
                          <span className="text mono" style={{ fontSize: 14 }}>
                            {DIFFICULTY[r.m]} {ckb(r.stake)} → {r.status === 'lost' ? 'mine' : `${ckb(r.paid ?? '0')} (${r.receipts.length} safe)`} {ok ? '✓ verified' : ok === false ? '✗ check failed' : ''}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </details>
              )}
              <a className="note mono" style={{ fontSize: 13 }} href={sessionBackupUrl(rec)} download={`ckb-mines-session-${rec.id.slice(0, 8)}.json`}>
                Download session backup (needed to close alone from another browser)
              </a>
            </>
          )}
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
        </div>
        <span className="zigzag" />
      </aside>
    </div>
  );
}
