import { randomBytes, randomUUID } from 'crypto';
import { ccc } from '@ckb-ccc/core';
import {
  H,
  P,
  argsFromJson,
  argsToJson,
  betLock,
  buildBetTx,
  buildCashOutTx,
  buildForfeitTx,
  buildLossTx,
  bytes,
  checkBetTx,
  hex,
  lockHash,
  outPointFromKey,
  outPointKey,
  receiptToJson,
  toJson,
  txFromJson,
  type BetCell,
  type CellRef,
} from '@ckb-mines/chain';
import { config } from './config';
import { getBet, pool, updateBet, type BetRow } from './db';
import { House } from './house';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const FINAL = new Set(['won', 'lost', 'exited', 'forfeited']);

// One request at a time per bet: reveals, cash-out and the watcher never interleave.
const locks = new Map<string, Promise<unknown>>();
export async function withBet<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(id, run);
  try {
    return await run;
  } finally {
    if (locks.get(id) === run) locks.delete(id);
  }
}

async function mustGet(id: string): Promise<BetRow> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(404, 'no such bet');
  const b = await getBet(id);
  if (!b) throw new ApiError(404, 'no such bet');
  return b;
}

function hex32(v: unknown, name: string): Uint8Array {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ApiError(400, `${name} must be 32 bytes of hex`);
  return bytes(v);
}

/**
 * The player's wallet may add cell deps and its own witness while signing; everything
 * that moves value or carries our evidence must be exactly what we built.
 */
export function sameSettlement(draft: ccc.Transaction, signed: ccc.Transaction): string | null {
  if (signed.inputs.length !== draft.inputs.length) return 'inputs differ';
  for (let i = 0; i < draft.inputs.length; i++) {
    if (!signed.inputs[i].previousOutput.eq(draft.inputs[i].previousOutput) || signed.inputs[i].since !== draft.inputs[i].since) return `input ${i} differs`;
  }
  if (signed.outputs.length !== draft.outputs.length) return 'outputs differ';
  for (let i = 0; i < draft.outputs.length; i++) {
    const a = draft.outputs[i];
    const o = signed.outputs[i];
    if (o.capacity !== a.capacity || !o.lock.eq(a.lock) || (o.type ? !a.type || !o.type.eq(a.type) : !!a.type)) return `output ${i} differs`;
    if (signed.outputsData[i] !== draft.outputsData[i]) return `output data ${i} differs`;
  }
  if (signed.witnesses[0] !== draft.witnesses[0]) return 'bet witness differs';
  return null;
}

function betCell(b: BetRow): BetCell {
  const args = argsFromJson(b.args!);
  return { outPoint: { txHash: b.bet_tx!, index: 0 }, capacity: BigInt(b.capacity!), lock: betLock(args), args };
}

export class Game {
  constructor(readonly house: House) {}

  get client() {
    return this.house.client;
  }

  publicConfig() {
    return {
      houseLock: this.house.lock,
      tPlay: config.tPlaySeconds,
      dExit: config.dExitSeconds.toString(),
      dForfeit: config.dForfeitSeconds.toString(),
      minStake: config.minStake.toString(),
      maxCollateral: config.maxCollateral.toString(),
      minesLockCodeHash: betLock({
        playerLockHash: new Uint8Array(32),
        houseLockHash: new Uint8Array(32),
        R: new Uint8Array(32),
        C: new Uint8Array(32),
        Q: new Uint8Array(32),
        m: 2,
        stake: 1n,
        dExit: 0n,
        dForfeit: 0n,
      }).codeHash,
    };
  }

