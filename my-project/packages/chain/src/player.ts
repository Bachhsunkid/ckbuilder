// Player-side SDK: talks to the game server, checks everything the server sends,
// signs only transactions that are safe for the player, and can exit alone (path C).
// Used by the web app and the E2E harness.
import { ccc } from '@ckb-ccc/core';
import * as P from '@ckb-mines/protocol';
import {
  H,
  argsFromJson,
  argsToJson,
  betLock,
  buildExitTx,
  bytes,
  checkBetTx,
  freeCells,
  hex,
  lockHash,
  netFlow,
  receiptFromJson,
  receiptToJson,
  toJson,
  txFromJson,
  type BetArgsJson,
  type CellRef,
  type ReceiptJson,
} from './index';

/** Everything the player must keep to verify the game or exit alone. Serializable (localStorage). */
export interface GameState {
  betId: string;
  m: number;
  stake: string;
  C: string;
  picks: string[];
  args: BetArgsJson;
  houseLock: ccc.ScriptLike;
  betOutPoint?: { txHash: string; index: string };
  betTx?: string;
  opened: { t: number; safe: boolean }[];
  receipts: ReceiptJson[];
  status: 'opening' | 'open' | 'won' | 'lost' | 'exited' | 'forfeited' | 'failed';
  hit?: number;
  S?: string;
  settleTx?: string;
  paid?: string;
}

export interface ServerBet {
  id: string;
  status: string;
  betTx?: string | null;
  betOutPoint?: { txHash: string; index: string } | null;
  settleTx?: string | null;
  settlePath?: string | null;
  payout?: string | null;
  S?: string | null;
  hit?: number | null;
  openedAt?: string | null;
  tPlayEndsAt?: string | null;
  error?: string | null;
}

export interface Policy {
  /** largest exit delay the player accepts, seconds */
  maxDExit: bigint;
  /** smallest forfeit delay the player accepts, seconds */
  minDForfeit: bigint;
}

export const DEFAULT_POLICY: Policy = { maxDExit: 3600n, minDForfeit: 3600n };

