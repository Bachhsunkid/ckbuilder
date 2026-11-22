'use client';
import { ccc } from '@ckb-ccc/connector-react';
import { H, bytes, lockHash, receiptFromJson } from '@ckb-mines/chain';
import { PS, maxStakeFor, mustDecodeState, sessionArgsFromJson } from '@ckb-mines/chain/session';
import { SessionPlayer, type DefendResult, type RoundRecord, type SessionRecord } from '@ckb-mines/chain/session-player';
import * as P from '@ckb-mines/protocol';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  API,
  CKB,
  DIFFICULTY,
  EXPLORER,
  FAUCET,
  ckb,
  copyText,
  friendlyError,
  getSessionConfig,
  guideSeen,
  loadSessions,
  markGuideSeen,
  mult,
  saveSession,
  sessionBackupUrl,
  short,
  type SessionConfig,
} from './lib';
import { Hero, Ladder, Row, countdown, useNow, type Phase } from './Play';

const LIVE = new Set(['opening', 'open', 'withdrawing', 'closing']);

const OPEN_STEPS = ['Check the session terms', 'Sign the deposit in your wallet', 'Send it to the operator', 'Wait for one block (about 30–60 s)'];
const OPEN_PROGRESS: Record<string, number> = { 'session terms checked': 1, 'deposit signed': 2, 'deposit sent': 3 };

interface Action {
  label: string;
  run?: () => void;
  disabled?: boolean;
}

