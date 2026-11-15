// Session failure drills on testnet (ADR 0001 section 11, step 7). Server running with a short window, e.g. D_CHALLENGE=120.
//   --mode stale-player  the player loses some rounds, then posts its opening state (where it had more).
//                        The operator must answer with the latest state; the payout is the latest balance.
//   --mode stale-house   the player wins, then someone posts the opening state (where the operator had more).
//                        Run with the operator server STOPPED: the player's own defend() must post the later state and collect.
//   --mode loss          the player hits a mine, refuses to sign the loss, and closes on the round state with its receipts.
//                        The operator must post the loss proof; the player gets only its balance outside the round.
//   --mode killed        the player opens safe tiles, then the operator server is stopped (by you, when prompted).
//                        The player closes alone, posts receipts, collects; the restarted server records the close.
//   npx tsx scripts/session-drill.ts --mode loss
import { ccc } from '@ckb-ccc/core';
import fs from 'fs';
import path from 'path';
import { P } from '@ckb-mines/chain';
import {
  buildCloseTx,
  buildSessionReceiptsTx,
  closingOf,
  followSessionCell,
  maxStakeFor,
  mustDecodeState,
  sessionArgsFromJson,
  signedFromJson,
  type SessionCell,
} from '@ckb-mines/chain/session';
import { SessionPlayer, type SessionRecord } from '@ckb-mines/chain/session-player';
import { receiptFromJson } from '@ckb-mines/chain';
import { config } from '../src/config';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const MODE = arg('mode', 'loss');
const API = arg('api', `http://127.0.0.1:${config.port}`);
const SLOTS: Record<string, number> = { 'stale-player': 8, 'stale-house': 9, loss: 10, killed: 11 };
const SLOT = Number(arg('slot', String(SLOTS[MODE] ?? 12)));
const KEYS = path.resolve(import.meta.dirname, '../../../.e2e-keys.json');
const OUT_DIR = path.resolve(import.meta.dirname, '../../../e2e-results');
const CKB = P.SHANNONS_PER_CKB;
const DEPOSIT = 150n * CKB;

const client = new ccc.ClientPublicTestnet(config.rpcUrl ? { url: config.rpcUrl } : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function key(slot: number): string {
  const keys: string[] = fs.existsSync(KEYS) ? JSON.parse(fs.readFileSync(KEYS, 'utf8')) : [];
  while (keys.length <= slot) {
    const k = new Uint8Array(32);
    crypto.getRandomValues(k);
    keys.push(ccc.hexFrom(k));
  }
  fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2));
  return keys[slot];
}