function random32(): Uint8Array {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MinesPlayer {
  constructor(
    readonly api: string,
    readonly signer: ccc.Signer,
    readonly policy: Policy = DEFAULT_POLICY,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : toJson(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? text}`);
    return json as T;
  }

  async lock(): Promise<ccc.Script> {
    return (await this.signer.getRecommendedAddressObj()).script;
  }

  status(betId: string) {
    return this.call<ServerBet>('GET', `/api/bets/${betId}`);
  }

  /** Waits until the server reports one of `want`, or throws on a terminal state or timeout. */
  async waitFor(betId: string, want: string[], timeoutMs = 300_000): Promise<ServerBet> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const b = await this.status(betId);
      if (want.includes(b.status)) return b;
      if (['failed', 'expired'].includes(b.status) && !want.includes(b.status)) throw new Error(`bet ${betId} ${b.status}: ${b.error ?? ''}`);
      if (Date.now() > end) throw new Error(`timeout waiting for ${want.join('/')} (bet ${betId} is ${b.status})`);
      await sleep(2000);
    }
  }

  /** Opens a bet: seals the layout, commits our seed, checks and co-signs the bet transaction. */
  async start(m: number, stake: bigint, onProgress?: (s: string) => void): Promise<GameState> {
    const lock = await this.lock();
    const sealed = await this.call<{ id: string; R: string; houseLock: ccc.ScriptLike }>('POST', '/api/bets', {
      playerLock: lock,
      m,
      stake: stake.toString(),
    });
    onProgress?.('layout sealed');
    const C = random32();
    const picks = Array.from({ length: P.TILES }, random32);
    const Q = P.pickRoot(picks, H);
    const committed = await this.call<{ tx: unknown; args: BetArgsJson; house: { outPoint: ccc.OutPointLike; capacity: string; lock: ccc.ScriptLike } }>(
      'POST',
      `/api/bets/${sealed.id}/commit`,
      { C: hex(C), Q: hex(Q) },
    );
    const args = argsFromJson(committed.args);
    const problems: string[] = [];
    if (hex(args.R) !== sealed.R) problems.push('layout root changed after it was sealed');
    if (!P.bytesEqual(args.C, C) || !P.bytesEqual(args.Q, Q)) problems.push('server changed our commitments');
    if (args.m !== m || args.stake !== stake) problems.push('server changed mines or stake');
    if (!P.bytesEqual(args.playerLockHash, lockHash(lock))) problems.push('bet is not payable to our lock');
    if (!P.bytesEqual(args.houseLockHash, lockHash(committed.house.lock))) problems.push('house lock mismatch');
    if (args.dExit > this.policy.maxDExit || args.dForfeit < this.policy.minDForfeit || args.dExit >= args.dForfeit) {
      problems.push(`unacceptable timelocks: exit ${args.dExit}s, forfeit ${args.dForfeit}s`);
    }
    const house: CellRef = { outPoint: committed.house.outPoint, capacity: BigInt(committed.house.capacity), lock: committed.house.lock };
    const tx = txFromJson(committed.tx as object);
    problems.push(...checkBetTx(tx, { args, house, fee: 0n }));
    if (problems.length) throw new Error(`refusing to sign the bet: ${problems.join('; ')}`);

    await tx.completeFeeBy(this.signer, 1500);
    const signed = await this.signer.signTransaction(tx);
    onProgress?.('bet signed');
    const opened = await this.call<{ txHash: string }>('POST', `/api/bets/${sealed.id}/open`, { tx: signed });
    // The server broadcast it, so our client cache never saw our cells being spent.
    await this.signer.client.cache.markTransactions(signed);
    onProgress?.('bet sent');
    const state: GameState = {
      betId: sealed.id,
      m,
      stake: stake.toString(),
      C: hex(C),
      picks: picks.map(hex),
      args: argsToJson(args),
      houseLock: committed.house.lock,
      betOutPoint: { txHash: opened.txHash, index: '0' },
      betTx: opened.txHash,
      opened: [],
      receipts: [],
      status: 'opening',
    };
    await this.waitFor(sealed.id, ['open']);
    state.status = 'open';
    onProgress?.('bet confirmed');
    return state;
  }

  /** Reveals one tile. A safe answer must carry a receipt that verifies against R. */
  async reveal(state: GameState, t: number): Promise<'safe' | 'mine'> {
    if (state.status !== 'open') throw new Error(`bet is ${state.status}`);
    const picks = state.picks.map(bytes);
    const res = await this.call<{ safe: boolean; receipt?: ReceiptJson; S?: string; txHash?: string }>('POST', `/api/bets/${state.betId}/reveal`, {
      t,
      p: state.picks[t],
      proof: P.pickProof(picks, t, H).map(hex),
    });
    if (res.safe) {
      const receipt = receiptFromJson(res.receipt!);
      const args = argsFromJson(state.args);
      const all = [...state.receipts.map(receiptFromJson).filter((r) => r.t !== t), receipt];
      if (receipt.t !== t || P.checkReceipts(args, all, H) !== all.length) throw new Error('operator sent an invalid receipt');
      if (!state.opened.some((o) => o.t === t)) state.opened.push({ t, safe: true });
      if (!state.receipts.some((r) => r.t === t)) state.receipts.push(res.receipt!);
      return 'safe';
    }
    state.opened.push({ t, safe: false });
    state.hit = t;
    state.S = res.S;
    state.settleTx = res.txHash;
    state.status = 'lost';
    return 'mine';
  }

  /** Path A: asks the server for the cash-out transaction, checks our payout, co-signs it. */
  async cashOut(state: GameState): Promise<GameState> {
    const lock = await this.lock();
    const k = state.receipts.length;
    const due = P.payout(BigInt(state.stake), k, state.m).payout;
    const mine = await this.spendableCell(lock);
    const res = await this.call<{ tx: unknown }>('POST', `/api/bets/${state.betId}/cashout`, { playerCell: mine.outPoint });
    const tx = txFromJson(res.tx as object);
    if (!tx.inputs[0].previousOutput.eq(ccc.OutPoint.from(state.betOutPoint!))) throw new Error('cash-out does not spend our bet');
    if (netFlow(tx, lock) < due) throw new Error(`cash-out pays less than the rules: ${netFlow(tx, lock)} < ${due}`);
    const signed = await this.signer.signTransaction(tx);
    await this.call('POST', `/api/bets/${state.betId}/settle`, { tx: signed });
    await this.signer.client.cache.markTransactions(signed);
    const done = await this.waitFor(state.betId, ['won']);
    state.status = 'won';
    state.S = done.S ?? undefined;
    state.settleTx = done.settleTx ?? undefined;
    state.paid = due.toString();
    return state;
  }

  /** Path C: exit without the operator, using the receipts we hold. Fails until D_exit has passed. */
  async exit(state: GameState): Promise<string> {
    const client = this.signer.client;
    const lock = await this.lock();
    const args = argsFromJson(state.args);
    const live = await client.getCellLive(state.betOutPoint!, false);
    if (!live) throw new Error('bet cell is already spent');
    const mine = await this.spendableCell(lock);
    const tx = buildExitTx({
      bet: { outPoint: state.betOutPoint!, capacity: live.cellOutput.capacity, lock: betLock(args), args },
      player: mine,
      houseLock: state.houseLock,
      receipts: state.receipts.map(receiptFromJson),
    });
    const signed = await this.signer.signTransaction(tx);
    const txHash = await client.sendTransaction(signed);
    state.settleTx = txHash;
    state.status = 'exited';
    state.paid = P.payout(args.stake, state.receipts.length, args.m).payout.toString();
    return txHash;
  }

  private async spendableCell(lock: ccc.Script): Promise<CellRef> {
    const cells = await freeCells(this.signer.client, lock, 20);
    for (const c of cells) {
      if (await this.signer.client.getCellLive(c.outPoint, false)) return c;
    }
    throw new Error('need one free cell of your own (at least 61 CKB) to settle');
  }
}

export const player = { MinesPlayer, DEFAULT_POLICY };
