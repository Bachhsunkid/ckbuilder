// Player side of a session (ADR 0001): one wallet signature to deposit, then rounds signed by a
// browser-held session key. Checks every state the operator signs, and can close and collect alone.
// Used by the web app and the E2E harness.
import { ccc } from '@ckb-ccc/core';
import * as P from '@ckb-mines/protocol';
import { H, bytes, hex, lockHash, receiptFromJson, toJson, txFromJson, type CellRef, type ReceiptJson } from './index';
import {
  PS,
  buildCloseTx,
  buildCoopCloseTx,
  buildSessionReceiptsTx,
  buildSessionSettleTx,
  checkDepositTx,
  checkStateSig,
  closingOf,
  committedAt,
  finalState,
  followSessionCell,
  keyHashOf,
  mustDecodeState,
  newSessionKey,
  postedState,
  roundProblem,
  roundState,
  sessionArgsFromJson,
  settledState,
  signState,
  signedFromJson,
  signedToJson,
  stateHashFor,
  type SessionArgsJson,
  type SessionCell,
  type SignedStateJson,
} from './session';

export interface RoundRecord {
  id: string;
  m: number;
  stake: string;
  R: string;
  C?: string;
  Q?: string;
  picks?: string[];
  opened: { t: number; safe: boolean }[];
  receipts: ReceiptJson[];
  status: 'sealed' | 'live' | 'won' | 'lost';
  /** the state that opened the round, signed by both: binds R, C, Q, m and the stake */
  opening?: SignedStateJson;
  S?: string;
  hit?: number;
  /** credited to the balance when the round ended (stake plus winnings, 0 on a loss) */
  paid?: string;
}

/** Everything the player must keep to play, verify, and close alone. Serializable (localStorage). */
export interface SessionRecord {
  id: string;
  /** session private key: signs states only, can never move money elsewhere than the wallet lock */
  key: string;
  args: SessionArgsJson;
  playerLock: ccc.ScriptLike;
  houseLock: ccc.ScriptLike;
  deposit: string;
  houseDeposit: string;
  depositTx?: string;
  /** the live session cell as far as we know */
  cell?: { txHash: string; index: string };
  /** newest state both sides signed */
  latest: SignedStateJson;
  /** nonce the operator may still lack our signature for */
  unacked?: string;
  round?: RoundRecord;
  rounds: RoundRecord[];
  status: 'opening' | 'open' | 'withdrawing' | 'closing' | 'closed' | 'failed';
  closeTx?: string;
  paidOut?: string;
  createdAt: number;
}

