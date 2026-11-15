// Session transactions and state signing (ADR 0001), shared by the server, the web app and the E2E harness.
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as P from '@ckb-mines/protocol';
import * as PS from '@ckb-mines/protocol/session';
import minesSession from './mines-session.testnet.json';
import { H, OPERATOR_FEE, bytes, deployment, hex, lockHash, type CellRef } from './index';

export { PS };

export const sessionDeployment = minesSession;

export const sessionCellDeps: ccc.CellDepLike[] = [
  { outPoint: deployment.ckbJsVm.cellDep.outPoint, depType: 'code' },
  { outPoint: minesSession.outPoint, depType: 'code' },
];

const VM_PREFIX = bytes(ccc.bytesConcat('0x0000', minesSession.codeHash, ccc.hashTypeToBytes('type')));

/**
 * Smallest session cell (ADR 0001 section 7): the closing cell occupies
 * 8 capacity + 33 lock code hash/type + 147 lock args + 42 data = 230 bytes,
 * and four transitions may each take SESSION_MAX_FEE from it.
 */
export const MIN_SESSION_CAPACITY = 230n * P.SHANNONS_PER_CKB + 4n * PS.SESSION_MAX_FEE;

/** Full lock args: ckb-js-vm prefix plus the session args. The state hash binds to these bytes. */
export function sessionLockArgs(a: PS.SessionArgs): Uint8Array {
  return P.concat(VM_PREFIX, PS.encodeSessionArgs(a));
}

export function sessionLock(a: PS.SessionArgs): ccc.Script {
  return ccc.Script.from({ codeHash: deployment.ckbJsVm.codeHash, hashType: 'type', args: hex(sessionLockArgs(a)) });
}

export function decodeSessionLock(lock: ccc.ScriptLike): PS.SessionArgs | null {
  const s = ccc.Script.from(lock);
  if (s.codeHash !== deployment.ckbJsVm.codeHash || s.hashType !== 'type') return null;
  const raw = bytes(s.args);
  if (!P.bytesEqual(raw.slice(0, VM_PREFIX.length), VM_PREFIX)) return null;
  return PS.decodeSessionArgs(raw.slice(VM_PREFIX.length));
}

// ---------- keys and state signatures ----------

export const newSessionKey = (): Uint8Array => secp256k1.utils.randomSecretKey();

/** blake160 of the compressed public key: what session args store. */
export const keyHashOf = (priv: Uint8Array): Uint8Array => H(secp256k1.getPublicKey(priv, true)).slice(0, 20);

export function stateHashFor(args: PS.SessionArgs, state: Uint8Array): Uint8Array {
  return PS.stateHash(sessionLockArgs(args), state, H);
}

/** 65-byte signature in CKB order (r, s, recovery id); noble's "recovered" format puts the id first. */
export function signState(priv: Uint8Array, args: PS.SessionArgs, state: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(stateHashFor(args, state), priv, { prehash: false, format: 'recovered' });
  return P.concat(sig.slice(1), sig.slice(0, 1));
}

/** Same rule as the lock's keyHashOf, with noble instead of the VM's native secp256k1. */
export const recoverKeyHash: PS.KeyHashOf = (sig, msg) => {
  if (sig.length !== PS.SIG_LEN || sig[64] > 3 || msg.length !== 32) return null;
  try {
    const pub = secp256k1.recoverPublicKey(P.concat(sig.slice(64), sig.slice(0, 64)), msg, { prehash: false });
    return H(pub).slice(0, 20);
  } catch {
    return null;
  }
};

export function checkStateSig(sig: Uint8Array, keyHash: Uint8Array, args: PS.SessionArgs, state: Uint8Array): boolean {
  const k = recoverKeyHash(sig, stateHashFor(args, state));
  return k !== null && P.bytesEqual(k, keyHash);
}

// ---------- states ----------

export interface SignedState {
  state: Uint8Array;
  sigP: Uint8Array;
  sigH: Uint8Array;
}

