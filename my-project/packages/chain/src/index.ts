// Transaction building and checking for CKB Mines, shared by the server, the web app and the E2E harness.
import { ccc } from '@ckb-ccc/core';
import * as P from '@ckb-mines/protocol';
import minesLock from './mines-lock.testnet.json';
import ckbJsVm from './ckb-js-vm.testnet.json';

export { P };
export const H: P.Hash = (d) => new Uint8Array(ccc.bytesFrom(ccc.hashCkb(d)));

/** Fee the operator attaches to every transaction it builds (0.001 CKB, far above the 1000 shannons/KB minimum). */
export const OPERATOR_FEE = 100_000n;

export const deployment = { minesLock, ckbJsVm };

export const cellDeps: ccc.CellDepLike[] = [
  { outPoint: ckbJsVm.cellDep.outPoint, depType: 'code' },
  { outPoint: minesLock.outPoint, depType: 'code' },
];

export const hex = (b: Uint8Array) => P.toHex(b) as ccc.Hex;
export const bytes = (h: ccc.HexLike) => new Uint8Array(ccc.bytesFrom(h));

/** The bet cell's lock: ckb-js-vm with the Mines code hash and the bet args. */
export function betLock(args: P.BetArgs): ccc.Script {
  return ccc.Script.from({
    codeHash: ckbJsVm.codeHash,
    hashType: 'type',
    args: ccc.hexFrom(ccc.bytesConcat('0x0000', minesLock.codeHash, ccc.hashTypeToBytes('type'), P.encodeArgs(args))),
  });
}

export function decodeBetLock(lock: ccc.ScriptLike): P.BetArgs | null {
  const s = ccc.Script.from(lock);
  if (s.codeHash !== ckbJsVm.codeHash || s.hashType !== 'type') return null;
  const raw = bytes(s.args);
  const prefix = ccc.hexFrom(raw.slice(0, 35));
  if (prefix !== ccc.hexFrom(ccc.bytesConcat('0x0000', minesLock.codeHash, ccc.hashTypeToBytes('type')))) return null;
  return P.decodeArgs(raw.slice(35));
}

export const lockHash = (s: ccc.ScriptLike) => bytes(ccc.Script.from(s).hash());

export function toJson(v: unknown): string {
  return ccc.stringify(v);
}

export function txFromJson(json: string | object): ccc.Transaction {
  return ccc.Transaction.from(typeof json === 'string' ? JSON.parse(json) : json);
}

export interface CellRef {
  outPoint: ccc.OutPointLike;
  capacity: bigint;
  lock: ccc.ScriptLike;
}

function input(cell: CellRef, since: bigint = 0n): ccc.CellInputLike {
  return {
    previousOutput: cell.outPoint,
    since,
    cellOutput: { capacity: cell.capacity, lock: cell.lock },
    outputData: '0x',
  };
}

function setBetWitness(tx: ccc.Transaction, w: P.Witness) {
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: hex(P.encodeWitness(w)) }));
}

// ---------- bet ----------

/**
 * Server half of the bet transaction: the house cell pays collateral and fee.
 * The player then adds inputs for the stake (plus its own change) and signs.
 */
export function buildBetTx(o: { args: P.BetArgs; house: CellRef; fee?: bigint }): ccc.Transaction {
  const capacity = P.betCapacity(o.args.stake, o.args.m);
  const change = o.house.capacity - P.collateral(o.args.stake, o.args.m) - (o.fee ?? OPERATOR_FEE);
  if (change < P.MIN_CELL) throw new Error('house cell too small for this bet');
  return ccc.Transaction.from({
    inputs: [input(o.house)],
    outputs: [
      { lock: betLock(o.args), capacity },
      { lock: o.house.lock, capacity: change },
    ],
    outputsData: ['0x', '0x'],
  });
}

/** Problems with a bet transaction, as seen by one side; empty when it is safe to sign. */
export function checkBetTx(tx: ccc.Transaction, o: { args: P.BetArgs; house: CellRef; fee?: bigint }): string[] {
  const errors: string[] = [];
  const expected = buildBetTx(o);
  const bet = tx.outputs[0];
  if (!bet || !bet.lock.eq(expected.outputs[0].lock) || bet.capacity !== expected.outputs[0].capacity || bet.type) {
    errors.push('output 0 is not the expected bet cell');
  }
  const change = tx.outputs[1];
  if (!change || !change.lock.eq(expected.outputs[1].lock) || change.capacity !== expected.outputs[1].capacity) {
    errors.push('output 1 is not the expected house change');
  }
  if (tx.outputsData[0] !== '0x' || tx.outputsData[1] !== '0x') errors.push('bet and change outputs must have no data');
  const houseOp = ccc.OutPoint.from(o.house.outPoint);
  const houseInputs = tx.inputs.filter((i) => i.previousOutput.eq(houseOp));
  if (houseInputs.length !== 1) errors.push('house cell must be spent exactly once');
  return errors;
}

// ---------- settlements ----------

export interface BetCell extends CellRef {
  args: P.BetArgs;
}

/** Path A: cooperative cash-out. Player gets `payout` merged into its own cell; house pays the fee. */
export function buildCashOutTx(o: { bet: BetCell; house: CellRef; player: CellRef; k: number; fee?: bigint }): ccc.Transaction {
  const pay = P.payout(o.bet.args.stake, o.k, o.bet.args.m).payout;
  const tx = ccc.Transaction.from({
    inputs: [input(o.bet), input(o.house), input(o.player)],
    outputs: [
      { lock: o.player.lock, capacity: o.player.capacity + pay },
      { lock: o.house.lock, capacity: o.house.capacity + o.bet.capacity - pay - (o.fee ?? OPERATOR_FEE) },
    ],
    outputsData: ['0x', '0x'],
    cellDeps,
  });
  setBetWitness(tx, { path: 'A' });
  return tx;
}

