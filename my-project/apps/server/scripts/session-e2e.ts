// End-to-end reliability run for sessions (ADR 0001) on CKB testnet.
// A session counts as a success only if it pays out on chain, the player receives exactly
// the balance the rounds add up to (computed here, independently of the SDK), and the
// server records the same close and amount.
//
// Modes per session:
//   coop  - play rounds, withdraw with the operator (one transaction);
//   alone - play rounds, then close without the operator mid-round with receipts in hand
//           (CLOSE, RECEIPTS, SETTLE after D_challenge).
//
// Usage (server running with a short window, e.g. D_CHALLENGE=120):
//   npx tsx scripts/session-e2e.ts --sessions 12 --players 4 --rounds 5 --alone-share 0.25
import { ccc } from '@ckb-ccc/core';
import fs from 'fs';
import path from 'path';
import { P } from '@ckb-mines/chain';
import { maxStakeFor } from '@ckb-mines/chain/session';
import { SessionPlayer, type SessionRecord } from '@ckb-mines/chain/session-player';
import { config } from '../src/config';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SESSIONS = Number(arg('sessions', '4'));
const PLAYERS = Number(arg('players', '2'));
const ROUNDS = Number(arg('rounds', '5'));
const ALONE_SHARE = Number(arg('alone-share', '0.25'));
const API = arg('api', `http://127.0.0.1:${config.port}`);
const DEPOSIT = ccc.fixedPointFrom(arg('deposit', '150'));
const MAX_BET = ccc.fixedPointFrom(arg('max-bet', '10'));
const FUND = ccc.fixedPointFrom(arg('fund', '450'));
const KEYS = path.resolve(import.meta.dirname, '../../../.e2e-keys.json');
const OUT_DIR = path.resolve(import.meta.dirname, '../../../e2e-results');

const client = new ccc.ClientPublicTestnet(config.rpcUrl ? { url: config.rpcUrl } : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rnd = (n: number) => Math.floor(Math.random() * n);
const CKB = P.SHANNONS_PER_CKB;
// read from the server at start: the window the sessions are actually opened with
let dChallenge = config.dChallengeSeconds;

function loadKeys(n: number): string[] {
  const keys: string[] = fs.existsSync(KEYS) ? JSON.parse(fs.readFileSync(KEYS, 'utf8')) : [];
  while (keys.length < n) {
    const k = new Uint8Array(32);
    crypto.getRandomValues(k);
    keys.push(ccc.hexFrom(k));
  }
  fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2));
  return keys.slice(0, n);
}

async function fund(signers: ccc.SignerCkbPrivateKey[]) {
  const operator = new ccc.SignerCkbPrivateKey(client, config.privateKey);
  const outputs: ccc.CellOutputLike[] = [];
  for (const s of signers) {
    const bal = await s.getBalance();
    if (bal < FUND) outputs.push({ lock: (await s.getRecommendedAddressObj()).script, capacity: FUND - bal + 61n * CKB });
  }
  if (!outputs.length) return;
  const tx = ccc.Transaction.from({ outputs, outputsData: outputs.map(() => '0x') });
  await tx.completeInputsByCapacity(operator);
  await tx.completeFeeBy(operator, 1000);
  const hash = await operator.sendTransaction(tx);
  log('funding', outputs.length, 'players', hash);
  await client.waitTransaction(hash, 1, 300_000);
  await sleep(8000);
}

interface Result {
  player: number;
  session: number;
  id?: string;
  mode: 'coop' | 'alone';
  rounds: { m: number; stake: string; k: number; result: 'won' | 'lost'; paid: string }[];
  /** k receipts held when closing alone mid-round */
  openRound?: { m: number; stake: string; k: number };
  expected?: string;
  received?: string;
  serverPaid?: string;
  ok: boolean;
  reason?: string;
  seconds: number;
  roundMs: number[];
  closeTx?: string;
}

/** Plays one round, tracking the balance on our own. Returns the new balance. */
async function playRound(sp: SessionPlayer, rec: SessionRecord, bal: bigint, res: Result, stopAfterSafe?: number): Promise<{ bal: bigint; live: boolean }> {
  const state = SessionPlayer.state(rec);
  // after the player wins, the operator deposit covers less: only offer difficulties it still covers
  const feasible = [2, 3, 4].filter((x) => maxStakeFor(state, x) >= 10n * CKB);
  if (!feasible.length) throw new Error(`no difficulty fits: balance ${state.p}, operator ${state.h}`);
  const m = feasible[rnd(feasible.length)];
  const cap = maxStakeFor(state, m);
  let stake = 10n * CKB + BigInt(rnd(6)) * CKB;
  if (stake > cap) stake = cap;
  // keep the rest payable: either all in or at least 61 CKB left
  if (state.p - stake !== 0n && state.p - stake < P.MIN_CELL) stake = state.p;
  if (stake > cap || stake < 10n * CKB) throw new Error(`cannot place a round: balance ${state.p}, cap ${cap}`);
  const t0 = Date.now();
  await sp.startRound(rec, m, stake);
  const target = stopAfterSafe ?? 1 + rnd(3);
  const order = [...Array(9).keys()].sort(() => Math.random() - 0.5);
  let k = 0;
  for (const t of order) {
    if (k >= target) break;
    const r = await sp.reveal(rec, t);
    if (r === 'mine') {
      res.rounds.push({ m, stake: stake.toString(), k, result: 'lost', paid: '0' });
      res.roundMs.push(Date.now() - t0);
      return { bal: bal - stake, live: false };
    }
    k++;
  }
  if (stopAfterSafe !== undefined) {
    res.openRound = { m, stake: stake.toString(), k };
    return { bal: bal - stake + P.payout(stake, k, m).payout, live: true };
  }
  const paid = await sp.cashOut(rec);
  const due = P.payout(stake, k, m).payout;
  if (paid !== due) throw new Error(`cash-out credited ${paid}, rules say ${due}`);
  res.rounds.push({ m, stake: stake.toString(), k, result: 'won', paid: paid.toString() });
  res.roundMs.push(Date.now() - t0);
  return { bal: bal - stake + paid, live: false };
}

