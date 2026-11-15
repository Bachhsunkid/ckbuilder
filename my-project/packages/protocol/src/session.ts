// Multi-round sessions (ADR 0001): a two-party state channel.
// Kept out of index.ts so the single-game lock bundle stays byte-identical to the deployed one.
import {
  HASH_LEN,
  MIN_CELL,
  OK,
  ERR_GROUP,
  ERR_RECEIPT,
  ERR_SINCE,
  SINCE_FLAGS_MASK,
  SINCE_RELATIVE_TIMESTAMP,
  SINCE_VALUE_MASK,
  TILES,
  betCapacity,
  bytesEqual,
  checkLoss,
  checkReceipts,
  concat,
  decodeWitness,
  encodeWitness,
  payout,
  validMines,
  type BetArgs,
  type Hash,
  type Receipt,
} from './index';

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function readU64le(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
}


export const SESSION_ARGS_LEN = 32 + 32 + 20 + 20 + 8; // 112
/** Largest fee one session transition may take from the cell capacity. */
export const SESSION_MAX_FEE = 1_000_000n; // 0.01 CKB
export const SIG_LEN = 65; // r(32) s(32) recovery id(1), CKB convention
export const CLOSING_LEN = 8 + HASH_LEN + 1 + 1; // 42

const TAG_STATE = ascii('mines/state');

export interface SessionArgs {
  playerLockHash: Uint8Array;
  houseLockHash: Uint8Array;
  /** blake160 of the player's session public key (33-byte compressed) */
  playerKeyHash: Uint8Array;
  /** blake160 of the operator's state-signing public key */
  houseKeyHash: Uint8Array;
  /** challenge window, seconds (relative timestamp since) */
  dChallenge: bigint;
}

export function encodeSessionArgs(a: SessionArgs): Uint8Array {
  if (a.playerLockHash.length !== 32 || a.houseLockHash.length !== 32 || a.playerKeyHash.length !== 20 || a.houseKeyHash.length !== 20) {
    throw new Error('bad session args field length');
  }
  return concat(a.playerLockHash, a.houseLockHash, a.playerKeyHash, a.houseKeyHash, u64le(a.dChallenge));
}

export function decodeSessionArgs(b: Uint8Array): SessionArgs | null {
  if (b.length !== SESSION_ARGS_LEN) return null;
  return {
    playerLockHash: b.slice(0, 32),
    houseLockHash: b.slice(32, 64),
    playerKeyHash: b.slice(64, 84),
    houseKeyHash: b.slice(84, 104),
    dChallenge: readU64le(b, 104),
  };
}

export interface SessionGame {
  R: Uint8Array;
  C: Uint8Array;
  Q: Uint8Array;
  m: number;
  /** stake, shannons */
  s: bigint;
}

export interface SessionState {
  n: bigint;
  /** player balance outside the active round, shannons */
  p: bigint;
  /** operator balance outside the active round, shannons */
  h: bigint;
  final: boolean;
  game: SessionGame | null;
}

const STATE_BASE_LEN = 8 * 3 + 1;
const STATE_GAME_LEN = HASH_LEN * 3 + 1 + 8;

export function encodeState(s: SessionState): Uint8Array {
  const flags = (s.final ? 1 : 0) | (s.game ? 2 : 0);
  const base = concat(u64le(s.n), u64le(s.p), u64le(s.h), Uint8Array.of(flags));
  if (!s.game) return base;
  const g = s.game;
  return concat(base, g.R, g.C, g.Q, Uint8Array.of(g.m), u64le(g.s));
}

export function decodeState(b: Uint8Array): SessionState | null {
  if (b.length !== STATE_BASE_LEN && b.length !== STATE_BASE_LEN + STATE_GAME_LEN) return null;
  const flags = b[24];
  if (flags > 3) return null;
  const hasGame = (flags & 2) !== 0;
  if (hasGame !== (b.length > STATE_BASE_LEN)) return null;
  const o = STATE_BASE_LEN;
  return {
    n: readU64le(b, 0),
    p: readU64le(b, 8),
    h: readU64le(b, 16),
    final: (flags & 1) !== 0,
    game: hasGame ? { R: b.slice(o, o + 32), C: b.slice(o + 32, o + 64), Q: b.slice(o + 64, o + 96), m: b[o + 96], s: readU64le(b, o + 97) } : null,
  };
}

/** Escrow of the active round: stake + operator collateral, the same amount a single-game bet cell locks. */
export function sessionEscrow(g: SessionGame | null): bigint {
  return g ? betCapacity(g.s, g.m) : 0n;
}

/** What both sides sign. `lockArgs` is the full lock args (ckb-js-vm prefix included), so a state binds to one session cell lock. */
export function stateHash(lockArgs: Uint8Array, state: Uint8Array, H: Hash): Uint8Array {
  return H(concat(TAG_STATE, H(lockArgs), state));
}