/** The state that opens a round: stake from the player, collateral from the operator, into escrow. */
export function roundState(prev: PS.SessionState, game: PS.SessionGame): PS.SessionState {
  const escrow = PS.sessionEscrow(game);
  return { n: prev.n + 1n, p: prev.p - game.s, h: prev.h - (escrow - game.s), final: false, game };
}

/** The state that ends a round: `paid` (stake plus winnings, or 0 on a loss) to the player, the rest of escrow to the operator. */
export function settledState(live: PS.SessionState, paid: bigint): PS.SessionState {
  const escrow = PS.sessionEscrow(live.game);
  return { n: live.n + 1n, p: live.p + paid, h: live.h + escrow - paid, final: false, game: null };
}

export function finalState(s: PS.SessionState): PS.SessionState {
  return { n: s.n + 1n, p: s.p, h: s.h, final: true, game: null };
}

/** Why the operator refuses this round (ADR 0001 section 4.3), or null. */
export function roundProblem(s: PS.SessionState, m: number, stake: bigint): string | null {
  if (s.final) return 'session is closing';
  if (s.game) return 'a round is still active';
  if (!P.validMines(m)) return 'm must be 2, 3 or 4';
  if (stake <= 0n) return 'stake must be positive';
  if (stake > s.p) return 'stake is more than your balance';
  const rest = s.p - stake;
  if (rest !== 0n && rest < P.MIN_CELL) return 'stake would leave less than 61 CKB: bet it all or bet less';
  if (P.collateral(stake, m) > s.h) return 'the operator deposit cannot cover this stake';
  return null;
}

/** Largest stake the operator deposit covers for `m` mines. */
export const maxStakeFor = (s: PS.SessionState, m: number): bigint => {
  const byHouse = s.h / (P.binom(P.TILES, m) - 1n);
  return byHouse < s.p ? byHouse : s.p;
};

// ---------- JSON forms ----------

export interface SessionArgsJson {
  playerLockHash: string;
  houseLockHash: string;
  playerKeyHash: string;
  houseKeyHash: string;
  dChallenge: string;
}

export const sessionArgsToJson = (a: PS.SessionArgs): SessionArgsJson => ({
  playerLockHash: hex(a.playerLockHash),
  houseLockHash: hex(a.houseLockHash),
  playerKeyHash: hex(a.playerKeyHash),
  houseKeyHash: hex(a.houseKeyHash),
  dChallenge: a.dChallenge.toString(),
});

export const sessionArgsFromJson = (a: SessionArgsJson): PS.SessionArgs => ({
  playerLockHash: bytes(a.playerLockHash),
  houseLockHash: bytes(a.houseLockHash),
  playerKeyHash: bytes(a.playerKeyHash),
  houseKeyHash: bytes(a.houseKeyHash),
  dChallenge: BigInt(a.dChallenge),
});

export interface SignedStateJson {
  state: string;
  sigP: string;
  sigH: string;
}

export const signedToJson = (s: SignedState): SignedStateJson => ({ state: hex(s.state), sigP: hex(s.sigP), sigH: hex(s.sigH) });
export const signedFromJson = (s: SignedStateJson): SignedState => ({ state: bytes(s.state), sigP: bytes(s.sigP), sigH: bytes(s.sigH) });

export function mustDecodeState(b: Uint8Array | string): PS.SessionState {
  const s = PS.decodeState(typeof b === 'string' ? bytes(b) : b);
  if (!s) throw new Error('malformed session state');
  return s;
}

// ---------- transactions ----------

export interface SessionCell {
  outPoint: ccc.OutPointLike;
  capacity: bigint;
  args: PS.SessionArgs;
  /** empty while open, a closing record while closing */
  data: Uint8Array;
}

export interface Parties {
  playerLock: ccc.ScriptLike;
  houseLock: ccc.ScriptLike;
}