async function untilClosed(sp: SessionPlayer, rec: SessionRecord, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const d = await sp.defend(rec).catch((e) => ({ phase: `error ${String(e).slice(0, 120)}` }) as never);
    const tag = d.phase === 'posted' ? `posted ${d.action}` : d.phase;
    if (tag !== last) log(`  ${rec.id.slice(0, 8)} ${tag}`);
    last = tag;
    if (d.phase === 'closed') return d;
    if (Date.now() > end) throw new Error(`timeout: session still ${tag}`);
    await sleep(10_000);
  }
}

async function runSession(sp: SessionPlayer, player: number, session: number, mode: 'coop' | 'alone'): Promise<Result> {
  const t0 = Date.now();
  const res: Result = { player, session, mode, rounds: [], ok: false, seconds: 0, roundMs: [] };
  try {
    // the operator funds a bounded number of sessions at once; a 503 means wait for a free house cell
    let rec: SessionRecord | undefined;
    for (let attempt = 0; !rec; attempt++) {
      try {
        rec = await sp.open(DEPOSIT, MAX_BET);
      } catch (e) {
        if (!/ 503 /.test(String(e)) || attempt >= 20) throw e;
        await sleep(30_000);
      }
    }
    res.id = rec.id;
    log(`p${player} s${session} open ${rec.id.slice(0, 8)} ${mode}`);
    let bal = DEPOSIT;
    for (let i = 0; i < ROUNDS; i++) bal = (await playRound(sp, rec, bal, res)).bal;
    if (mode === 'alone') {
      // keep a round open with receipts in hand and walk away from the operator
      bal = (await playRound(sp, rec, bal, res, 1 + rnd(2))).bal;
      if (!res.openRound) {
        // hit a mine instead: close alone on the loss state
        log(`p${player} s${session} hit a mine in the open round; closing on the loss`);
      }
      await sp.closeAlone(rec);
    } else {
      await sp.withdraw(rec);
    }
    if (SessionPlayer.balance(rec) !== bal && mode === 'coop') throw new Error(`SDK balance ${SessionPlayer.balance(rec)} != ours ${bal}`);
    const expected = bal < P.MIN_CELL ? 0n : bal;
    res.expected = expected.toString();
    const done = await untilClosed(sp, rec, mode === 'alone' ? Number(dChallenge) * 4000 + 900_000 : 600_000);
    if (done.phase !== 'closed') throw new Error('not closed');
    res.received = done.paid.toString();
    res.closeTx = done.txHash;
    // the server must agree
    let view = await sp.status(rec.id);
    for (let i = 0; i < 30 && view.status !== 'closed'; i++) {
      await sleep(5000);
      view = await sp.status(rec.id);
    }
    res.serverPaid = (view as unknown as { paidPlayer: string | null }).paidPlayer ?? undefined;
    const problems: string[] = [];
    if (done.paid !== expected) problems.push(`paid ${done.paid} != expected ${expected}`);
    if (view.status !== 'closed') problems.push(`server says ${view.status}`);
    else if (res.serverPaid !== expected.toString()) problems.push(`server recorded ${res.serverPaid}`);
    res.ok = problems.length === 0;
    if (!res.ok) res.reason = problems.join('; ');
  } catch (e) {
    res.reason = String(e).slice(0, 400);
  }
  res.seconds = Math.round((Date.now() - t0) / 1000);
  log(`p${player} s${session} ${res.ok ? 'OK' : 'FAIL'} ${res.mode} rounds=${res.rounds.length} paid=${res.received ?? '-'} ${res.reason ?? ''}`);
  return res;
}

async function main() {
  const keys = loadKeys(PLAYERS);
  const signers = keys.map((k) => new ccc.SignerCkbPrivateKey(client, k));
  await fund(signers);
  const cfg = (await (await fetch(`${API}/api/config`)).json()) as { session: { dChallenge: string } };
  dChallenge = BigInt(cfg.session.dChallenge);
  const players = signers.map((s) => new SessionPlayer(API, s));
  const results: Result[] = [];
  let next = 0;
  await Promise.all(
    players.map(async (sp, i) => {
      for (;;) {
        const n = next++;
        if (n >= SESSIONS) return;
        const mode = Math.random() < ALONE_SHARE ? 'alone' : 'coop';
        results.push(await runSession(sp, i, n, mode));
      }
    }),
  );
  const ok = results.filter((r) => r.ok).length;
  const rounds = results.flatMap((r) => r.roundMs);
  rounds.sort((a, b) => a - b);
  const summary = {
    at: new Date().toISOString(),
    sessions: results.length,
    ok,
    rate: results.length ? ok / results.length : 0,
    coop: results.filter((r) => r.mode === 'coop').length,
    alone: results.filter((r) => r.mode === 'alone').length,
    rounds: rounds.length,
    roundMsMedian: rounds[Math.floor(rounds.length / 2)] ?? null,
    roundMsP95: rounds[Math.floor(rounds.length * 0.95)] ?? null,
    dChallenge: dChallenge.toString(),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `session-${summary.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  log('summary', JSON.stringify(summary));
  log('written', file);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
