// End-to-end reliability run on CKB testnet: real players, real transactions, every path.
// A game counts as a success only if it settles on-chain, the player receives exactly
// what the rules say, the server records the right outcome, and the five Verify checks pass.
//
// Usage (server running with short timelocks, e.g. T_PLAY=90 D_EXIT=240 D_FORFEIT=900):
//   npx tsx scripts/e2e.ts --games 40 --players 4 --exit-share 0.15
import { ccc } from '@ckb-ccc/core';
import fs from 'fs';
import path from 'path';
import { H, OPERATOR_FEE, P, argsFromJson, bytes, netFlow, receiptFromJson } from '@ckb-mines/chain';
import { MinesPlayer, type GameState } from '@ckb-mines/chain/player';
import { config } from '../src/config';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const GAMES = Number(arg('games', '8'));
const PLAYERS = Number(arg('players', '2'));
const EXIT_SHARE = Number(arg('exit-share', '0.15'));
const API = arg('api', `http://127.0.0.1:${config.port}`);
const FUND = ccc.fixedPointFrom(arg('fund', '700'));
const KEYS = path.resolve(import.meta.dirname, '../../../.e2e-keys.json');
const OUT_DIR = path.resolve(import.meta.dirname, '../../../e2e-results');

const client = new ccc.ClientPublicTestnet(config.rpcUrl ? { url: config.rpcUrl } : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rnd = (n: number) => Math.floor(Math.random() * n);

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
    if (bal < FUND / 2n) outputs.push({ lock: (await s.getRecommendedAddressObj()).script, capacity: FUND - bal });
  }
  if (!outputs.length) return;
  const tx = ccc.Transaction.from({ outputs, outputsData: outputs.map(() => '0x') });
  await tx.completeInputsByCapacity(operator);
  await tx.completeFeeBy(operator, 1000);
  const hash = await operator.sendTransaction(tx);
  log('funding', outputs.length, 'players', hash);
  await client.waitTransaction(hash, 1, 300_000);
  await sleep(8000); // let the indexer catch up
}

interface Result {
  player: number;
  game: number;
  betId?: string;
  m?: number;
  stake?: string;
  strategy: 'cashout' | 'exit';
  outcome?: string;
  k?: number;
  expected?: string;
  received?: string;
  ok: boolean;
  reason?: string;
  seconds: number;
  settleTx?: string;
}

async function settledTx(hash: string): Promise<ccc.Transaction> {
  const r = await client.getTransaction(hash);
  if (!r || r.status !== 'committed') throw new Error(`settle tx ${hash} is ${r?.status}`);
  const tx = r.transaction;
  for (const i of tx.inputs) await i.completeExtraInfos(client);
  return tx;
}

