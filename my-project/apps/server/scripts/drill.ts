// Failure drills on testnet (server running with short timelocks, e.g. D_EXIT=240 D_FORFEIT=900).
//   --mode forfeit  the player goes silent with no tiles opened; the operator must reclaim the bet via path D.
//   --mode killed   the player opens a safe tile, then the operator server is stopped (by you, when prompted);
//                   the player must exit alone via path C, and the restarted server must record that exit.
//   npx tsx scripts/drill.ts --mode forfeit
import { ccc } from '@ckb-ccc/core';
import fs from 'fs';
import path from 'path';
import { OPERATOR_FEE, P, argsFromJson, netFlow } from '@ckb-mines/chain';
import { MinesPlayer, type GameState } from '@ckb-mines/chain/player';
import { config } from '../src/config';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const MODE = arg('mode', 'forfeit');
const API = arg('api', `http://127.0.0.1:${config.port}`);
// drill players use their own key slots so they never collide with E2E players
const SLOT = Number(arg('slot', MODE === 'forfeit' ? '6' : '7'));
const KEYS = path.resolve(import.meta.dirname, '../../../.e2e-keys.json');

const client = new ccc.ClientPublicTestnet(config.rpcUrl ? { url: config.rpcUrl } : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function key(): string {
  const keys: string[] = fs.existsSync(KEYS) ? JSON.parse(fs.readFileSync(KEYS, 'utf8')) : [];
  while (keys.length <= SLOT) {
    const k = new Uint8Array(32);
    crypto.getRandomValues(k);
    keys.push(ccc.hexFrom(k));
  }
  fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2));
  return keys[SLOT];
}

async function fund(s: ccc.Signer) {
  const want = ccc.fixedPointFrom('300');
  const bal = await s.getBalance();
  if (bal >= want / 2n) return;
  const operator = new ccc.SignerCkbPrivateKey(client, config.privateKey);
  const tx = ccc.Transaction.from({ outputs: [{ lock: (await s.getRecommendedAddressObj()).script, capacity: want - bal }], outputsData: ['0x'] });
  await tx.completeInputsByCapacity(operator);
  await tx.completeFeeBy(operator, 1000);
  const hash = await operator.sendTransaction(tx);
  log('funding', hash);
  await client.waitTransaction(hash, 1, 300_000);
  await sleep(8000);
}

async function settled(hash: string) {
  const r = await client.getTransaction(hash);
  if (!r || r.status !== 'committed') throw new Error(`${hash} not committed`);
  const tx = r.transaction;
  for (const i of tx.inputs) await i.completeExtraInfos(client);
  return tx;
}

async function serverUp() {
  try {
    return (await fetch(`${API}/api/health`)).ok;
  } catch {
    return false;
  }
}

/** Like MinesPlayer.waitFor, but keeps waiting while the server is down (the drills stop it on purpose). */
async function waitStatus(mp: MinesPlayer, betId: string, want: string, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await mp.status(betId);
      if (v.status === want) return v;
    } catch {
      // server unreachable: keep waiting
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${want}`);
    await sleep(5000);
  }
}

async function forfeit(mp: MinesPlayer, lock: ccc.Script) {
  // --bet <id> resumes checking a bet that is already open
  const resume = arg('bet', '');
  let betId: string;
  let args: P.BetArgs;
  let houseLock: ccc.Script;
  if (resume) {
    const view = (await (await fetch(`${API}/api/bets/${resume}`)).json()) as { args: Parameters<typeof argsFromJson>[0] };
    betId = resume;
    args = argsFromJson(view.args);
    houseLock = ccc.Script.from((await (await fetch(`${API}/api/config`)).json()).houseLock);
  } else {
    const state = await mp.start(2, 10n * 100_000_000n);
    betId = state.betId;
    args = argsFromJson(state.args);
    houseLock = ccc.Script.from(state.houseLock);
    log('bet open', state.betId, state.betTx, `going silent; forfeit after ${args.dForfeit}s + chain clock lag`);
  }
  const v = await waitStatus(mp, betId, 'forfeited', (Number(args.dForfeit) + 900) * 1000);
  const tx = await settled(v.settleTx!);
  const capacity = P.betCapacity(args.stake, args.m);
  const house = netFlow(tx, houseLock);
  const player = netFlow(tx, lock);
  log('forfeit tx', v.settleTx, 'house +', house, 'player', player);
  if (house !== capacity - OPERATOR_FEE || player !== 0n) throw new Error(`forfeit moved the wrong amounts (house ${house}, player ${player})`);
}

async function killed(mp: MinesPlayer, lock: ccc.Script) {
  let state: GameState;
  for (;;) {
    state = await mp.start(2, 10n * 100_000_000n);
    const order = [...Array(9).keys()].sort(() => Math.random() - 0.5);
    if ((await mp.reveal(state, order[0])) === 'safe') break;
    log('hit a mine on the first tile, starting another game');
    await mp.waitFor(state.betId, ['lost']);
  }
  const args = argsFromJson(state.args);
  const view = await mp.status(state.betId);
  const exitAt = new Date(view.openedAt!).getTime() + Number(args.dExit) * 1000;
  log('bet', state.betId, 'has 1 receipt. STOP THE SERVER NOW');
  while (await serverUp()) await sleep(2000);
  log('server is down; waiting for D_exit');
  await sleep(Math.max(0, exitAt - Date.now()));
  let hash: string | undefined;
  while (!hash) {
    try {
      hash = await mp.exit(state);
    } catch (e) {
      if (!/immature|since/i.test(String(e))) log('exit retry', String(e).slice(0, 160));
      await sleep(15_000);
    }
  }
  await client.waitTransaction(hash, 1, 300_000);
  const tx = await settled(hash);
  const capacity = P.betCapacity(args.stake, args.m);
  const got = netFlow(tx, lock);
  const due = capacity - P.houseShareOnExit(capacity, args.stake, 1, args.m) - OPERATOR_FEE;
  log('exited alone', hash, 'player +', got, 'expected', due);
  if (got !== due) throw new Error('exit paid the wrong amount');
  log('START THE SERVER AGAIN');
  while (!(await serverUp())) await sleep(2000);
  const v = await waitStatus(mp, state.betId, 'exited', 180_000);
  if (v.settleTx !== hash) throw new Error(`server recorded ${v.settleTx}, chain has ${hash}`);
  log('server recorded the exit after restart', v.settleTx);
}

async function main() {
  const signer = new ccc.SignerCkbPrivateKey(client, key());
  await fund(signer);
  const cfg = await (await fetch(`${API}/api/config`)).json();
  const mp = new MinesPlayer(API, signer, { maxDExit: BigInt(cfg.dExit), minDForfeit: BigInt(cfg.dForfeit) });
  const lock = (await signer.getRecommendedAddressObj()).script;
  if (MODE === 'forfeit') await forfeit(mp, lock);
  else if (MODE === 'killed') await killed(mp, lock);
  else throw new Error(`unknown mode ${MODE}`);
  log('DRILL PASSED', MODE);
}

main().then(
  () => process.exit(0),
  (e) => {
    log('DRILL FAILED', String(e));
    process.exit(1);
  },
);