  /** Step 1: seal a fresh layout. The root is fixed before the player's seed exists. */
  async create(body: { playerLock?: unknown; m?: unknown; stake?: unknown }) {
    const m = Number(body.m);
    if (!P.validMines(m)) throw new ApiError(400, 'm must be 2, 3 or 4');
    let stake: bigint;
    try {
      stake = BigInt(String(body.stake));
    } catch {
      throw new ApiError(400, 'stake must be an integer number of shannons');
    }
    if (stake < config.minStake) throw new ApiError(400, `minimum stake is ${ccc.fixedPointToString(config.minStake)} CKB`);
    if (P.collateral(stake, m) > config.maxCollateral) {
      throw new ApiError(400, `maximum stake for ${m} mines is ${ccc.fixedPointToString(config.maxCollateral / (P.binom(9, m) - 1n))} CKB`);
    }
    let playerLock: ccc.Script;
    try {
      playerLock = ccc.Script.from(body.playerLock as ccc.ScriptLike);
    } catch {
      throw new ApiError(400, 'playerLock must be a script');
    }
    if (playerLock.eq(this.house.lock)) throw new ApiError(400, 'the house cannot play against itself');

    const id = randomUUID();
    const S = new Uint8Array(randomBytes(32));
    const R = P.buildLayout(S, m, H).root;
    await pool.query(
      `insert into bets (id, status, m, stake, player_lock, player_lock_hash, seed_s, root_r, d_exit, d_forfeit)
       values ($1, 'sealed', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, m, stake.toString(), JSON.stringify(playerLock), hex(lockHash(playerLock)), hex(S), hex(R), config.dExitSeconds.toString(), config.dForfeitSeconds.toString()],
    );
    return { id, R: hex(R), houseLock: this.house.lock, dExit: config.dExitSeconds.toString(), dForfeit: config.dForfeitSeconds.toString() };
  }

  /** Step 2: take the player's commitments, reserve collateral, return the house half of the bet tx. */
  async commit(id: string, body: { C?: unknown; Q?: unknown }) {
    const b = await mustGet(id);
    if (b.status !== 'sealed') throw new ApiError(409, `bet is ${b.status}`);
    const C = hex32(body.C, 'C');
    const Q = hex32(body.Q, 'Q');
    const args: P.BetArgs = {
      playerLockHash: bytes(b.player_lock_hash),
      houseLockHash: this.house.lockHash,
      R: bytes(b.root_r),
      C,
      Q,
      m: b.m,
      stake: BigInt(b.stake),
      dExit: BigInt(b.d_exit),
      dForfeit: BigInt(b.d_forfeit),
    };
    const house = await this.house.reserve(P.collateral(args.stake, args.m) + P.MIN_CELL, id, 'bet');
    const tx = await this.house.prepare(buildBetTx({ args, house, fee: 0n }));
    const ok = await updateBet(
      id,
      { status: 'committed', seed_c: hex(C), root_q: hex(Q), args: argsToJson(args), house_in: outPointKey(house.outPoint), capacity: P.betCapacity(args.stake, args.m) },
      'sealed',
    );
    if (!ok) {
      await this.house.release(outPointKey(house.outPoint));
      throw new ApiError(409, 'bet changed meanwhile');
    }
    return { tx, args: argsToJson(args), house: { outPoint: house.outPoint, capacity: house.capacity.toString(), lock: house.lock } };
  }

  /** Step 3: check the player-signed bet tx, co-sign and broadcast it. */
  async open(id: string, body: { tx?: unknown }) {
    const b = await mustGet(id);
    if (b.status !== 'committed') throw new ApiError(409, `bet is ${b.status}`);
    let tx: ccc.Transaction;
    try {
      tx = txFromJson(body.tx as object);
    } catch {
      throw new ApiError(400, 'tx is not a transaction');
    }
    const live = await this.client.getCellLive(outPointFromKey(b.house_in!), false);
    if (!live) throw new ApiError(409, 'reserved house cell is gone, start a new bet');
    const house: CellRef = { outPoint: live.outPoint, capacity: live.cellOutput.capacity, lock: live.cellOutput.lock };
    const problems = checkBetTx(tx, { args: argsFromJson(b.args!), house, fee: 0n });
    if (problems.length) throw new ApiError(400, problems.join('; '));
    const signed = await this.house.cosign(tx);
    let txHash: string;
    try {
      txHash = await this.client.sendTransaction(signed);
    } catch (e) {
      await updateBet(id, { status: 'failed', error: String(e).slice(0, 500) }, 'committed');
      await this.house.release(b.house_in);
      throw new ApiError(400, `node rejected the bet: ${String(e).slice(0, 300)}`);
    }
    await updateBet(id, { status: 'opening', bet_tx: txHash }, 'committed');
    return { txHash };
  }

  /** A tile. Safe: a receipt. Mine: the loss tx goes on-chain before we answer (SPEC 4.3). */
  async reveal(id: string, body: { t?: unknown; p?: unknown; proof?: unknown }) {
    return withBet(id, async () => {
      const b = await mustGet(id);
      const t = Number(body.t);
      if (!Number.isInteger(t) || t < 0 || t >= P.TILES) throw new ApiError(400, 't must be a tile 0..8');
      const p = hex32(body.p, 'p');
      if (!Array.isArray(body.proof) || body.proof.length !== P.TREE_DEPTH) throw new ApiError(400, 'proof must have 4 hashes');
      const proof = body.proof.map((x, i) => hex32(x, `proof[${i}]`));
      if (!P.verifyMerkle(P.pickLeaf(t, p, H), t, proof, bytes(b.root_q!), H)) throw new ApiError(400, 'pick secret does not match your commitment Q');

      const prev = (await pool.query<{ safe: boolean }>('select safe from reveals where bet_id = $1 and tile = $2', [id, t])).rows[0];
      const S = bytes(b.seed_s);
      const layout = P.buildLayout(S, b.m, H);
      if (prev?.safe) return { safe: true, receipt: receiptToJson(P.makeReceipt(layout, bytes(b.seed_c!), t, H)!) };
      if (prev && !prev.safe) {
        if (b.status === 'open') return this.claimLoss(b, t, p, proof); // retry after a failed broadcast
        return { safe: false, S: b.seed_s, txHash: b.settle_tx };
      }

      if (b.status !== 'open') throw new ApiError(409, `bet is ${b.status}`);
      if (Date.now() > b.opened_at!.getTime() + config.tPlaySeconds * 1000) throw new ApiError(409, 'play window closed; cash out or wait for the exit delay');

      const j = P.tileMap(bytes(b.seed_c!), H)[t];
      const safe = layout.states[j] === 0;
      await pool.query('insert into reveals (bet_id, tile, position, safe, pick_secret) values ($1, $2, $3, $4, $5)', [id, t, j, safe, hex(p)]);
      if (safe) return { safe: true, receipt: receiptToJson(P.makeReceipt(layout, bytes(b.seed_c!), t, H)!) };
      return this.claimLoss(b, t, p, proof);
    });
  }

  private async claimLoss(b: BetRow, t: number, p: Uint8Array, proof: Uint8Array[]) {
    const house = await this.house.reserve(P.MIN_CELL, b.id, 'loss');
    const tx = buildLossTx({ bet: betCell(b), house, witness: { path: 'B', S: bytes(b.seed_s), t, p, pickProof: proof } });
    let txHash: string;
    try {
      txHash = await this.client.sendTransaction(await this.house.signAlone(tx));
    } catch (e) {
      await this.house.release(outPointKey(house.outPoint));
      await updateBet(b.id, { error: `loss tx rejected: ${String(e).slice(0, 400)}` });
      throw new ApiError(503, 'mine hit, but the loss transaction was not accepted yet; retry');
    }
    await updateBet(b.id, { status: 'losing', settle_tx: txHash, settle_path: 'B', settle_house_in: outPointKey(house.outPoint), hit_tile: t, payout: 0n }, 'open');
    return { safe: false, S: b.seed_s, txHash };
  }

  /** Path A, first half: the server builds the cash-out; the player checks and signs it. */
  async cashOut(id: string, body: { playerCell?: unknown }) {
    return withBet(id, async () => {
      const b = await mustGet(id);
      if (b.status !== 'open') throw new ApiError(409, `bet is ${b.status}`);
      const k = Number((await pool.query<{ n: string }>('select count(*) as n from reveals where bet_id = $1 and safe', [id])).rows[0].n);
      if (k < 1) throw new ApiError(409, 'reveal at least one tile first');
      let op: ccc.OutPoint;
      try {
        op = ccc.OutPoint.from(body.playerCell as ccc.OutPointLike);
      } catch {
        throw new ApiError(400, 'playerCell must be an out point');
      }
      const cell = await this.client.getCellLive(op, true);
      if (!cell) throw new ApiError(400, 'playerCell is not live');
      if (!cell.cellOutput.lock.eq(ccc.Script.from(b.player_lock)) || cell.cellOutput.type || cell.outputData !== '0x') {
        throw new ApiError(400, 'playerCell must be a plain cell of the player lock');
      }
      const player: CellRef = { outPoint: op, capacity: cell.cellOutput.capacity, lock: cell.cellOutput.lock };
      const house = await this.house.reserve(P.MIN_CELL, id, 'cashout');
      const tx = await this.house.prepare(buildCashOutTx({ bet: betCell(b), house, player, k }));
      await updateBet(
        id,
        {
          status: 'cashing',
          settle_draft: JSON.parse(toJson(tx)),
          settle_path: 'A',
          settle_house_in: outPointKey(house.outPoint),
          payout: P.payout(BigInt(b.stake), k, b.m).payout,
        },
        'open',
      );
      return { tx, k };
    });
  }

  /** Path A, second half: the player-signed cash-out is co-signed and broadcast. */
  async settle(id: string, body: { tx?: unknown }) {
    return withBet(id, async () => {
      const b = await mustGet(id);
      if (b.status !== 'cashing') throw new ApiError(409, `bet is ${b.status}`);
      let tx: ccc.Transaction;
      try {
        tx = txFromJson(body.tx as object);
      } catch {
        throw new ApiError(400, 'tx is not a transaction');
      }
      const problem = sameSettlement(txFromJson(b.settle_draft!), tx);
      if (problem) throw new ApiError(400, `this is not the cash-out we built: ${problem}`);
      let txHash: string;
      try {
        txHash = await this.client.sendTransaction(await this.house.cosign(tx));
      } catch (e) {
        await this.house.release(b.settle_house_in);
        await updateBet(id, { status: 'open', error: `cash-out rejected: ${String(e).slice(0, 400)}` }, 'cashing');
        throw new ApiError(400, `node rejected the cash-out: ${String(e).slice(0, 300)}`);
      }
      await updateBet(id, { status: 'settling', settle_tx: txHash }, 'cashing');
      return { txHash };
    });
  }

  /** Path D: reclaim a bet nobody settled before D_forfeit. */
  async forfeit(b: BetRow) {
    const house = await this.house.reserve(P.MIN_CELL, b.id, 'forfeit');
    const tx = buildForfeitTx({ bet: betCell(b), house });
    try {
      const txHash = await this.client.sendTransaction(await this.house.signAlone(tx));
      await updateBet(b.id, { status: 'forfeiting', settle_tx: txHash, settle_path: 'D', settle_house_in: outPointKey(house.outPoint), payout: 0n }, 'open');
    } catch (e) {
      await this.house.release(outPointKey(house.outPoint));
      await updateBet(b.id, { error: `forfeit rejected: ${String(e).slice(0, 400)}` });
    }
  }

  async view(id: string) {
    const b = await mustGet(id);
    const reveals = (await pool.query<{ tile: number; safe: boolean }>('select tile, safe from reveals where bet_id = $1 order by created_at', [id])).rows;
    return {
      id: b.id,
      status: b.status,
      m: b.m,
      stake: b.stake,
      R: b.root_r,
      args: b.args,
      betTx: b.bet_tx,
      betOutPoint: b.bet_tx ? { txHash: b.bet_tx, index: '0' } : null,
      openedAt: b.opened_at?.toISOString() ?? null,
      tPlayEndsAt: b.opened_at ? new Date(b.opened_at.getTime() + config.tPlaySeconds * 1000).toISOString() : null,
      reveals,
      settleTx: b.settle_tx,
      settlePath: b.settle_path,
      payout: b.payout,
      hit: b.hit_tile,
      // the seed is secret until the bet is over; then anyone can verify the layout
      S: FINAL.has(b.status) || b.status === 'losing' ? b.seed_s : null,
      error: b.error,
    };
  }

  async history(playerLockHash: string) {
    if (!/^0x[0-9a-f]{64}$/.test(playerLockHash)) throw new ApiError(400, 'player must be a lock hash');
    const r = await pool.query<BetRow>(
      "select * from bets where player_lock_hash = $1 and status not in ('sealed') order by created_at desc limit 50",
      [playerLockHash],
    );
    return r.rows.map((b) => ({ id: b.id, status: b.status, m: b.m, stake: b.stake, payout: b.payout, settlePath: b.settle_path, createdAt: b.created_at }));
  }
}

export { FINAL };