async function playOne(pi: number, gi: number, mp: MinesPlayer): Promise<Result> {
  const t0 = Date.now();
  const m = 2 + rnd(3);
  const maxStake = Number(config.maxCollateral / (P.binom(9, m) - 1n) / P.SHANNONS_PER_CKB);
  const stake = BigInt(10 + rnd(Math.min(maxStake, 20) - 9)) * P.SHANNONS_PER_CKB;
  const strategy: Result['strategy'] = Math.random() < EXIT_SHARE ? 'exit' : 'cashout';
  const res: Result = { player: pi, game: gi, m, stake: stake.toString(), strategy, ok: false, seconds: 0 };
  const lock = await mp.lock();
  let state: GameState | undefined;
  try {
    state = await mp.start(m, stake);
    res.betId = state.betId;
    const order = [...Array(9).keys()].sort(() => Math.random() - 0.5);
    // short targets so cash-outs and exits actually happen; losses still cover path B
    const target = strategy === 'exit' ? rnd(3) : 1 + rnd(2);
    let hitMine = false;
    for (const t of order.slice(0, target)) {
      if ((await mp.reveal(state, t)) === 'mine') {
        hitMine = true;
        break;
      }
    }
    const k = state.receipts.length;
    res.k = k;
    const args = argsFromJson(state.args);
    const capacity = P.betCapacity(stake, m);
    let paid: bigint;
    if (hitMine) {
      const v = await mp.waitFor(state.betId, ['lost']);
      const tx = await settledTx(v.settleTx!);
      if (netFlow(tx, lock) !== 0n) throw new Error('player lock moved in a loss');
      res.outcome = 'lost';
      res.expected = '0';
      res.received = '0';
      paid = 0n;
      res.settleTx = v.settleTx!;
    } else if (strategy === 'cashout') {
      await mp.cashOut(state);
      const v = await mp.status(state.betId);
      const tx = await settledTx(v.settleTx!);
      const due = P.payout(stake, k, m).payout;
      const got = netFlow(tx, lock);
      res.outcome = 'won';
      res.expected = due.toString();
      res.received = got.toString();
      res.settleTx = v.settleTx!;
      if (got !== due) throw new Error(`cash-out paid ${got}, rules say ${due}`);
      paid = got;
    } else {
      // go silent, then exit alone once D_exit has passed (relative since uses median block time, so retry)
      const v0 = await mp.status(state.betId);
      const exitAt = new Date(v0.openedAt!).getTime() + Number(args.dExit) * 1000;
      await sleep(Math.max(0, exitAt - Date.now()));
      let hash: string | undefined;
      const deadline = Date.now() + 20 * 60_000;
      while (!hash) {
        try {
          hash = await mp.exit(state);
        } catch (e) {
          if (Date.now() > deadline) throw e;
          if (!/Immature|immature|since/i.test(String(e))) log('exit retry', String(e).slice(0, 160));
          await sleep(15_000);
        }
      }
      await client.waitTransaction(hash, 1, 300_000);
      const tx = await settledTx(hash);
      const due = P.payout(stake, k, m).payout;
      const houseDue = P.houseShareOnExit(capacity, stake, k, m);
      const got = netFlow(tx, lock);
      res.outcome = 'exited';
      res.expected = (capacity - houseDue - OPERATOR_FEE).toString();
      res.received = got.toString();
      res.settleTx = hash;
      if (got !== capacity - houseDue - OPERATOR_FEE || got + OPERATOR_FEE < due) throw new Error(`exit paid ${got}`);
      const v = await mp.waitFor(state.betId, ['exited'], 120_000);
      if (v.settleTx !== hash) throw new Error(`server recorded exit tx ${v.settleTx}, chain has ${hash}`);
      paid = got + OPERATOR_FEE;
    }

    // the five Verify checks with the seed the server publishes after settlement
    const view = await mp.status(state.betId);
    if (!view.S) throw new Error('server did not publish the seed after settlement');
    const record: P.GameRecord = {
      args,
      S: bytes(view.S),
      picks: state.opened.map((o) => o.t),
      pickSecrets: state.picks.map(bytes),
      receipts: state.receipts.map(receiptFromJson),
      outcome: res.outcome === 'lost' ? 'lost' : res.outcome === 'won' ? 'won' : 'exit',
      hit: state.hit,
      paid,
    };
    const failed = P.verifyGame(record, H).filter((c) => !c.ok);
    if (failed.length) throw new Error(`verify failed: ${failed.map((c) => c.name).join(', ')}`);
    res.ok = true;
  } catch (e) {
    res.reason = String(e).slice(0, 400);
  }
  res.seconds = Math.round((Date.now() - t0) / 1000);
  log(`p${pi} g${gi}`, res.ok ? 'OK  ' : 'FAIL', res.strategy, res.outcome ?? '-', `m=${m} k=${res.k ?? '-'} ${res.seconds}s`, res.reason ?? '');
  return res;
}

async function main() {
  const keys = loadKeys(PLAYERS);
  const signers = keys.map((k) => new ccc.SignerCkbPrivateKey(client, k));
  await fund(signers);
  const cfg = await (await fetch(`${API}/api/config`)).json();
  log('server config', cfg.tPlay, cfg.dExit, cfg.dForfeit);
  const policy = { maxDExit: BigInt(cfg.dExit), minDForfeit: BigInt(cfg.dForfeit) };
  const players = signers.map((s) => new MinesPlayer(API, s, policy));
  const results: Result[] = [];
  let next = 0;
  await Promise.all(
    players.map(async (mp, pi) => {
      await sleep(pi * 3000);
      while (next < GAMES) {
        const gi = next++;
        results.push(await playOne(pi, gi, mp));
        await sleep(6000); // indexer catch-up for this player's new change cell
      }
    }),
  );
  const ok = results.filter((r) => r.ok).length;
  const byOutcome: Record<string, string> = {};
  for (const o of ['won', 'lost', 'exited']) {
    const rs = results.filter((r) => r.outcome === o);
    byOutcome[o] = `${rs.filter((r) => r.ok).length}/${rs.length}`;
  }
  const summary = { games: results.length, ok, rate: results.length ? ok / results.length : 0, byOutcome, finishedAt: new Date().toISOString() };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `run-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(summary);
  console.log('details:', file);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