/** Path B: the operator proves the picked tile was a mine and takes the whole bet. */
export function buildLossTx(o: { bet: BetCell; house: CellRef; witness: Extract<P.Witness, { path: 'B' }>; fee?: bigint }): ccc.Transaction {
  const tx = ccc.Transaction.from({
    inputs: [input(o.bet), input(o.house)],
    outputs: [{ lock: o.house.lock, capacity: o.house.capacity + o.bet.capacity - (o.fee ?? OPERATOR_FEE) }],
    outputsData: ['0x'],
    cellDeps,
  });
  setBetWitness(tx, o.witness);
  return tx;
}

/** Path D: the operator reclaims a bet nobody settled before D_forfeit. */
export function buildForfeitTx(o: { bet: BetCell; house: CellRef; fee?: bigint }): ccc.Transaction {
  const tx = ccc.Transaction.from({
    inputs: [input(o.bet, P.SINCE_RELATIVE_TIMESTAMP | o.bet.args.dForfeit), input(o.house)],
    outputs: [{ lock: o.house.lock, capacity: o.house.capacity + o.bet.capacity - (o.fee ?? OPERATOR_FEE) }],
    outputsData: ['0x'],
    cellDeps,
  });
  setBetWitness(tx, { path: 'D' });
  return tx;
}

/** Path C: the player exits alone with its receipts after D_exit. The player pays the fee. */
export function buildExitTx(o: { bet: BetCell; player: CellRef; houseLock: ccc.ScriptLike; receipts: P.Receipt[]; fee?: bigint }): ccc.Transaction {
  const { args } = o.bet;
  const due = P.houseShareOnExit(o.bet.capacity, args.stake, o.receipts.length, args.m);
  const outputs: ccc.CellOutputLike[] = [];
  if (due > 0n) outputs.push({ lock: o.houseLock, capacity: due });
  outputs.push({ lock: o.player.lock, capacity: o.player.capacity + o.bet.capacity - due - (o.fee ?? OPERATOR_FEE) });
  const tx = ccc.Transaction.from({
    inputs: [input(o.bet, P.SINCE_RELATIVE_TIMESTAMP | args.dExit), input(o.player)],
    outputs,
    outputsData: outputs.map(() => '0x'),
    cellDeps,
  });
  setBetWitness(tx, { path: 'C', receipts: o.receipts });
  return tx;
}

/** Capacity a transaction moves to `lock` (outputs minus inputs); inputs must carry cellOutput. */
export function netFlow(tx: ccc.Transaction, lock: ccc.ScriptLike): bigint {
  const l = ccc.Script.from(lock);
  let flow = 0n;
  for (const o of tx.outputs) if (o.lock.eq(l)) flow += o.capacity;
  for (const i of tx.inputs) {
    if (!i.cellOutput) throw new Error('input without cellOutput');
    if (i.cellOutput.lock.eq(l)) flow -= i.cellOutput.capacity;
  }
  return flow;
}

// ---------- receipts on the wire ----------

export interface ReceiptJson {
  t: number;
  salt: string;
  proof: string[];
}

export const receiptToJson = (r: P.Receipt): ReceiptJson => ({ t: r.t, salt: hex(r.salt), proof: r.proof.map(hex) });
export const receiptFromJson = (r: ReceiptJson): P.Receipt => ({ t: r.t, salt: bytes(r.salt), proof: r.proof.map(bytes) });

export interface BetArgsJson {
  playerLockHash: string;
  houseLockHash: string;
  R: string;
  C: string;
  Q: string;
  m: number;
  stake: string;
  dExit: string;
  dForfeit: string;
}

export const argsToJson = (a: P.BetArgs): BetArgsJson => ({
  playerLockHash: hex(a.playerLockHash),
  houseLockHash: hex(a.houseLockHash),
  R: hex(a.R),
  C: hex(a.C),
  Q: hex(a.Q),
  m: a.m,
  stake: a.stake.toString(),
  dExit: a.dExit.toString(),
  dForfeit: a.dForfeit.toString(),
});

export const argsFromJson = (a: BetArgsJson): P.BetArgs => ({
  playerLockHash: bytes(a.playerLockHash),
  houseLockHash: bytes(a.houseLockHash),
  R: bytes(a.R),
  C: bytes(a.C),
  Q: bytes(a.Q),
  m: a.m,
  stake: BigInt(a.stake),
  dExit: BigInt(a.dExit),
  dForfeit: BigInt(a.dForfeit),
});

/** Plain, unlocked, data-free cells of `lock` that the chain reports live, largest first. */
export async function freeCells(client: ccc.Client, lock: ccc.ScriptLike, limit = 50): Promise<CellRef[]> {
  const out: CellRef[] = [];
  for await (const c of client.findCells(
    { script: lock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { scriptLenRange: [0, 1], outputDataLenRange: [0, 1] } },
    'desc',
    limit,
  )) {
    out.push({ outPoint: c.outPoint, capacity: c.cellOutput.capacity, lock: c.cellOutput.lock });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => (b.capacity > a.capacity ? 1 : b.capacity < a.capacity ? -1 : 0));
}

export const outPointKey = (o: ccc.OutPointLike) => {
  const op = ccc.OutPoint.from(o);
  return `${op.txHash}:${op.index}`;
};

export function outPointFromKey(k: string): ccc.OutPoint {
  const [txHash, index] = k.split(':');
  return ccc.OutPoint.from({ txHash, index: BigInt(index) });
}