/**
 * Server half of the deposit: house cells pay the operator deposit. Several cells may be merged,
 * which also keeps the operator's pool from fragmenting into cells too small for a session.
 * The player then adds inputs for its deposit (plus its own change and the fee) and signs.
 */
export function buildDepositTx(o: { args: PS.SessionArgs; houses: CellRef[]; deposit: bigint; houseDeposit: bigint }): ccc.Transaction {
  const capacity = o.deposit + o.houseDeposit;
  if (capacity < MIN_SESSION_CAPACITY) throw new Error('session too small to close unilaterally');
  if (o.houses.length === 0) throw new Error('no house cell');
  for (const h of o.houses) if (!P.bytesEqual(lockHash(h.lock), o.args.houseLockHash)) throw new Error('house cell is not the house lock');
  const change = o.houses.reduce((a, h) => a + h.capacity, 0n) - o.houseDeposit;
  if (change < P.MIN_CELL) throw new Error('house cells too small for this session');
  return ccc.Transaction.from({
    inputs: o.houses.map((h) => ({ previousOutput: h.outPoint, since: 0n, cellOutput: { capacity: h.capacity, lock: h.lock }, outputData: '0x' })),
    outputs: [
      { lock: sessionLock(o.args), capacity },
      { lock: o.houses[0].lock, capacity: change },
    ],
    outputsData: ['0x', '0x'],
  });
}

/** Problems with a deposit transaction, as seen by one side; empty when it is safe to sign. */
export function checkDepositTx(tx: ccc.Transaction, o: { args: PS.SessionArgs; houses: CellRef[]; deposit: bigint; houseDeposit: bigint }): string[] {
  const errors: string[] = [];
  let expected: ccc.Transaction;
  try {
    expected = buildDepositTx(o);
  } catch (e) {
    return [(e as Error).message];
  }
  const cell = tx.outputs[0];
  if (!cell || !cell.lock.eq(expected.outputs[0].lock) || cell.capacity !== expected.outputs[0].capacity || cell.type) {
    errors.push('output 0 is not the expected session cell');
  }
  const change = tx.outputs[1];
  if (!change || !change.lock.eq(expected.outputs[1].lock) || change.capacity !== expected.outputs[1].capacity) {
    errors.push('output 1 is not the expected house change');
  }
  if (tx.outputsData[0] !== '0x' || tx.outputsData[1] !== '0x') errors.push('session and change outputs must have no data');
  for (const h of o.houses) {
    const op = ccc.OutPoint.from(h.outPoint);
    if (tx.inputs.filter((i) => i.previousOutput.eq(op)).length !== 1) errors.push('each house cell must be spent exactly once');
  }
  const session = sessionLock(o.args);
  if (tx.outputs.filter((x) => x.lock.eq(session)).length !== 1) errors.push('exactly one session cell must be created');
  return errors;
}

function sessionTx(cell: SessionCell, w: PS.SessionWitness, outputs: { lock: ccc.ScriptLike; capacity: bigint; data?: Uint8Array }[], since = 0n) {
  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: cell.outPoint,
        since,
        cellOutput: { capacity: cell.capacity, lock: sessionLock(cell.args) },
        outputData: hex(cell.data),
      },
    ],
    outputs: outputs.map((o) => ({ lock: o.lock, capacity: o.capacity })),
    outputsData: outputs.map((o) => hex(o.data ?? new Uint8Array())),
    cellDeps: sessionCellDeps,
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: hex(PS.encodeSessionWitness(w)) }));
  return tx;
}

function checkParties(args: PS.SessionArgs, parties: Parties) {
  if (!P.bytesEqual(lockHash(parties.playerLock), args.playerLockHash)) throw new Error('player lock does not match the session');
  if (!P.bytesEqual(lockHash(parties.houseLock), args.houseLockHash)) throw new Error('house lock does not match the session');
}