export interface SessionPolicy {
  /** longest challenge window the player accepts, seconds */
  maxDChallenge: bigint;
  /** shortest challenge window the player accepts, seconds */
  minDChallenge: bigint;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = { maxDChallenge: 172_800n, minDChallenge: 60n };

export interface ServerSession {
  id: string;
  status: string;
  n: string | null;
  p: string | null;
  h: string | null;
  cell: { txHash: string; index: string } | null;
  error?: string | null;
}

export type DefendResult =
  | { phase: 'none' | 'pending' | 'open' }
  | { phase: 'posted'; action: 'update' | 'receipts' | 'settle'; txHash: string }
  | { phase: 'challenge'; closing: PS.Closing; settleAt: number | null }
  | { phase: 'closed'; txHash: string; paid: bigint };

function random32(): Uint8Array {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SessionPlayer {
  constructor(
    readonly api: string,
    readonly signer: ccc.Signer,
    /** persists the record; called before anything irreversible */
    readonly save: (rec: SessionRecord) => void | Promise<void> = () => {},
    readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {}

  get client() {
    return this.signer.client;
  }

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

  status(id: string) {
    return this.call<ServerSession>('GET', `/api/sessions/${id}`);
  }

  // ---------- reading the record ----------

  static args(rec: SessionRecord) {
    return sessionArgsFromJson(rec.args);
  }

  static state(rec: SessionRecord): PS.SessionState {
    return mustDecodeState(rec.latest.state);
  }

  /** Balance outside the active round. */
  static balance(rec: SessionRecord): bigint {
    return SessionPlayer.state(rec).p;
  }

  private async persist(rec: SessionRecord) {
    await this.save(rec);
  }

  private async send(tx: ccc.Transaction): Promise<string> {
    try {
      return await this.client.sendTransaction(tx);
    } catch (e) {
      if (/Duplicated|already exist/i.test(String(e))) return tx.hash();
      throw e;
    }
  }

  // ---------- open ----------

  /** Deposits `deposit` (one wallet signature). The operator deposit is sized for `maxBet`. */
  async open(deposit: bigint, maxBet: bigint, onProgress?: (s: string) => void): Promise<SessionRecord> {
    const lock = (await this.signer.getRecommendedAddressObj()).script;
    const key = newSessionKey();
    const res = await this.call<{
      id: string;
      args: SessionArgsJson;
      houseLock: ccc.ScriptLike;
      houses: { outPoint: ccc.OutPointLike; capacity: string; lock: ccc.ScriptLike }[];
      houseDeposit: string;
      tx: unknown;
      sigH: string;
    }>('POST', '/api/sessions', { playerLock: lock, playerKeyHash: hex(keyHashOf(key)), deposit: deposit.toString(), maxBet: maxBet.toString() });

    const args = sessionArgsFromJson(res.args);
    const houseDeposit = BigInt(res.houseDeposit);
    const houses: CellRef[] = res.houses.map((h) => ({ outPoint: h.outPoint, capacity: BigInt(h.capacity), lock: h.lock }));
    const state0 = PS.encodeState({ n: 0n, p: deposit, h: houseDeposit, final: false, game: null });
    const problems: string[] = [];
    if (!P.bytesEqual(args.playerLockHash, lockHash(lock))) problems.push('session does not pay our wallet');
    if (!P.bytesEqual(args.playerKeyHash, keyHashOf(key))) problems.push('session is not bound to our session key');
    if (!P.bytesEqual(args.houseLockHash, lockHash(res.houseLock))) problems.push('house lock mismatch');
    if (args.dChallenge > this.policy.maxDChallenge || args.dChallenge < this.policy.minDChallenge) problems.push(`unacceptable challenge window ${args.dChallenge}s`);
    if (!checkStateSig(bytes(res.sigH), args.houseKeyHash, args, state0)) problems.push('operator did not sign the opening state');
    const tx = txFromJson(res.tx as object);
    problems.push(...checkDepositTx(tx, { args, houses, deposit, houseDeposit }));
    if (problems.length) throw new Error(`refusing the session: ${problems.join('; ')}`);
    onProgress?.('session terms checked');

    const sigP = signState(key, args, state0);
    await tx.completeFeeBy(this.signer, 1500);
    const signed = await this.signer.signTransaction(tx);
    const txHash = signed.hash();
    const rec: SessionRecord = {
      id: res.id,
      key: hex(key),
      args: res.args,
      playerLock: lock,
      houseLock: res.houseLock,
      deposit: deposit.toString(),
      houseDeposit: res.houseDeposit,
      depositTx: txHash,
      cell: { txHash, index: '0' },
      latest: signedToJson({ state: state0, sigP, sigH: bytes(res.sigH) }),
      rounds: [],
      status: 'opening',
      createdAt: Date.now(),
    };
    // keep the key and the signed opening state before the deposit can land: they are how we close alone
    await this.persist(rec);
    onProgress?.('deposit signed');
    await this.call('POST', `/api/sessions/${rec.id}/open`, { tx: signed, sigP: hex(sigP) });
    await this.client.cache.markTransactions(signed);
    onProgress?.('deposit sent');
    await this.waitOpen(rec);
    onProgress?.('session open');
    return rec;
  }

  async waitOpen(rec: SessionRecord, timeoutMs = 300_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      // the chain can commit the deposit before the operator's watcher sees it, and rounds need
      // the operator to have seen it; without the operator we only need the chain
      const r = await this.client.getTransaction(rec.depositTx!);
      const s = await this.status(rec.id).catch(() => null);
      if (r?.status === 'committed' && (s === null || s.status !== 'opening')) {
        rec.status = 'open';
        await this.persist(rec);
        return;
      }
      if (s && ['failed', 'expired'].includes(s.status)) {
        rec.status = 'failed';
        await this.persist(rec);
        throw new Error(`session ${rec.id} ${s.status}: ${s.error ?? ''}`);
      }
      if (Date.now() > end) throw new Error('timeout waiting for the deposit to commit');
      await sleep(3000);
    }
  }

  // ---------- rounds ----------

  private async ack(rec: SessionRecord) {
    if (rec.unacked === undefined) return;
    const latest = signedFromJson(rec.latest);
    await this.call('POST', `/api/sessions/${rec.id}/ack`, { n: rec.unacked, sigP: hex(latest.sigP) });
    rec.unacked = undefined;
    await this.persist(rec);
  }

  /** Starts a round: the operator seals a layout, we commit our seed and picks, both sign the round state. */
  async startRound(rec: SessionRecord, m: number, stake: bigint): Promise<RoundRecord> {
    if (rec.status !== 'open') throw new Error(`session is ${rec.status}`);
    await this.ack(rec);
    const prev = SessionPlayer.state(rec);
    const problem = roundProblem(prev, m, stake);
    if (problem) throw new Error(problem);
    const args = SessionPlayer.args(rec);
    const key = bytes(rec.key);

    const sealed = await this.call<{ roundId: string; R: string }>('POST', `/api/sessions/${rec.id}/rounds`, { m, stake: stake.toString() });
    const C = random32();
    const picks = Array.from({ length: P.TILES }, random32);
    const Q = P.pickRoot(picks, H);
    const next = PS.encodeState(roundState(prev, { R: bytes(sealed.R), C, Q, m, s: stake }));
    const sigP = signState(key, args, next);
    const round: RoundRecord = {
      id: sealed.roundId,
      m,
      stake: stake.toString(),
      R: sealed.R,
      C: hex(C),
      Q: hex(Q),
      picks: picks.map(hex),
      opened: [],
      receipts: [],
      status: 'sealed',
    };
    rec.round = round;
    await this.persist(rec);
    const res = await this.call<{ sigH: string }>('POST', `/api/sessions/${rec.id}/rounds/${round.id}/commit`, { C: hex(C), Q: hex(Q), sigP: hex(sigP) });
    if (!checkStateSig(bytes(res.sigH), args.houseKeyHash, args, next)) throw new Error('operator signature on the round state is invalid');
    rec.latest = signedToJson({ state: next, sigP, sigH: bytes(res.sigH) });
    round.opening = rec.latest;
    round.status = 'live';
    await this.persist(rec);
    return round;
  }

  /** Opens one tile. A safe answer must carry a receipt; a mine must come with a seed that proves it. */
  async reveal(rec: SessionRecord, t: number): Promise<'safe' | 'mine'> {
    const round = rec.round;
    if (!round || round.status !== 'live') throw new Error('no live round');
    const args = SessionPlayer.args(rec);
    const live = SessionPlayer.state(rec);
    const picks = round.picks!.map(bytes);
    const res = await this.call<{ safe: boolean; receipt?: ReceiptJson; S?: string; sigH?: string }>('POST', `/api/sessions/${rec.id}/rounds/${round.id}/reveal`, {
      t,
      p: round.picks![t],
      proof: P.pickProof(picks, t, H).map(hex),
    });
    const ra = PS.roundArgs(args, live.game!);
    if (res.safe) {
      const receipt = receiptFromJson(res.receipt!);
      const all = [...round.receipts.map(receiptFromJson).filter((r) => r.t !== t), receipt];
      if (receipt.t !== t || P.checkReceipts(ra, all, H) !== all.length) throw new Error('operator sent an invalid receipt');
      if (!round.opened.some((o) => o.t === t)) round.opened.push({ t, safe: true });
      if (!round.receipts.some((r) => r.t === t)) round.receipts.push(res.receipt!);
      await this.persist(rec);
      return 'safe';
    }
    const S = bytes(res.S!);
    const layout = P.buildLayout(S, round.m, H);
    if (!P.bytesEqual(layout.root, ra.R)) throw new Error('operator seed does not match the sealed layout');
    if (layout.states[P.tileMap(ra.C, H)[t]] === 0) throw new Error('operator claims a mine on a safe tile');
    await this.endRound(rec, settledState(live, 0n), bytes(res.sigH!), { status: 'lost', S: res.S!, hit: t, paid: '0' });
    round.opened.push({ t, safe: false });
    await this.persist(rec);
    return 'mine';
  }

  /** Ends the round with the receipts we hold. Instant: the win moves into the balance off-chain. */
  async cashOut(rec: SessionRecord): Promise<bigint> {
    const round = rec.round;
    if (!round || round.status !== 'live') throw new Error('no live round');
    const live = SessionPlayer.state(rec);
    const k = round.receipts.length;
    const res = await this.call<{ k: number; S: string; sigH: string }>('POST', `/api/sessions/${rec.id}/rounds/${round.id}/cashout`, { k });
    if (res.k !== k) throw new Error(`operator counts ${res.k} safe tiles, we hold ${k} receipts`);
    if (!P.bytesEqual(P.buildLayout(bytes(res.S), round.m, H).root, live.game!.R)) throw new Error('operator seed does not match the sealed layout');
    const paid = P.payout(BigInt(round.stake), k, round.m).payout;
    await this.endRound(rec, settledState(live, paid), bytes(res.sigH), { status: 'won', S: res.S, paid: paid.toString() });
    return paid;
  }

  private async endRound(rec: SessionRecord, next: PS.SessionState, sigH: Uint8Array, result: Partial<RoundRecord>) {
    const args = SessionPlayer.args(rec);
    const enc = PS.encodeState(next);
    if (!checkStateSig(sigH, args.houseKeyHash, args, enc)) throw new Error('operator signature on the settled round is invalid');
    const sigP = signState(bytes(rec.key), args, enc);
    Object.assign(rec.round!, result);
    rec.latest = signedToJson({ state: enc, sigP, sigH });
    rec.unacked = next.n.toString();
    rec.rounds.unshift(rec.round!);
    await this.persist(rec);
    // the operator may miss this; startRound and withdraw retry it
    await this.ack(rec).catch(() => undefined);
  }

  // ---------- closing ----------

  private async liveCell(rec: SessionRecord): Promise<SessionCell> {
    const args = SessionPlayer.args(rec);
    const live = await this.client.getCellLive(rec.cell!, true);
    if (!live) throw new Error('session cell is not live (closing or closed); use defend()');
    return { outPoint: rec.cell!, capacity: live.cellOutput.capacity, args, data: bytes(live.outputData) };
  }

  /** Withdraw with the operator: both sign a final state and one transaction pays both sides now. */
  async withdraw(rec: SessionRecord): Promise<string> {
    if (rec.status !== 'open') throw new Error(`session is ${rec.status}`);
    await this.ack(rec);
    const prev = SessionPlayer.state(rec);
    if (prev.game) throw new Error('finish the round first');
    const args = SessionPlayer.args(rec);
    const fin = PS.encodeState(finalState(prev));
    const sigP = signState(bytes(rec.key), args, fin);
    const res = await this.call<{ sigH: string; txHash: string }>('POST', `/api/sessions/${rec.id}/withdraw`, { sigP: hex(sigP) });
    if (!checkStateSig(bytes(res.sigH), args.houseKeyHash, args, fin)) throw new Error('operator signature on the final state is invalid');
    rec.latest = signedToJson({ state: fin, sigP, sigH: bytes(res.sigH) });
    rec.status = 'withdrawing';
    await this.persist(rec);
    // build it ourselves too: we hold a final state both signed, so nobody can stop this payout
    const tx = buildCoopCloseTx({ cell: await this.liveCell(rec), parties: rec, signed: signedFromJson(rec.latest) });
    rec.closeTx = tx.hash() === res.txHash ? res.txHash : await this.send(tx);
    await this.persist(rec);
    return rec.closeTx;
  }

  /** Close without the operator: posts our latest state on chain and starts the challenge window. */
  async closeAlone(rec: SessionRecord): Promise<string> {
    const cell = await this.liveCell(rec);
    if (cell.data.length !== 0) throw new Error('already closing; use defend()');
    const txHash = await this.send(buildCloseTx({ cell, signed: signedFromJson(rec.latest) }));
    rec.status = 'closing';
    rec.closeTx = txHash;
    await this.persist(rec);
    return txHash;
  }

  /**
   * Looks at the session cell and does what protects us: posts a later state over a stale one,
   * posts our receipts, and collects once the challenge window has passed. Call on every load.
   */
  async defend(rec: SessionRecord, now = Date.now()): Promise<DefendResult> {
    if (!rec.cell || rec.status === 'closed' || rec.status === 'failed') return { phase: 'none' };
    const args = SessionPlayer.args(rec);
    let f = await followSessionCell(this.client, args, rec.cell);
    while (f.kind === 'spent' && f.next) {
      if (!f.nextCommitted) return { phase: 'pending' };
      rec.cell = { txHash: ccc.hexFrom(ccc.OutPoint.from(f.next.outPoint).txHash), index: ccc.OutPoint.from(f.next.outPoint).index.toString() };
      f = await followSessionCell(this.client, args, rec.cell);
    }
    if (f.kind === 'unknown') return { phase: 'pending' };
    if (f.kind === 'spent') {
      const r = await this.client.getTransaction(f.txHash);
      const mine = ccc.Script.from(rec.playerLock);
      const paid = r ? r.transaction.outputs.filter((o) => o.lock.eq(mine)).reduce((a, o) => a + o.capacity, 0n) : 0n;
      rec.status = 'closed';
      rec.closeTx = f.txHash;
      rec.paidOut = paid.toString();
      await this.persist(rec);
      return { phase: 'closed', txHash: f.txHash, paid };
    }
    const cell = f.cell;
    const closing = closingOf(cell);
    if (!closing) return { phase: 'open' };
    if (rec.status !== 'closing') {
      rec.status = 'closing';
      await this.persist(rec);
    }

    const latest = signedFromJson(rec.latest);
    const ours = mustDecodeState(latest.state);
    if (ours.n > closing.n) {
      return { phase: 'posted', action: 'update', txHash: await this.send(buildCloseTx({ cell, signed: latest })) };
    }
    const postedIsOurs = P.bytesEqual(closing.stateHash, stateHashFor(args, latest.state));
    const round = rec.round;
    if (postedIsOurs && ours.game && round && round.status === 'live' && round.receipts.length > 0 && closing.k === 0 && !closing.lossProven) {
      const tx = buildSessionReceiptsTx({ cell, state: latest.state, receipts: round.receipts.map(receiptFromJson) });
      return { phase: 'posted', action: 'receipts', txHash: await this.send(tx) };
    }
    const since = await committedAt(this.client, ccc.OutPoint.from(cell.outPoint).txHash);
    const settleAt = since === null ? null : since + Number(args.dChallenge) * 1000;
    if (settleAt === null || now < settleAt) return { phase: 'challenge', closing, settleAt };
    // a posted state we never got the operator's signature for is still in the closing tx's witness
    const state = postedIsOurs ? latest.state : await postedState(this.client, cell);
    if (!state) return { phase: 'challenge', closing, settleAt };
    try {
      const tx = buildSessionSettleTx({ cell, parties: rec, state });
      return { phase: 'posted', action: 'settle', txHash: await this.send(tx) };
    } catch (e) {
      // block median time lags the wall clock by a few minutes; try again later
      if (/Immature|since/i.test(String(e))) return { phase: 'challenge', closing, settleAt };
      throw e;
    }
  }
}

export const sessionPlayer = { SessionPlayer, DEFAULT_SESSION_POLICY };