async function fund(signer: ccc.SignerCkbPrivateKey) {
  const bal = await signer.getBalance();
  if (bal >= 300n * CKB) return;
  const operator = new ccc.SignerCkbPrivateKey(client, config.privateKey);
  // the running server spends operator cells too (deposits); a conflict means wait for the indexer and retry
  let hash: string | undefined;
  for (let attempt = 0; !hash; attempt++) {
    try {
      const tx = ccc.Transaction.from({ outputs: [{ lock: (await signer.getRecommendedAddressObj()).script, capacity: 350n * CKB - bal }], outputsData: ['0x'] });
      await tx.completeInputsByCapacity(operator);
      await tx.completeFeeBy(operator, 1000);
      hash = await operator.sendTransaction(tx);
    } catch (e) {
      if (attempt >= 10) throw e;
      log('funding conflict, retrying', String(e).slice(0, 80));
      await sleep(20_000);
    }
  }
  log('funding', hash);
  await client.waitTransaction(hash, 1, 300_000);
  await sleep(8000);
}

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${API}/api/health`)).ok;
  } catch {
    return false;
  }
}

/** One round on `m` mines: open up to `target` tiles, then bank. Returns 'won' or 'lost'. */
async function round(sp: SessionPlayer, rec: SessionRecord, m: number, target: number, bank = true): Promise<'won' | 'lost' | 'live'> {
  const st = SessionPlayer.state(rec);
  let stake = maxStakeFor(st, m);
  if (stake > 10n * CKB) stake = 10n * CKB;
  await sp.startRound(rec, m, stake);
  for (let t = 0, k = 0; t < 9 && k < target; t++) {
    if ((await sp.reveal(rec, t)) === 'mine') return 'lost';
    k++;
  }
  if (!bank) return 'live';
  await sp.cashOut(rec);
  return 'won';
}

async function cellOf(rec: SessionRecord): Promise<SessionCell> {
  const args = sessionArgsFromJson(rec.args);
  for (let i = 0; i < 60; i++) {
    const f = await followSessionCell(client, args, rec.cell!);
    if (f.kind === 'live') return f.cell;
    if (f.kind === 'spent' && f.next && f.nextCommitted) {
      rec.cell = { txHash: ccc.OutPoint.from(f.next.outPoint).txHash, index: ccc.OutPoint.from(f.next.outPoint).index.toString() };
      continue;
    }
    await sleep(5000);
  }
  throw new Error('session cell not found');
}

/** Watches the chain (not the SDK) until the session pays out; returns what the player got. */
async function untilPaid(rec: SessionRecord, timeoutMs: number, defend?: SessionPlayer): Promise<{ txHash: string; paid: bigint; trail: string[] }> {
  const args = sessionArgsFromJson(rec.args);
  const trail: string[] = [];
  const end = Date.now() + timeoutMs;
  let op = rec.cell!;
  for (;;) {
    if (defend) {
      const d = await defend.defend(rec).catch((e) => ({ phase: `error ${String(e).slice(0, 100)}` }));
      if ('action' in d) log('  player defend:', d.action, d.txHash);
    }
    const f = await followSessionCell(client, args, op);
    if (f.kind === 'spent' && f.next && f.nextCommitted) {
      const c = closingOf(f.next)!;
      const note = `${f.txHash} -> closing n=${c.n} k=${c.k} lossProven=${c.lossProven}`;
      trail.push(note);
      log('  chain:', note);
      op = { txHash: ccc.OutPoint.from(f.next.outPoint).txHash, index: '0' };
      if (!defend) rec.cell = op;
      continue;
    }
    if (f.kind === 'spent' && !f.next) {
      const r = await client.getTransaction(f.txHash);
      if (r?.status === 'committed') {
        const mine = ccc.Script.from(rec.playerLock);
        const paid = r.transaction.outputs.filter((o) => o.lock.eq(mine)).reduce((a, o) => a + o.capacity, 0n);
        trail.push(`${f.txHash} -> paid out`);
        return { txHash: f.txHash, paid, trail };
      }
    }
    if (Date.now() > end) throw new Error(`timeout; trail ${trail.join(' | ')}`);
    await sleep(10_000);
  }
}

async function main() {
  const signer = new ccc.SignerCkbPrivateKey(client, key(SLOT));
  await fund(signer);
  const sp = new SessionPlayer(API, signer);
  const t0 = Date.now();
  let rec: SessionRecord | undefined;
  for (let attempt = 0; !rec; attempt++) {
    try {
      rec = await sp.open(DEPOSIT, 10n * CKB);
    } catch (e) {
      // every house cell backs another session; wait for one to free up
      if (!/ 503 /.test(String(e)) || attempt >= 20) throw e;
      await sleep(30_000);
    }
  }
  const opening = rec.latest;
  log(MODE, 'session', rec.id);
  const window = Number(sessionArgsFromJson(rec.args).dChallenge) * 1000;
  let expected: bigint;
  let result: { txHash: string; paid: bigint; trail: string[] };

  if (MODE === 'stale-player' || MODE === 'stale-house') {
    const wantMore = MODE === 'stale-house';
    // play until the balance moved the way the drill needs
    for (let i = 0; i < 30; i++) {
      const p = SessionPlayer.balance(rec);
      if (wantMore ? p > DEPOSIT : p < DEPOSIT) break;
      await round(sp, rec, wantMore ? 2 : 4, 1);
    }
    expected = SessionPlayer.balance(rec);
    log('latest balance', ccc.fixedPointToString(expected), 'state', SessionPlayer.state(rec).n, '; posting the opening state (balance 150)');
    if (MODE === 'stale-house') {
      log('stop the operator server now (it would defend too); waiting…');
      while (await serverUp()) await sleep(3000);
    }
    const cell = await cellOf(rec);
    const stale = await client.sendTransaction(buildCloseTx({ cell, signed: signedFromJson(opening) }));
    log('stale close sent', stale);
    result = await untilPaid(rec, window * 4 + 900_000, MODE === 'stale-house' ? sp : undefined);
  } else if (MODE === 'loss') {
    // find a mine on Hard while holding receipts; never sign the loss
    // sign every other result as usual; refuse only the loss we want to dispute
    const hooked = sp as unknown as { ack: (r: SessionRecord) => Promise<void> };
    const realAck = hooked.ack.bind(sp);
    hooked.ack = async (r) => {
      if (r.round?.status === 'lost' && r.round.receipts.length > 0) return;
      return realAck(r);
    };
    let r: string;
    do {
      r = await round(sp, rec, 4, 3, false);
      if (r === 'live') await sp.cashOut(rec);
    } while (r !== 'lost' || (rec.round?.receipts.length ?? 0) === 0);
    const lost = rec.round!;
    const roundState = mustDecodeState(lost.opening!.state);
    expected = roundState.p;
    log(`hit a mine after ${lost.receipts.length} safe tiles; closing on the round state n=${roundState.n} with receipts instead of signing the loss`);
    const cell = await cellOf(rec);
    const close = await client.sendTransaction(buildCloseTx({ cell, signed: signedFromJson(lost.opening!) }));
    log('close sent', close);
    // post our receipts as soon as the closing cell lands
    for (;;) {
      const c = await cellOf(rec);
      if (c.data.length > 0) {
        const tx = buildSessionReceiptsTx({ cell: c, state: signedFromJson(lost.opening!).state, receipts: lost.receipts.map(receiptFromJson) });
        log('receipts sent', await client.sendTransaction(tx));
        break;
      }
      await sleep(5000);
    }
    result = await untilPaid(rec, window * 4 + 900_000);
  } else if (MODE === 'killed') {
    let r: string;
    do {
      r = await round(sp, rec, 2, 2, false);
    } while (r !== 'live');
    const live = SessionPlayer.state(rec);
    const k = rec.round!.receipts.length;
    expected = live.p + P.payout(live.game!.s, k, live.game!.m).payout;
    log(`round live with ${k} receipts. Stop the operator server now; waiting…`);
    while (await serverUp()) await sleep(3000);
    log('server is down; closing alone');
    await sp.closeAlone(rec);
    result = await untilPaid(rec, window * 4 + 900_000, sp);
    log('now restart the server; waiting for it to record the close…');
  } else {
    throw new Error(`unknown mode ${MODE}`);
  }

  const problems: string[] = [];
  if (result.paid !== expected) problems.push(`paid ${result.paid} != expected ${expected}`);
  let serverStatus = 'down';
  let serverPaid: string | null = null;
  for (let i = 0; i < 120; i++) {
    const v = await sp.status(rec.id).catch(() => null);
    if (v) {
      serverStatus = v.status;
      serverPaid = (v as unknown as { paidPlayer: string | null }).paidPlayer;
      if (v.status === 'closed') break;
    }
    await sleep(5000);
  }
  if (serverStatus !== 'closed') problems.push(`server says ${serverStatus}`);
  else if (serverPaid !== expected.toString()) problems.push(`server recorded ${serverPaid}`);
  const out = { mode: MODE, session: rec.id, ok: problems.length === 0, problems, expected: expected.toString(), paid: result.paid.toString(), trail: result.trail, payTx: result.txHash, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `session-drill-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 2));
  log(out.ok ? 'DRILL PASSED' : 'DRILL FAILED', JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