/** Payout outputs for a state; the fee comes out of the operator's share (ADR 0001 section 7). */
export function payoutOutputs(cell: SessionCell, parties: Parties, state: PS.SessionState, k: number, lossProven: boolean, fee = OPERATOR_FEE) {
  checkParties(cell.args, parties);
  const shares = PS.sessionShares(state, cell.capacity, k, lossProven);
  if (!shares) throw new Error('state claims more than the session holds');
  const out: { lock: ccc.ScriptLike; capacity: bigint }[] = [];
  if (shares.player > 0n) out.push({ lock: parties.playerLock, capacity: shares.player - (shares.playerPaysFee ? fee : 0n) });
  if (shares.house > 0n) out.push({ lock: parties.houseLock, capacity: shares.house - fee });
  return out;
}

export function closingOf(cell: SessionCell): PS.Closing | null {
  return cell.data.length === 0 ? null : PS.decodeClosing(cell.data);
}

/** Both sides agree to close now: one transaction pays both. Works on an open or a closing cell. */
export function buildCoopCloseTx(o: { cell: SessionCell; parties: Parties; signed: SignedState; fee?: bigint }): ccc.Transaction {
  const state = mustDecodeState(o.signed.state);
  if (!state.final) throw new Error('cooperative close needs a final state');
  return sessionTx(o.cell, { mode: 'coop', state: o.signed.state, sigP: o.signed.sigP, sigH: o.signed.sigH }, payoutOutputs(o.cell, o.parties, state, 0, false, o.fee));
}

/** Unilateral close (open cell) or a later state over a posted one (closing cell). Starts or restarts the challenge window. */
export function buildCloseTx(o: { cell: SessionCell; signed: SignedState; fee?: bigint }): ccc.Transaction {
  const state = mustDecodeState(o.signed.state);
  const closing: PS.Closing = { n: state.n, stateHash: stateHashFor(o.cell.args, o.signed.state), k: 0, lossProven: false };
  const mode = o.cell.data.length === 0 ? 'close' : 'update';
  return sessionTx(o.cell, { mode, state: o.signed.state, sigP: o.signed.sigP, sigH: o.signed.sigH }, [
    { lock: sessionLock(o.cell.args), capacity: o.cell.capacity - (o.fee ?? OPERATOR_FEE), data: PS.encodeClosing(closing) },
  ]);
}

function postedClosing(cell: SessionCell, state: Uint8Array): PS.Closing {
  const c = closingOf(cell);
  if (!c) throw new Error('session cell is not closing');
  if (!P.bytesEqual(c.stateHash, stateHashFor(cell.args, state))) throw new Error('state is not the posted one');
  return c;
}

/** Posts the player's receipts for the round in the posted state. */
export function buildSessionReceiptsTx(o: { cell: SessionCell; state: Uint8Array; receipts: P.Receipt[]; fee?: bigint }): ccc.Transaction {
  const c = postedClosing(o.cell, o.state);
  const s = mustDecodeState(o.state);
  if (!s.game) throw new Error('posted state has no round');
  const k = P.checkReceipts(PS.roundArgs(o.cell.args, s.game), o.receipts, H);
  if (k <= 0) throw new Error('receipts do not verify');
  return sessionTx(o.cell, { mode: 'receipts', state: o.state, receipts: o.receipts }, [
    { lock: sessionLock(o.cell.args), capacity: o.cell.capacity - (o.fee ?? OPERATOR_FEE), data: PS.encodeClosing({ ...c, k }) },
  ]);
}

/** Posts the operator's loss proof for the round in the posted state. */
export function buildSessionLossTx(o: { cell: SessionCell; state: Uint8Array; S: Uint8Array; t: number; p: Uint8Array; pickProof: Uint8Array[]; fee?: bigint }): ccc.Transaction {
  const c = postedClosing(o.cell, o.state);
  return sessionTx(o.cell, { mode: 'loss', state: o.state, S: o.S, t: o.t, p: o.p, pickProof: o.pickProof }, [
    { lock: sessionLock(o.cell.args), capacity: o.cell.capacity - (o.fee ?? OPERATOR_FEE), data: PS.encodeClosing({ ...c, lossProven: true }) },
  ]);
}

