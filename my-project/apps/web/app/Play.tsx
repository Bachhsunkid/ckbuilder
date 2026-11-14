'use client';
import { ccc } from '@ckb-ccc/connector-react';
import { H, bytes, lockHash } from '@ckb-mines/chain';
import { DEFAULT_POLICY, MinesPlayer, type GameState, type Policy, type ServerBet } from '@ckb-mines/chain/player';
import * as P from '@ckb-mines/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ACTIVE, API, CKB, DIFFICULTY, EXPLORER, FAUCET, ckb, getConfig, loadGames, mult, saveGame, short, type LogLine, type SavedGame, type ServerConfig } from './lib';

export type Phase = 'setup' | 'starting' | 'playing' | 'done';

const DONE_STAMP: Record<string, { text: string; color: string }> = {
  won: { text: 'PAID', color: 'var(--blue)' },
  exited: { text: 'EXITED', color: 'var(--ink)' },
  lost: { text: 'MINE', color: 'var(--stamp)' },
  forfeited: { text: 'FORFEITED', color: 'var(--stamp)' },
  failed: { text: 'VOID', color: 'var(--muted)' },
};

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Play(props: { signer?: ccc.Signer; balance?: bigint; walletName?: string; onConnect: () => unknown }) {
  const { signer, balance } = props;
  const [cfg, setCfg] = useState<ServerConfig>();
  const [cfgErr, setCfgErr] = useState<string>();
  const [m, setM] = useState(2);
  const [stakeCkb, setStakeCkb] = useState(10);
  const [game, setGame] = useState<SavedGame | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [view, setView] = useState<ServerBet & { openedAt?: string | null }>();
  const [serverDown, setServerDown] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const now = useNow();
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    getConfig().then(setCfg, (e) => setCfgErr(String(e)));
  }, []);

  // In `next dev` the server runs with short test timelocks; a real deployment keeps the safe defaults.
  const policy: Policy = useMemo(
    () =>
      process.env.NODE_ENV === 'development' && cfg
        ? { maxDExit: BigInt(cfg.dExit), minDForfeit: BigInt(cfg.dForfeit) }
        : DEFAULT_POLICY,
    [cfg],
  );
  const player = useMemo(() => (signer ? new MinesPlayer(API, signer, policy) : undefined), [signer, policy]);

  const commit = useCallback((g: SavedGame) => {
    const copy: SavedGame = { ...g, state: { ...g.state }, log: [...g.log] };
    saveGame(copy);
    setGame(copy);
  }, []);

  const addLog = (g: SavedGame, line: LogLine) => {
    g.log.push(line);
  };

  // resume an unfinished game for this wallet (receipts are only in this browser)
  useEffect(() => {
    if (!signer) return;
    let live = true;
    void (async () => {
      const mine = lockHash((await signer.getRecommendedAddressObj()).script);
      const saved = loadGames().find((g) => ACTIVE.has(g.state.status) && g.state.args.playerLockHash === ccc.hexFrom(mine));
      if (live && saved && !gameRef.current) {
        setGame(saved);
        setM(saved.state.m);
        setPhase('playing');
      }
    })();
    return () => {
      live = false;
    };
  }, [signer]);

  // follow the server's view of an active game; notice when it stops answering
  useEffect(() => {
    if (!player || !game || phase === 'setup') return;
    let live = true;
    const poll = async () => {
      try {
        const v = await player.status(game.state.betId);
        if (!live) return;
        setView(v);
        setServerDown(false);
        const g = gameRef.current;
        if (!g) return;
        if (g.state.status === 'open' && ['won', 'lost', 'exited', 'forfeited'].includes(v.status)) {
          // settled elsewhere (another tab, or the watcher saw our exit)
          const next = { ...g, state: { ...g.state, status: v.status as GameState['status'], S: v.S ?? g.state.S, settleTx: v.settleTx ?? g.state.settleTx } };
          addLog(next, { text: `Settled as ${v.status}`, kind: 'chain', hash: v.settleTx ?? undefined });
          commit(next);
          setPhase('done');
        } else if (!ACTIVE.has(g.state.status) && v.S && !g.state.S) {
          commit({ ...g, state: { ...g.state, S: v.S } });
        }
      } catch {
        if (live) setServerDown(true);
      }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [player, game?.state.betId, phase, commit]);

  const stake = BigInt(stakeCkb) * CKB;
  const minStake = cfg ? Number(BigInt(cfg.minStake) / CKB) : 10;
  const maxStake = cfg ? Math.max(minStake, Math.min(100, Number(BigInt(cfg.maxCollateral) / (P.binom(9, m) - 1n) / CKB))) : 20;
  useEffect(() => {
    setStakeCkb((s) => Math.min(Math.max(s, minStake), maxStake));
  }, [minStake, maxStake]);
  const need = stake + P.MIN_CELL + CKB; // stake, a change cell for settling later, fees
  const enough = balance !== undefined && balance >= need;

  async function start() {
    if (!player) return;
    setError(undefined);
    setPhase('starting');
    const log: LogLine[] = [];
    setBusy('Sealing the layout…');
    try {
      const state = await player.start(m, stake, (step) => {
        if (step === 'layout sealed') setBusy('Committing your seed…');
        if (step === 'bet signed') setBusy('Sending the bet…');
        if (step === 'bet sent') setBusy('Waiting for the block…');
      });
      log.push({ text: `Layout sealed before you chose. Root R ${short(state.args.R)}`, kind: 'off' });
      log.push({ text: `Your seed C and 9 pick secrets committed (Q ${short(state.args.Q)})`, kind: 'off' });
      log.push({ text: `Bet cell locked: ${ckb(P.betCapacity(stake, m))} CKB (your ${ckb(stake)} + operator ${ckb(P.collateral(stake, m))})`, kind: 'chain', hash: state.betTx });
      commit({ state, log, savedAt: Date.now() });
      setPhase('playing');
    } catch (e) {
      setError(String(e));
      setPhase('setup');
    } finally {
      setBusy(null);
    }
  }

  async function reveal(t: number) {
    if (!player || !game || busy) return;
    setError(undefined);
    setPending(t);
    setBusy(`Opening tile ${t + 1}…`);
    const g: SavedGame = { ...game, state: { ...game.state }, log: [...game.log] };
    try {
      const r = await player.reveal(g.state, t);
      if (r === 'safe') {
        const k = g.state.receipts.length;
        addLog(g, { text: `Tile ${t + 1} safe. Signed receipt #${k} kept in this browser`, kind: 'off' });
        commit(g);
      } else {
        addLog(g, { text: `Tile ${t + 1} was a mine. Operator proved it with the seed S`, kind: 'chain', hash: g.state.settleTx });
        commit(g);
        setPhase('done');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(null);
      setBusy(null);
    }
  }

  async function cashOut() {
    if (!player || !game) return;
    setError(undefined);
    setBusy('Checking the cash-out and signing…');
    const g: SavedGame = { ...game, state: { ...game.state }, log: [...game.log] };
    try {
      await player.cashOut(g.state);
      addLog(g, { text: `Cashed out ${ckb(g.state.paid!)} CKB to your wallet`, kind: 'chain', hash: g.state.settleTx });
      commit(g);
      setPhase('done');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function exit() {
    if (!player || !game) return;
    setError(undefined);
    setBusy('Building the exit from your receipts…');
    const g: SavedGame = { ...game, state: { ...game.state }, log: [...game.log] };
    try {
      await player.exit(g.state);
      const n = g.state.receipts.length;
      addLog(g, { text: `Exited alone with ${n} receipt${n === 1 ? '' : 's'}. No operator needed`, kind: 'chain', hash: g.state.settleTx });
      commit(g);
      setPhase('done');
    } catch (e) {
      const s = String(e);
      setError(/immature|since/i.test(s) ? 'The chain clock has not reached the exit time yet (it lags a minute or two). Try again shortly.' : s);
    } finally {
      setBusy(null);
    }
  }

  function newGame() {
    setGame(null);
    setView(undefined);
    setError(undefined);
    setPhase('setup');
  }

  // ---- derived view ----
  const st = game?.state;
  const curM = st?.m ?? m;
  const k = st?.receipts.length ?? 0;
  const left = 9 - k;
  const cashNow = st ? P.payout(BigInt(st.stake), k, st.m).payout : 0n;
  const openedAt = view?.openedAt ? new Date(view.openedAt).getTime() : undefined;
  const playEnds = view?.tPlayEndsAt ? new Date(view.tPlayEndsAt).getTime() : undefined;
  const exitAt = openedAt && st ? openedAt + Number(st.args.dExit) * 1000 : undefined;
  const windowClosed = playEnds !== undefined && now > playEnds;
  const stalled = phase === 'playing' && st?.status === 'open' && (serverDown || windowClosed);
  const canPlay = phase === 'playing' && st?.status === 'open' && !busy && !windowClosed && !serverDown;

  const layout = useMemo(() => {
    if (!st?.S) return undefined;
    const states = P.buildLayout(bytes(st.S), st.m, H).states;
    const pi = P.tileMap(bytes(st.args.C), H);
    return Array.from({ length: 9 }, (_, t) => states[pi[t]] === 1);
  }, [st?.S, st?.m, st?.args.C]);

  const stamp = phase === 'done' && st ? DONE_STAMP[st.status] : undefined;

  if (cfgErr) {
    return (
      <p className="err">
        Cannot reach the game server at {API}. {cfgErr}
      </p>
    );
  }

  return (
    <div className="row">
      <section className="board-col" aria-label="Board">
        <Hero phase={phase} k={k} m={curM} left={left} stake={st ? BigInt(st.stake) : stake} cashNow={cashNow} status={st?.status} paid={st?.paid} />
        <p className="status" role="status" aria-live="polite">
          {busy ??
            (phase === 'setup'
              ? 'Choose a difficulty and a stake, then place the bet.'
              : stalled
                ? serverDown
                  ? 'The operator is not answering. Your receipts let you leave on your own.'
                  : 'The play window closed. You can still exit with your receipts.'
                : phase === 'playing'
                  ? `Pick a tile.${playEnds ? ` Play window ${countdown(playEnds - now)}` : ''}`
                  : phase === 'done'
                    ? st?.status === 'lost'
                      ? 'Game over. The full layout is shown below.'
                      : 'Game settled on-chain.'
                    : '')}
        </p>
        <div className="grid">
          {Array.from({ length: 9 }, (_, t) => {
            const o = st?.opened.find((x) => x.t === t);
            let cls = 'hidden';
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
            } else if (phase === 'done' && layout) {
              cls = layout[t] ? 'ghost-mine' : 'ghost-safe';
              cap = layout[t] ? 'mine' : '';
            } else if (canPlay) cls = 'hidden live';
            else cls = 'idle';
            const clickable = canPlay && !o && pending === null;
            return (
              <button
                key={t}
                className={`tile ${cls}`}
                disabled={!clickable}
                onClick={() => clickable && reveal(t)}
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

      <aside className="receipt-col" aria-label="Receipt">
        <div className="paper-top" />
        <div className="paper">
          {stamp && (
            <span className="stamp mono" style={{ color: stamp.color, borderColor: stamp.color }}>
              {stamp.text}
            </span>
          )}
          <div className="mono" style={{ fontSize: 14 }}>
            <b>CKB MINES · BET SLIP</b>
            <br />
            {st ? `No. ${st.betId.slice(0, 8)}` : 'Not placed yet'}
          </div>

          {phase === 'setup' || phase === 'starting' ? (
            <>
              <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }} disabled={phase === 'starting'}>
                <legend className="mono" style={{ fontSize: 14, marginBottom: 8 }}>
                  DIFFICULTY
                </legend>
                {[2, 3, 4].map((x) => (
                  <button key={x} className="diff" aria-pressed={m === x} onClick={() => setM(x)}>
                    <b style={{ minWidth: 72 }}>{DIFFICULTY[x]}</b>
                    <span className="mono" style={{ fontSize: 14 }}>
                      {x} mines · first tile {mult(1, x)}
                    </span>
                  </button>
                ))}
              </fieldset>
              <label className="dash" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="mono" style={{ fontSize: 14 }}>
                  STAKE <b style={{ fontSize: 20 }}>{stakeCkb} CKB</b>
                </span>
                <input
                  type="range"
                  min={minStake}
                  max={maxStake}
                  step={1}
                  value={stakeCkb}
                  disabled={phase === 'starting'}
                  onChange={(e) => setStakeCkb(Number(e.target.value))}
                />
                <span className="note">
                  {minStake}–{maxStake} CKB on {DIFFICULTY[m]}
                </span>
              </label>
              <dl className="kv mono">
                <Row k="Your stake" v={`${ckb(stake)} CKB`} />
                <Row k="Operator locks" v={`${ckb(P.collateral(stake, m))} CKB`} />
                <Row k="Best payout" v={`${ckb(P.payout(stake, 9 - m, m).payout)} CKB`} />
                <Row k="Fee" v="5% of profit" />
                <Row k="Exit alone after" v={cfg ? `${Math.round(Number(cfg.dExit) / 60)} min` : '…'} />
              </dl>
              {!signer ? (
                <button className="btn" onClick={() => props.onConnect()}>
                  Connect wallet to play
                </button>
              ) : (
                <>
                  {balance !== undefined && !enough && (
                    <p className="err">
                      You need at least {ckb(need)} CKB (stake + 61 CKB to settle later). Get testnet CKB from the{' '}
                      <a href={FAUCET} target="_blank" rel="noreferrer">
                        faucet
                      </a>
                      .
                    </p>
                  )}
                  <button className="btn" disabled={!enough || phase === 'starting'} onClick={start}>
                    {phase === 'starting' ? 'Placing bet…' : `Place bet · ${stakeCkb} CKB`}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <ol className="log">
                {game?.log.map((l, i) => (
                  <li key={i}>
                    <span className={`mark ${l.kind === 'off' ? '' : l.kind}`} aria-hidden />
                    <span>
                      <span className="text">{l.text}</span>
                      {l.hash && (
                        <>
                          <br />
                          <a className="hash mono" href={`${EXPLORER}/transaction/${l.hash}`} target="_blank" rel="noreferrer">
                            {short(l.hash)}
                          </a>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="note mono" style={{ fontSize: 13 }}>
                ■ on-chain &nbsp; □ between you and the operator
              </p>

              {phase === 'playing' && st?.status === 'open' && !stalled && (
                <button className="btn" disabled={k === 0 || !!busy} onClick={cashOut}>
                  {k === 0 ? 'Open a tile to cash out' : `Cash out ${ckb(cashNow)} CKB`}
                </button>
              )}

              {stalled && (
                <div className="voucher">
                  <b className="mono">EXIT VOUCHER</b>
                  <span style={{ fontSize: 15 }}>
                    Your {k} receipt{k === 1 ? ' pays' : 's pay'} you at least {ckb(cashNow)} CKB (minus a 0.001 CKB fee) without the operator.
                  </span>
                  {exitAt && now < exitAt ? (
                    <span className="mono">Exit opens in {countdown(exitAt - now)}</span>
                  ) : (
                    <span className="mono">Exit is open</span>
                  )}
                  <button className="btn warn" disabled={!!busy || !exitAt || now < exitAt} onClick={exit}>
                    Exit with my receipts
                  </button>
                </div>
              )}

              {phase === 'done' && st && (
                <>
                  {st.status === 'lost' && <p className="note">The operator kept the bet. Check that the mine was really there:</p>}
                  <a className="btn ghost" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href={`#verify/${st.betId}`}>
                    Verify this game
                  </a>
                  <button className="btn" onClick={newGame}>
                    New game
                  </button>
                </>
              )}
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

export function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <span className="lead" />
      <dd>{v}</dd>
    </div>
  );
}

export function Hero(p: { phase: Phase; k: number; m: number; left: number; stake: bigint; cashNow: bigint; status?: string; paid?: string }) {
  const minesLeft = p.m;
  const risk = p.left > 0 ? Math.round((minesLeft / p.left) * 100) : 0;
  const done = p.phase === 'done';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="hero-big mono">{p.phase === 'setup' || p.phase === 'starting' ? mult(1, p.m) : mult(p.k, p.m)}</div>
      {done ? (
        <p className="hero-l1">
          {p.status === 'lost' ? `Lost ${ckb(p.stake)} CKB` : p.paid ? `Paid ${ckb(p.paid)} CKB` : 'Settled'}
        </p>
      ) : p.phase === 'playing' ? (
        <p className="hero-l1">{p.k === 0 ? 'Open a tile to start winning' : `Cash out now: ${ckb(p.cashNow)} CKB`}</p>
      ) : (
        <p className="hero-l1">First safe tile pays {ckb(P.payout(p.stake, 1, p.m).payout)} CKB</p>
      )}
      <div className="pips" aria-hidden>
        {Array.from({ length: p.left }, (_, i) => (
          <span key={i} className={`pip ${i < minesLeft ? 'mine' : ''}`} />
        ))}
      </div>
      <p className="hero-l2">
        {minesLeft} of the {p.left} tiles left are mines: {risk}% risk
      </p>
    </div>
  );
}

export function Ladder({ k, m }: { k: number; m: number }) {
  return (
    <div className="ladder" aria-label="Multiplier ladder">
      {Array.from({ length: 9 - m }, (_, i) => i + 1).map((n) => (
        <div key={n} className={`rung ${n <= k ? 'done' : n === k + 1 ? 'next' : ''}`}>
          <div className="mono" style={{ fontSize: 13 }}>
            {n} safe
          </div>
          <div className="m mono">{mult(n, m)}</div>
        </div>
      ))}
    </div>
  );
}