/** The active round viewed as single-game args, so checkLoss/checkReceipts are reused unchanged. */
export function roundArgs(a: SessionArgs, g: SessionGame): BetArgs {
  return { playerLockHash: a.playerLockHash, houseLockHash: a.houseLockHash, R: g.R, C: g.C, Q: g.Q, m: g.m, stake: g.s, dExit: 0n, dForfeit: 0n };
}

export interface Closing {
  n: bigint;
  stateHash: Uint8Array;
  /** receipts posted for the active round (0 = none yet) */
  k: number;
  lossProven: boolean;
}

export function encodeClosing(c: Closing): Uint8Array {
  return concat(u64le(c.n), c.stateHash, Uint8Array.of(c.k, c.lossProven ? 1 : 0));
}

export function decodeClosing(b: Uint8Array): Closing | null {
  if (b.length !== CLOSING_LEN || b[41] > 1 || b[40] > TILES) return null;
  return { n: readU64le(b, 0), stateHash: b.slice(8, 40), k: b[40], lossProven: b[41] === 1 };
}

export type SessionMode = 'coop' | 'close' | 'update' | 'receipts' | 'loss' | 'settle';
const MODE_BYTE: Record<SessionMode, number> = { coop: 0x10, close: 0x11, update: 0x12, receipts: 0x13, loss: 0x14, settle: 0x15 };

export type SessionWitness =
  | { mode: 'coop' | 'close' | 'update'; state: Uint8Array; sigP: Uint8Array; sigH: Uint8Array }
  | { mode: 'receipts'; state: Uint8Array; receipts: Receipt[] }
  | { mode: 'loss'; state: Uint8Array; S: Uint8Array; t: number; p: Uint8Array; pickProof: Uint8Array[] }
  | { mode: 'settle'; state: Uint8Array };

export function encodeSessionWitness(w: SessionWitness): Uint8Array {
  const head = concat(Uint8Array.of(MODE_BYTE[w.mode], w.state.length), w.state);
  switch (w.mode) {
    case 'coop':
    case 'close':
    case 'update':
      return concat(head, w.sigP, w.sigH);
    case 'receipts':
      return concat(head, encodeWitness({ path: 'C', receipts: w.receipts }));
    case 'loss':
      return concat(head, encodeWitness({ path: 'B', S: w.S, t: w.t, p: w.p, pickProof: w.pickProof }));
    case 'settle':
      return head;
  }
}

export function decodeSessionWitness(b: Uint8Array): SessionWitness | null {
  if (b.length < 2) return null;
  const len = b[1];
  if (b.length < 2 + len) return null;
  const state = b.slice(2, 2 + len);
  const rest = b.slice(2 + len);
  switch (b[0]) {
    case 0x10:
    case 0x11:
    case 0x12: {
      if (rest.length !== 2 * SIG_LEN) return null;
      const mode = b[0] === 0x10 ? 'coop' : b[0] === 0x11 ? 'close' : 'update';
      return { mode, state, sigP: rest.slice(0, SIG_LEN), sigH: rest.slice(SIG_LEN) };
    }
    case 0x13: {
      const w = decodeWitness(rest);
      return w && w.path === 'C' ? { mode: 'receipts', state, receipts: w.receipts } : null;
    }
    case 0x14: {
      const w = decodeWitness(rest);
      return w && w.path === 'B' ? { mode: 'loss', state, S: w.S, t: w.t, p: w.p, pickProof: w.pickProof } : null;
    }
    case 0x15:
      return rest.length === 0 ? { mode: 'settle', state } : null;
    default:
      return null;
  }
}

/** blake160 of the public key that produced `sig` over `msg`, or null. Injected: bindings in the script, noble in Node/browser. */
export type KeyHashOf = (sig: Uint8Array, msg: Uint8Array) => Uint8Array | null;

export interface SessionOutput {
  capacity: bigint;
  data: Uint8Array;
  hasType: boolean;
}

/** What the session lock sees of the transaction. */
export interface SessionView {
  /** full lock args, ckb-js-vm prefix included */
  lockArgs: Uint8Array;
  args: SessionArgs;
  /** cells of this lock among the inputs (must be exactly one) */
  groupInputs: number;
  inputCapacity: bigint;
  inputData: Uint8Array;
  since: bigint;
  witness: Uint8Array;
  /** outputs carrying this same lock */
  sessionOutputs: SessionOutput[];
  /** capacity the transaction moves to a lock hash: outputs minus inputs */
  flowTo: (lockHash: Uint8Array) => bigint;
}

export const ERR_S_WITNESS = 20;
export const ERR_S_SIG = 21;
export const ERR_S_MODE = 22;
export const ERR_S_STATE = 23;
export const ERR_S_NONCE = 24;
export const ERR_S_OUTPUT = 25;
export const ERR_S_PAYOUT = 26;
export const ERR_S_EVIDENCE = 27;