/** Pays the posted state once the challenge window has passed. Anyone can send it. */
export function buildSessionSettleTx(o: { cell: SessionCell; parties: Parties; state: Uint8Array; fee?: bigint }): ccc.Transaction {
  const c = postedClosing(o.cell, o.state);
  const s = mustDecodeState(o.state);
  return sessionTx(o.cell, { mode: 'settle', state: o.state }, payoutOutputs(o.cell, o.parties, s, c.k, c.lossProven, o.fee), P.SINCE_RELATIVE_TIMESTAMP | o.cell.args.dChallenge);
}

/** What the session pays each side if `state` settles as posted. */
export function sessionPayouts(cell: SessionCell, state: PS.SessionState, k: number, lossProven: boolean) {
  return PS.sessionShares(state, cell.capacity, k, lossProven);
}

// ---------- following the session cell on chain ----------

export type CellFollow =
  | { kind: 'live'; cell: SessionCell }
  | { kind: 'spent'; txHash: string; next: SessionCell | null; nextCommitted: boolean }
  | { kind: 'unknown' };

async function txSpending(client: ccc.Client, lock: ccc.Script, op: ccc.OutPoint): Promise<string | null> {
  for await (const t of client.findTransactions({ script: lock, scriptType: 'lock', scriptSearchMode: 'exact' }, 'desc', 20)) {
    if (!t.isInput) continue;
    const r = await client.getTransaction(t.txHash);
    if (r?.transaction.inputs.some((i) => i.previousOutput.eq(op))) return t.txHash;
  }
  return null;
}

/**
 * Where the session cell at `outPoint` stands. A spent cell is followed to the transaction
 * that spent it: a session output there is the next cell, none means the session paid out.
 */
export async function followSessionCell(client: ccc.Client, args: PS.SessionArgs, outPoint: ccc.OutPointLike): Promise<CellFollow> {
  const op = ccc.OutPoint.from(outPoint);
  const live = await client.getCellLive(op, true);
  if (live) return { kind: 'live', cell: { outPoint: op, capacity: live.cellOutput.capacity, args, data: bytes(live.outputData) } };
  const lock = sessionLock(args);
  const spender = await txSpending(client, lock, op);
  if (!spender) return { kind: 'unknown' };
  const r = await client.getTransaction(spender);
  if (!r) return { kind: 'unknown' };
  const idx = r.transaction.outputs.findIndex((o) => o.lock.eq(lock));
  const next =
    idx < 0
      ? null
      : { outPoint: { txHash: spender, index: BigInt(idx) }, capacity: r.transaction.outputs[idx].capacity, args, data: bytes(r.transaction.outputsData[idx]) };
  return { kind: 'spent', txHash: spender, next, nextCommitted: r.status === 'committed' };
}

/** The full state behind a closing cell, read from the witnesses of the transaction that created it. */
export async function postedState(client: ccc.Client, cell: SessionCell): Promise<Uint8Array | null> {
  const c = closingOf(cell);
  if (!c) return null;
  const r = await client.getTransaction(ccc.OutPoint.from(cell.outPoint).txHash);
  if (!r) return null;
  for (const w of r.transaction.witnesses) {
    let lock: ccc.Hex | undefined;
    try {
      lock = ccc.WitnessArgs.fromBytes(w).lock;
    } catch {
      continue;
    }
    const sw = lock ? PS.decodeSessionWitness(bytes(lock)) : null;
    if (sw && P.bytesEqual(stateHashFor(cell.args, sw.state), c.stateHash)) return sw.state;
  }
  return null;
}

/** Block time of a committed transaction, ms. */
export async function committedAt(client: ccc.Client, txHash: string): Promise<number | null> {
  const r = await client.getTransaction(txHash);
  if (r?.status !== 'committed' || !r.blockHash) return null;
  const header = await client.getHeaderByHash(r.blockHash);
  return header ? Number(header.timestamp) : null;
}
