// Operator side of sessions (ADR 0001): opens session cells, runs rounds off-chain by signing
// states, and defends its balance on chain (see SessionWatcher).
import { randomBytes, randomUUID } from 'crypto';
import { ccc } from '@ckb-ccc/core';
import { H, P, bytes, hex, lockHash, outPointFromKey, outPointKey, receiptToJson, txFromJson, type CellRef } from '@ckb-mines/chain';
import {
  PS,
  buildCoopCloseTx,
  buildDepositTx,
  checkDepositTx,
  checkStateSig,
  finalState,
  keyHashOf,
  mustDecodeState,
  roundProblem,
  roundState,
  sessionArgsFromJson,
  sessionArgsToJson,
  settledState,
  signState,
  type SessionCell,
  type SignedState,
} from '@ckb-mines/chain/session';
import { ApiError, withBet } from './bets';
import { config } from './config';
import { getSession, pool, updateRound, updateSession, type RoundRow, type SessionRow } from './db';
import { House } from './house';

const UUID = /^[0-9a-f-]{36}$/;

function hexN(v: unknown, len: number, name: string): Uint8Array {
  if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`).test(v)) throw new ApiError(400, `${name} must be ${len} bytes of hex`);
  return bytes(v);
}

function amount(v: unknown, name: string): bigint {
  try {
    const x = BigInt(String(v));
    if (x < 0n) throw new Error();
    return x;
  } catch {
    throw new ApiError(400, `${name} must be an integer number of shannons`);
  }
}

/** Collateral per shannon of stake on the hardest difficulty: the operator deposit covers this for `maxBet`. */
const HARDEST = P.binom(P.TILES, P.MINES_BY_DIFFICULTY.hard) - 1n;

export class Sessions {
  private readonly key: Uint8Array;
  readonly houseKeyHash: Uint8Array;

  constructor(readonly house: House) {
    this.key = bytes(config.privateKey);
    this.houseKeyHash = keyHashOf(this.key);
  }

  get client() {
    return this.house.client;
  }

  sign(args: PS.SessionArgs, state: Uint8Array): Uint8Array {
    return signState(this.key, args, state);
  }

  parties(s: SessionRow) {
    return { playerLock: ccc.Script.from(s.player_lock), houseLock: this.house.lock };
  }

  /** The newest state both sides signed. */
  latest(s: SessionRow): SignedState {
    if (!s.state.sigP) throw new ApiError(409, 'session has no player signature yet');
    return { state: bytes(s.state.state), sigP: bytes(s.state.sigP), sigH: bytes(s.state.sigH) };
  }

  publicConfig() {
    return {
      dChallenge: config.dChallengeSeconds.toString(),
      idle: config.sessionIdleSeconds,
      minDeposit: config.minDeposit.toString(),
      maxDeposit: config.maxDeposit.toString(),
      minStake: config.minStake.toString(),
      maxBet: (config.maxSessionHouse / HARDEST).toString(),
      houseKeyHash: hex(this.houseKeyHash),
    };
  }

  private async mustGet(id: string): Promise<SessionRow> {
    if (!UUID.test(id)) throw new ApiError(404, 'no such session');
    const s = await getSession(id);
    if (!s) throw new ApiError(404, 'no such session');
    return s;
  }

  private async mustRound(s: SessionRow, roundId: string): Promise<RoundRow> {
    if (!UUID.test(roundId)) throw new ApiError(404, 'no such round');
    const r = (await pool.query<RoundRow>('select * from session_rounds where id = $1 and session_id = $2', [roundId, s.id])).rows[0];
    if (!r) throw new ApiError(404, 'no such round');
    return r;
  }

  private ready(s: SessionRow) {
    if (s.status !== 'open') throw new ApiError(409, `session is ${s.status}`);
    if (s.pending) throw new ApiError(409, `sign state ${s.pending.n} first (ack)`);
  }

  // ---------- open ----------

  /** Step 1: terms, the house half of the deposit tx, and our signature on state 0. */
  async create(body: { playerLock?: unknown; playerKeyHash?: unknown; deposit?: unknown; maxBet?: unknown }) {
    let playerLock: ccc.Script;
    try {
      playerLock = ccc.Script.from(body.playerLock as ccc.ScriptLike);
    } catch {
      throw new ApiError(400, 'playerLock must be a script');
    }
    if (playerLock.eq(this.house.lock)) throw new ApiError(400, 'the house cannot play against itself');
    const playerKeyHash = hexN(body.playerKeyHash, 20, 'playerKeyHash');
    const deposit = amount(body.deposit, 'deposit');
    const maxBet = amount(body.maxBet, 'maxBet');
    if (deposit < config.minDeposit || deposit > config.maxDeposit) {
      throw new ApiError(400, `deposit must be ${ccc.fixedPointToString(config.minDeposit)}–${ccc.fixedPointToString(config.maxDeposit)} CKB`);
    }
    if (maxBet < config.minStake) throw new ApiError(400, `max bet must be at least ${ccc.fixedPointToString(config.minStake)} CKB`);
    const houseDeposit = HARDEST * maxBet;
    if (houseDeposit > config.maxSessionHouse) throw new ApiError(400, `max bet is at most ${ccc.fixedPointToString(config.maxSessionHouse / HARDEST)} CKB`);

    const id = randomUUID();
    const args: PS.SessionArgs = {
      playerLockHash: lockHash(playerLock),
      houseLockHash: this.house.lockHash,
      playerKeyHash,
      houseKeyHash: this.houseKeyHash,
      dChallenge: config.dChallengeSeconds,
    };
    const state0 = PS.encodeState({ n: 0n, p: deposit, h: houseDeposit, final: false, game: null });
    const sigH = this.sign(args, state0);
    const houses = await this.house.reserveMany(houseDeposit + P.MIN_CELL, id, 'session');
    const houseKeys = houses.map((h) => outPointKey(h.outPoint));
    let tx: ccc.Transaction;
    try {
      tx = await this.house.prepare(buildDepositTx({ args, houses, deposit, houseDeposit }));
    } catch (e) {
      await this.releaseAll(houseKeys.join(','));
      throw new ApiError(400, (e as Error).message);
    }
    await pool.query(
      `insert into sessions (id, status, player_lock, player_lock_hash, args, deposit, house_deposit, house_in, state)
       values ($1, 'committed', $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        JSON.stringify(playerLock),
        hex(args.playerLockHash),
        JSON.stringify(sessionArgsToJson(args)),
        deposit.toString(),
        houseDeposit.toString(),
        houseKeys.join(','),
        JSON.stringify({ state: hex(state0), sigP: null, sigH: hex(sigH) }),
      ],
    );
    return {
      id,
      args: sessionArgsToJson(args),
      houseLock: this.house.lock,
      houses: houses.map((h) => ({ outPoint: h.outPoint, capacity: h.capacity.toString(), lock: h.lock })),
      houseDeposit: houseDeposit.toString(),
      tx,
      sigH: hex(sigH),
    };
  }

  /** Step 2: the player's signature on state 0 and its signed deposit; we co-sign and broadcast. */
  async open(id: string, body: { tx?: unknown; sigP?: unknown }) {
    return withBet(id, async () => {
      const s = await this.mustGet(id);
      if (s.status !== 'committed') throw new ApiError(409, `session is ${s.status}`);
      const args = sessionArgsFromJson(s.args);
      const sigP = hexN(body.sigP, PS.SIG_LEN, 'sigP');
      if (!checkStateSig(sigP, args.playerKeyHash, args, bytes(s.state.state))) throw new ApiError(400, 'sigP does not sign state 0 with the session key');
      let tx: ccc.Transaction;
      try {
        tx = txFromJson(body.tx as object);
      } catch {
        throw new ApiError(400, 'tx is not a transaction');
      }
      const houses: CellRef[] = [];
      for (const key of s.house_in!.split(',')) {
        const live = await this.client.getCellLive(outPointFromKey(key), false);
        if (!live) throw new ApiError(409, 'a reserved house cell is gone, open a new session');
        houses.push({ outPoint: live.outPoint, capacity: live.cellOutput.capacity, lock: live.cellOutput.lock });
      }
      const problems = checkDepositTx(tx, { args, houses, deposit: BigInt(s.deposit), houseDeposit: BigInt(s.house_deposit) });
      if (problems.length) throw new ApiError(400, problems.join('; '));
      const signed = await this.house.cosign(tx);
      let txHash: string;
      try {
        txHash = await this.client.sendTransaction(signed);
      } catch (e) {
        await updateSession(id, { status: 'failed', error: String(e).slice(0, 500) }, 'committed');
        await this.releaseAll(s.house_in);
        throw new ApiError(400, `node rejected the deposit: ${String(e).slice(0, 300)}`);
      }
      await updateSession(
        id,
        { status: 'opening', deposit_tx: txHash, cell: `${txHash}:0`, state: { ...s.state, sigP: hex(sigP) }, last_activity: new Date() },
        'committed',
      );
      return { txHash };
    });
  }

  // ---------- rounds ----------

  /** Seals a layout for a new round. Its root is fixed before the player's seed exists. */
  async newRound(id: string, body: { m?: unknown; stake?: unknown }) {
    return withBet(id, async () => {
      const s = await this.mustGet(id);
      this.ready(s);
      const m = Number(body.m);
      const stake = amount(body.stake, 'stake');
      if (stake < config.minStake) throw new ApiError(400, `minimum stake is ${ccc.fixedPointToString(config.minStake)} CKB`);
      const problem = roundProblem(mustDecodeState(s.state.state), m, stake);
      if (problem) throw new ApiError(400, problem);
      await pool.query("update session_rounds set status = 'abandoned', updated_at = now() where session_id = $1 and status = 'sealed'", [id]);
      const roundId = randomUUID();
      const S = new Uint8Array(randomBytes(32));
      const R = P.buildLayout(S, m, H).root;
      await pool.query(
        `insert into session_rounds (id, session_id, status, m, stake, seed_s, root_r) values ($1, $2, 'sealed', $3, $4, $5, $6)`,
        [roundId, id, m, stake.toString(), hex(S), hex(R)],
      );
      await updateSession(id, { last_activity: new Date() });
      return { roundId, R: hex(R) };
    });
  }

  /** Takes the player's commitments and signature on the round state, and countersigns it. */
  async commitRound(id: string, roundId: string, body: { C?: unknown; Q?: unknown; sigP?: unknown }) {
    return withBet(id, async () => {
      const s = await this.mustGet(id);
      this.ready(s);
      const r = await this.mustRound(s, roundId);
      if (r.status !== 'sealed') throw new ApiError(409, `round is ${r.status}`);
      const C = hexN(body.C, 32, 'C');
      const Q = hexN(body.Q, 32, 'Q');
      const sigP = hexN(body.sigP, PS.SIG_LEN, 'sigP');
      const args = sessionArgsFromJson(s.args);
      const prev = mustDecodeState(s.state.state);
      const problem = roundProblem(prev, r.m, BigInt(r.stake));
      if (problem) throw new ApiError(409, problem);
      const next = roundState(prev, { R: bytes(r.root_r), C, Q, m: r.m, s: BigInt(r.stake) });
      const enc = PS.encodeState(next);
      if (!checkStateSig(sigP, args.playerKeyHash, args, enc)) throw new ApiError(400, 'sigP does not sign the round state');
      const sigH = this.sign(args, enc);
      await updateRound(roundId, { status: 'live', seed_c: hex(C), root_q: hex(Q), n: next.n }, 'sealed');
      await updateSession(id, { state: { state: hex(enc), sigP: hex(sigP), sigH: hex(sigH) }, last_activity: new Date() });
      return { sigH: hex(sigH) };
    });
  }

  private async liveRound(s: SessionRow, r: RoundRow) {
    const latest = mustDecodeState(s.state.state);
    if (!latest.game || latest.n.toString() !== r.n) throw new ApiError(409, 'round is not the active one');
    return latest;
  }

  /** A tile. Safe: a receipt. Mine: the seed and our signature on the loss state. */
  async reveal(id: string, roundId: string, body: { t?: unknown; p?: unknown; proof?: unknown }) {
    return withBet(id, async () => {
      const s = await this.mustGet(id);
      const r = await this.mustRound(s, roundId);
      const t = Number(body.t);
      if (!Number.isInteger(t) || t < 0 || t >= P.TILES) throw new ApiError(400, 't must be a tile 0..8');
      const p = hexN(body.p, 32, 'p');
      if (!Array.isArray(body.proof) || body.proof.length !== P.TREE_DEPTH) throw new ApiError(400, 'proof must have 4 hashes');
      const proof = body.proof.map((x, i) => hexN(x, 32, `proof[${i}]`));
      if (!r.root_q || !P.verifyMerkle(P.pickLeaf(t, p, H), t, proof, bytes(r.root_q), H)) throw new ApiError(400, 'pick secret does not match your commitment Q');

      const layout = P.buildLayout(bytes(r.seed_s), r.m, H);
      const prev = (await pool.query<{ safe: boolean }>('select safe from session_reveals where round_id = $1 and tile = $2', [roundId, t])).rows[0];
      if (prev?.safe) return { safe: true, receipt: receiptToJson(P.makeReceipt(layout, bytes(r.seed_c!), t, H)!) };
      if (prev && !prev.safe) return { safe: false, S: r.seed_s, sigH: s.pending?.sigH };
      if (r.status !== 'live' || s.status !== 'open') throw new ApiError(409, `round is ${r.status}`);
      const live = await this.liveRound(s, r);

      const j = P.tileMap(bytes(r.seed_c!), H)[t];
      const safe = layout.states[j] === 0;
      await pool.query('insert into session_reveals (round_id, tile, position, safe, pick_secret) values ($1, $2, $3, $4, $5)', [roundId, t, j, safe, hex(p)]);
      await updateSession(id, { last_activity: new Date() });
      if (safe) return { safe: true, receipt: receiptToJson(P.makeReceipt(layout, bytes(r.seed_c!), t, H)!) };

      const enc = PS.encodeState(settledState(live, 0n));
      const sigH = this.sign(sessionArgsFromJson(s.args), enc);
      await updateRound(roundId, { status: 'lost', hit_tile: t, paid: 0n, loss: { t, p: hex(p), proof: proof.map(hex) } }, 'live');
      await updateSession(id, { pending: { n: (live.n + 1n).toString(), state: hex(enc), sigH: hex(sigH) } });
      return { safe: false, S: r.seed_s, sigH: hex(sigH) };
    });
  }

  /** Ends the round as a win with the safe tiles we issued receipts for. */
  async cashOut(id: string, roundId: string, body: { k?: unknown }) {
    return withBet(id, async () => {
      const s = await this.mustGet(id);
      const r = await this.mustRound(s, roundId);
      if (r.status === 'won' && s.pending) return { k: r.k, S: r.seed_s, sigH: s.pending.sigH };
      if (r.status !== 'live' || s.status !== 'open') throw new ApiError(409, `round is ${r.status}`);
      const live = await this.liveRound(s, r);
      const k = Number((await pool.query<{ n: string }>('select count(*) as n from session_reveals where round_id = $1 and safe', [roundId])).rows[0].n);
      if (body.k !== undefined && Number(body.k) !== k) throw new ApiError(409, `we issued ${k} receipts, you claim ${body.k}`);
      const paid = P.payout(BigInt(r.stake), k, r.m).payout;
      const enc = PS.encodeState(settledState(live, paid));
      const sigH = this.sign(sessionArgsFromJson(s.args), enc);
      await updateRound(roundId, { status: 'won', k, paid }, 'live');
      await updateSession(id, { pending: { n: (live.n + 1n).toString(), state: hex(enc), sigH: hex(sigH) }, last_activity: new Date() });
      return { k, S: r.seed_s, sigH: hex(sigH) };
    });
  }

  /** The player's signature on the state that ended a round. */
  async ack(id: string, body: { n?: unknown; sigP?: unknown }) {
    return withBet(id, async () => {
      const s = await this.mustGet(id);
      const sigP = hexN(body.sigP, PS.SIG_LEN, 'sigP');
      const n = String(body.n);
      if (!s.pending) {
        if (mustDecodeState(s.state.state).n.toString() === n && s.state.sigP === hex(sigP)) return { ok: true };
        throw new ApiError(409, 'nothing to sign');
      }
      if (s.pending.n !== n) throw new ApiError(409, `pending state is ${s.pending.n}`);
      const args = sessionArgsFromJson(s.args);
      if (!checkStateSig(sigP, args.playerKeyHash, args, bytes(s.pending.state))) throw new ApiError(400, 'sigP does not sign the pending state');
      await updateSession(id, { state: { state: s.pending.state, sigP: hex(sigP), sigH: s.pending.sigH }, pending: null, last_activity: new Date() });
      return { ok: true };
    });
  }

  /** Cooperative withdrawal: we countersign the final state and broadcast the payout. */
  async withdraw(id: string, body: { sigP?: unknown }) {
    return withBet(id, async () => {
      const s = await this.mustGet(id);
      this.ready(s);
      const prev = mustDecodeState(s.state.state);
      if (prev.game) throw new ApiError(409, 'finish the round first');
      const args = sessionArgsFromJson(s.args);
      const enc = PS.encodeState(finalState(prev));
      const sigP = hexN(body.sigP, PS.SIG_LEN, 'sigP');
      if (!checkStateSig(sigP, args.playerKeyHash, args, enc)) throw new ApiError(400, 'sigP does not sign the final state');
      const sigH = this.sign(args, enc);
      const signed = { state: enc, sigP, sigH };
      await updateSession(id, { status: 'withdrawing', state: { state: hex(enc), sigP: hex(sigP), sigH: hex(sigH) } }, 'open');
      const txHash = await this.sendCoop({ ...s, state: { state: hex(enc), sigP: hex(sigP), sigH: hex(sigH) } }, signed).catch((e) => {
        void updateSession(id, { error: `coop close: ${String(e).slice(0, 300)}` });
        return null;
      });
      return { sigH: hex(sigH), txHash };
    });
  }

  async sendCoop(s: SessionRow, signed: SignedState): Promise<string> {
    const cell = await this.cell(s);
    if (!cell) throw new Error('session cell is not live');
    const tx = buildCoopCloseTx({ cell, parties: this.parties(s), signed });
    const txHash = await this.send(tx);
    await updateSession(s.id, { chain_tx: txHash });
    return txHash;
  }

  /** Frees the house cells reserved for a deposit that never went out. */
  async releaseAll(keys: string | null) {
    for (const k of keys?.split(',') ?? []) await this.house.release(k);
  }

  async cell(s: SessionRow): Promise<SessionCell | null> {
    if (!s.cell) return null;
    const live = await this.client.getCellLive(outPointFromKey(s.cell), true);
    if (!live) return null;
    return { outPoint: live.outPoint, capacity: live.cellOutput.capacity, args: sessionArgsFromJson(s.args), data: bytes(live.outputData) };
  }

  async send(tx: ccc.Transaction): Promise<string> {
    try {
      return await this.client.sendTransaction(tx);
    } catch (e) {
      if (/Duplicated|already exist/i.test(String(e))) return tx.hash();
      throw e;
    }
  }

  async view(id: string) {
    const s = await this.mustGet(id);
    const st = mustDecodeState(s.state.state);
    const rounds = (await pool.query<RoundRow>("select * from session_rounds where session_id = $1 and status <> 'abandoned' order by created_at desc limit 50", [id])).rows;
    return {
      id: s.id,
      status: s.status,
      n: st.n.toString(),
      p: st.p.toString(),
      h: st.h.toString(),
      final: st.final,
      pending: s.pending?.n ?? null,
      cell: s.cell ? { txHash: s.cell.split(':')[0], index: s.cell.split(':')[1] } : null,
      depositTx: s.deposit_tx,
      closeTx: s.close_tx,
      paidPlayer: s.paid_player,
      rounds: rounds.map((r) => ({
        id: r.id,
        status: r.status,
        m: r.m,
        stake: r.stake,
        R: r.root_r,
        k: r.k,
        paid: r.paid,
        hit: r.hit_tile,
        // the seed is secret while the round is live
        S: r.status === 'won' || r.status === 'lost' ? r.seed_s : null,
      })),
      error: s.error,
    };
  }
}