/** The five Verify checks, run in the browser on what this round's signed state committed to. */
export function roundChecks(rec: SessionRecord, r: RoundRecord): P.Check[] | null {
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

export function Session(props: { signer?: ccc.Signer; balance?: bigint; address?: string; onConnect: () => unknown }) {
  const { signer, balance, address } = props;
  const [cfg, setCfg] = useState<SessionConfig>();
  const [cfgErr, setCfgErr] = useState<string>();
  const [rec, setRec] = useState<SessionRecord | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [depositCkb, setDepositCkb] = useState(150);
  const [maxBetCkb, setMaxBetCkb] = useState(5);
  const [openStep, setOpenStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const [guideOpen] = useState(() => !guideSeen());
  const [mine, setMine] = useState<string>();
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

  // a free host can take up to a minute to wake up: keep retrying instead of failing once
  useEffect(() => {
    let live = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      getSessionConfig().then(
        (c) => live && (setCfg(c), setCfgErr(undefined)),
        (e) => {
          if (!live) return;
          tries += 1;
          setCfgErr(String(e));
          timer = setTimeout(load, Math.min(15_000, 3_000 * tries));
        },
      );
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  // free operator capacity, so a crowded table is visible before the player signs anything
  const [houseFree, setHouseFree] = useState<bigint>();
  useEffect(() => {
    if (rec) return;
    let live = true;
    const load = () =>
      fetch(`${API}/api/stats`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => live && d?.houseFree !== undefined && setHouseFree(BigInt(d.houseFree)))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [rec]);

  // the SDK updates the record in place and calls this before anything irreversible
  const save = useCallback((r: SessionRecord) => {
    saveSession(r);
    // the SDK saves the record before the deposit is sent: show it from that moment, so a slow block is visible
    setRec(r);
    bump();
  }, []);
  const player = useMemo(() => (signer ? new SessionPlayer(API, signer, save) : undefined), [signer, save]);

  // resume this wallet's session: the key and states are only in this browser
  useEffect(() => {
    setRec(null);
    setMine(undefined);
    if (!signer) return;
    let live = true;
    void (async () => {
      const mine = ccc.hexFrom(lockHash((await signer.getRecommendedAddressObj()).script));
      const saved = loadSessions().find((s) => LIVE.has(s.status) && s.args.playerLockHash === mine);
      if (!live) return;
      setMine(mine);
      if (saved) setRec(saved);
    })();
    return () => {
      live = false;
    };
  }, [signer]);

  // a reload during the deposit: wait for it here
  useEffect(() => {
    if (!player || !rec || rec.status !== 'opening' || busy) return;
    player.waitOpen(rec).catch((e) => setError(friendlyError(e)));
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
        if (live) setError(friendlyError(e));
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
      console.error(e);
      setError(friendlyError(e));
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

  const minStake = cfg ? Number(BigInt(cfg.minStake) / CKB) : 1;
  const cap = state ? maxStakeFor(state, curM) : 0n;
  const p = state?.p ?? 0n;
  const sliderMax = state ? Number(((cap < p - P.MIN_CELL ? cap : p - P.MIN_CELL) > 0n ? (cap < p - P.MIN_CELL ? cap : p - P.MIN_CELL) : 0n) / CKB) : 0;
  const canAllIn = state !== null && p <= cap && p >= BigInt(minStake) * CKB;
  const stake = allIn && canAllIn ? p : BigInt(Math.min(stakeCkb, Math.max(sliderMax, minStake))) * CKB;
  const stakeOk = state !== null && stake >= BigInt(minStake) * CKB && stake <= cap && (stake === p || p - stake >= P.MIN_CELL);
  useEffect(() => {
    if (sliderMax <= 0) return; // no session yet: keep the default instead of clamping it to nothing
    setStakeCkb((s) => Math.min(Math.max(s, minStake), Math.max(sliderMax, minStake)));
  }, [minStake, sliderMax]);

  const minDeposit = cfg ? Number(BigInt(cfg.minDeposit) / CKB) : 100;
  const maxDeposit = cfg ? Number(BigInt(cfg.maxDeposit) / CKB) : 2000;
  const maxBetLimit = cfg ? Number(BigInt(cfg.maxBet) / CKB) : 20;
  const deposit = BigInt(depositCkb) * CKB;
  const houseDeposit = (P.binom(9, 4) - 1n) * BigInt(maxBetCkb) * CKB;
  const need = deposit + P.MIN_CELL + CKB;
  const tables = houseFree === undefined ? undefined : Number(houseFree / (houseDeposit + P.MIN_CELL));
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

  useEffect(() => {
    if (!cfg) return;
    setMaxBetCkb((b) => Math.min(Math.max(b, minStake), Math.max(maxBetLimit, minStake)));
  }, [cfg, minStake, maxBetLimit]);

  const past = useMemo(
    () => (mine && !rec ? loadSessions().filter((s) => s.status === 'closed' && s.args.playerLockHash === mine).slice(0, 5) : []),
    [mine, rec],
  );

  // ---------- actions (shared by the receipt panel and the phone action bar) ----------
  const openSession = () =>
    act('Checking the session terms…', async () => {
      setOpenStep(0);
      const r = await player!.open(deposit, BigInt(maxBetCkb) * CKB, (s) => {
        if (s in OPEN_PROGRESS) setOpenStep(OPEN_PROGRESS[s]);
        if (s === 'session terms checked') setBusy('Sign the deposit in your wallet…');
        if (s === 'deposit sent') setBusy('Waiting for the block…');
      });
      markGuideSeen();
      setRec(r);
    });
  const startRound = () =>
    act('Sealing the layout…', async () => {
      await player!.startRound(rec!, curM, stake);
      // phones: the stake controls sit below the board, so bring the tiles back into view
      if (window.matchMedia('(max-width: 1040px)').matches) document.querySelector('.grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  const bank = () => act('Banking the round…', () => player!.cashOut(rec!));
  const nextRound = () => {
    rec!.round = undefined;
    save(rec!);
  };
  const withdraw = () => act('Withdrawing…', () => player!.withdraw(rec!));
  const newSession = () => {
    setError(undefined);
    setRec(null);
  };

  const opening = (!!busy && !rec) || rec?.status === 'opening';
  const primary: Action | null = !signer
    ? { label: 'Connect wallet to play', run: () => props.onConnect() }
    : opening
      ? { label: openStep >= 3 || rec?.status === 'opening' ? 'Waiting for the block…' : 'Opening…', disabled: true }
      : !rec
        ? { label: `Open session · ${depositCkb} CKB`, run: openSession, disabled: !enough || !!busy || !player }
        : rec.status === 'open' && live
          ? { label: k === 0 ? `End round, keep ${ckb(roundStake)} CKB` : `Bank ${ckb(cashNow)} CKB`, run: bank, disabled: !!busy || serverDown }
          : rec.status === 'open' && ended
            ? { label: 'Next round', run: nextRound }
            : rec.status === 'open'
              ? { label: `Start round · ${ckb(stake)} CKB`, run: startRound, disabled: !stakeOk || !!busy || serverDown }
              : rec.status === 'closed'
                ? { label: 'New session', run: newSession }
                : null;

  // with a saved session the page keeps working without the server: it can still close alone
  if (!cfg && !rec) {
    return (
      <p className={cfgErr ? 'err' : 'status'} role="status">
        {cfgErr ? 'Waking up the game server. Free hosting can take up to a minute; this page retries by itself.' : 'Connecting to the game server…'}
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
  const barInfo: string[] = opening
    ? ['Opening session', rec?.createdAt ? `${Math.max(0, Math.round((now - rec.createdAt) / 1000))} s · details ↓` : 'details ↓']
    : !rec
    ? [`Deposit ${depositCkb} CKB`, `max bet ${maxBetCkb} · edit ↓`]
    : live
      ? [k === 0 ? `Stake ${ckb(roundStake)} CKB` : `Cash out ${ckb(cashNow)} CKB`, `${k} safe · ${Math.round((curM / (9 - k)) * 100)}% risk next`]
      : rec.status === 'open' && !ended
        ? [`Balance ${ckb(state!.p)} CKB`, `${DIFFICULTY[curM]} · ${ckb(stake)} CKB · edit ↓`]
        : rec.status === 'closed'
          ? [`Paid ${ckb(rec.paidOut ?? '0')} CKB`, 'session closed']
          : rec.status === 'withdrawing'
            ? [`Withdrawing ${ckb(state!.p)} CKB`, 'one block, about 30–60 s']
            : rec.status === 'closing'
              ? ['Closing on chain', 'this page collects for you · details ↓']
              : [`Balance ${ckb(state!.p)} CKB`, ended ? 'round settled · withdraw ↓' : `state ${state!.n}`];

  return (
    <div className="row">
      <section className="board-col" aria-label="Board">
        <Hero
          phase={phase}
          k={k}
          m={curM}
          left={9 - k}
          stake={live || ended ? roundStake : rec && rec.status !== 'opening' ? stake : BigInt(maxBetCkb) * CKB}
          cashNow={cashNow}
          status={ended ? round!.status : undefined}
          paid={round?.status === 'won' ? round.paid : undefined}
        />
        <p className="status" role="status" aria-live="polite">
          {status}
        </p>
        {!rec && (
          <details className="guide" open={guideOpen}>
            <summary className="mono">HOW IT WORKS</summary>
            <ol>
              <li>
                <b>Connect a CKB wallet.</b> JoyID runs in your browser with a passkey, nothing to install.
              </li>
              <li>
                <b>Get free testnet CKB</b> from the{' '}
                <a href={FAUCET} target="_blank" rel="noreferrer">
                  faucet
                </a>
                . You need about {ckb(need)} CKB for a {depositCkb} CKB session.
              </li>
              <li>
                <b>Deposit once.</b> Every round after that is instant, with no wallet popup. Pick a difficulty and a stake, open tiles, bank whenever you like.
              </li>
              <li>
                <b>Withdraw any time</b> in one transaction. If the operator ever stops answering, this page closes alone with the signed states it holds.
              </li>
            </ol>
            <p className="note">Testnet only: CKB here has no value. Every round can be checked in your browser, and on the Verify tab.</p>
          </details>
        )}
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

      <aside className="receipt-col" aria-label="Session" id="session-panel">
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
                {tables !== undefined && <Row k="Tables free at this max bet" v={tables > 20 ? '20+' : String(tables)} />}
              </dl>
              {tables === 0 && (
                <p className="note" role="status">
                  All tables are taken at this max bet. Lower the max bet, or try again in a few minutes as sessions close.
                </p>
              )}
              {signer && balance !== undefined && !enough && !opening && (
                <div className="voucher">
                  <b className="mono">GET TESTNET CKB FIRST</b>
                  <span style={{ fontSize: 15 }}>
                    Your wallet holds {ckb(balance)} CKB. A {depositCkb} CKB session needs {ckb(need)} CKB (deposit, 61 CKB change, fee). Paste your address into the{' '}
                    <a href={FAUCET} target="_blank" rel="noreferrer">
                      Nervos faucet
                    </a>
                    ; the balance above updates by itself.
                  </span>
                  {address && (
                    <button
                      className="btn ghost"
                      onClick={() =>
                        void copyText(address).then((ok) => {
                          setCopied(ok);
                          setTimeout(() => setCopied(false), 2000);
                        })
                      }
                    >
                      {copied ? 'Address copied ✓' : 'Copy my address'}
                    </button>
                  )}
                </div>
              )}
              {opening && <OpenSteps step={openStep} now={now} />}
              {primary && (
                <button className="btn" disabled={primary.disabled} onClick={primary.run}>
                  {primary.label}
                </button>
              )}
              {past.length > 0 && (
                <details>
                  <summary className="mono" style={{ fontSize: 14, cursor: 'pointer' }}>
                    PAST SESSIONS ({past.length})
                  </summary>
                  <ol className="log">
                    {past.map((s) => (
                      <li key={s.id}>
                        <span className="mark chain" aria-hidden />
                        <span className="text mono" style={{ fontSize: 14 }}>
                          No. {s.id.slice(0, 8)} · {s.rounds.length} round{s.rounds.length === 1 ? '' : 's'} · deposit {ckb(s.deposit)} → paid {ckb(s.paidOut ?? '0')}
                          {s.closeTx && (
                            <>
                              {' · '}
                              <a href={`${EXPLORER}/transaction/${s.closeTx}`} target="_blank" rel="noreferrer">
                                tx
                              </a>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          ) : rec.status === 'opening' ? (
            <>
              <dl className="kv mono">
                <Row k="You deposit" v={`${ckb(rec.deposit)} CKB`} />
                <Row k="Operator deposits" v={`${ckb(rec.houseDeposit)} CKB`} />
              </dl>
              <OpenSteps step={Math.max(openStep, 3)} since={rec.createdAt} now={now} tx={rec.depositTx} />
              {primary && (
                <button className="btn" disabled={primary.disabled} onClick={primary.run}>
                  {primary.label}
                </button>
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
                  <button className="btn" disabled={primary?.disabled} onClick={startRound}>
                    {primary?.label}
                  </button>
                </>
              )}

              {rec.status === 'open' && live && (
                <button className="btn" disabled={primary?.disabled} onClick={bank}>
                  {primary?.label}
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
                    <button className="btn" onClick={nextRound}>
                      Next round
                    </button>
                  )}
                </>
              )}

              {rec.status === 'open' && !live && (
                <button className="btn ghost" disabled={!!busy || serverDown} onClick={withdraw}>
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
                  <button className="btn" onClick={newSession}>
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

      {/* phones: the board and the receipt stack, so the next action stays in reach of the thumb */}
      <div className="mbar" role="region" aria-label="Next action">
        <a className="mbar-info mono" href="#session-panel" onClick={(e) => (e.preventDefault(), document.getElementById('session-panel')?.scrollIntoView({ behavior: 'smooth' }))}>
          {barInfo.map((l, i) => (
            <span key={i} className={i === 0 ? 'mbar-main' : ''}>
              {l}
            </span>
          ))}
        </a>
        {primary && (
          <button className="btn" disabled={primary.disabled} onClick={primary.run}>
            {primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

function OpenSteps({ step, since, now, tx }: { step: number; since?: number; now: number; tx?: string }) {
  return (
    <ol className="steps" aria-label="Opening the session">
      {OPEN_STEPS.map((label, i) => (
        <li key={label} className={i < step ? 'done' : i === step ? 'now' : ''} aria-current={i === step ? 'step' : undefined}>
          <span className="mono">{i < step ? '✓' : i + 1}</span>
          <span>
            {label}
            {i === 3 && step === 3 && since ? ` · ${Math.max(0, Math.round((now - since) / 1000))} s` : ''}
          </span>
        </li>
      ))}
      {tx && step >= 3 && (
        <li className="steps-tx">
          <a className="mono" href={`${EXPLORER}/transaction/${tx}`} target="_blank" rel="noreferrer">
            deposit {short(tx)} ↗
          </a>
        </li>
      )}
    </ol>
  );
}