/** Player and operator shares when a session pays out (ADR 0001 section 7). */
export function sessionShares(
  s: SessionState,
  capacity: bigint,
  k: number,
  lossProven: boolean,
): { player: bigint; house: bigint; playerPaysFee: boolean } | null {
  let base = s.p;
  if (s.game && !lossProven) base += payout(s.game.s, k, s.game.m).payout;
  if (base > capacity) return null;
  let player = base < MIN_CELL ? 0n : base;
  let house = capacity - player;
  // the operator absorbs fees; a share it could not even keep as a cell goes to the player
  if (house < MIN_CELL + SESSION_MAX_FEE) return { player: capacity, house: 0n, playerPaysFee: true };
  return { player, house, playerPaysFee: false };
}

function validState(s: SessionState): boolean {
  if (s.final && s.game) return false;
  if (s.game && (!validMines(s.game.m) || s.game.s === 0n)) return false;
  return true;
}

function paysOut(v: SessionView, s: SessionState, k: number, lossProven: boolean): number {
  if (v.sessionOutputs.length !== 0) return ERR_S_OUTPUT;
  const shares = sessionShares(s, v.inputCapacity, k, lossProven);
  if (!shares) return ERR_S_STATE;
  const fee = SESSION_MAX_FEE;
  if (shares.player > 0n && v.flowTo(v.args.playerLockHash) < shares.player - (shares.playerPaysFee ? fee : 0n)) return ERR_S_PAYOUT;
  if (shares.house > 0n && v.flowTo(v.args.houseLockHash) < shares.house - fee) return ERR_S_PAYOUT;
  return OK;
}

function producesClosing(v: SessionView, c: Closing): number {
  if (v.sessionOutputs.length !== 1) return ERR_S_OUTPUT;
  const o = v.sessionOutputs[0];
  if (o.hasType || o.capacity < v.inputCapacity - SESSION_MAX_FEE || !bytesEqual(o.data, encodeClosing(c))) return ERR_S_OUTPUT;
  return OK;
}

/** Every rule of the session lock. Returns 0 (OK) or an error code. */
export function checkSession(v: SessionView, H: Hash, keyHashOf: KeyHashOf): number {
  if (v.groupInputs !== 1) return ERR_GROUP;
  const w = decodeSessionWitness(v.witness);
  if (!w) return ERR_S_WITNESS;
  const state = decodeState(w.state);
  if (!state || !validState(state)) return ERR_S_STATE;
  const sh = stateHash(v.lockArgs, w.state, H);

  const open = v.inputData.length === 0;
  const closing = open ? null : decodeClosing(v.inputData);
  if (!open && !closing) return ERR_S_STATE;

  if (w.mode === 'coop' || w.mode === 'close' || w.mode === 'update') {
    const kp = keyHashOf(w.sigP, sh);
    const kh = keyHashOf(w.sigH, sh);
    if (!kp || !kh || !bytesEqual(kp, v.args.playerKeyHash) || !bytesEqual(kh, v.args.houseKeyHash)) return ERR_S_SIG;
    if (w.mode === 'coop') {
      if (!state.final) return ERR_S_STATE;
      return paysOut(v, state, 0, false);
    }
    if (w.mode === 'close') {
      if (!open) return ERR_S_MODE;
      return producesClosing(v, { n: state.n, stateHash: sh, k: 0, lossProven: false });
    }
    if (open) return ERR_S_MODE;
    if (state.n <= closing!.n) return ERR_S_NONCE;
    return producesClosing(v, { n: state.n, stateHash: sh, k: 0, lossProven: false });
  }

  // the remaining modes act on the state already posted in the closing cell
  if (open) return ERR_S_MODE;
  const c = closing!;
  if (!bytesEqual(sh, c.stateHash)) return ERR_S_STATE;

  if (w.mode === 'settle') {
    if ((v.since & SINCE_FLAGS_MASK) !== SINCE_RELATIVE_TIMESTAMP || (v.since & SINCE_VALUE_MASK) < v.args.dChallenge) return ERR_SINCE;
    return paysOut(v, state, c.k, c.lossProven);
  }
  if (!state.game) return ERR_S_STATE;
  const ra = roundArgs(v.args, state.game);
  if (w.mode === 'receipts') {
    if (c.k !== 0 || c.lossProven) return ERR_S_EVIDENCE;
    const k = checkReceipts(ra, w.receipts, H);
    if (k < 0) return -k;
    if (k === 0) return ERR_RECEIPT;
    return producesClosing(v, { ...c, k });
  }
  if (w.mode !== 'loss') return ERR_S_WITNESS;
  if (c.lossProven) return ERR_S_EVIDENCE;
  const r = checkLoss(ra, w, H);
  if (r !== OK) return r;
  return producesClosing(v, { ...c, lossProven: true });
}
