import { ccc } from '@ckb-ccc/core';
import { H, P, bytes, outPointKey } from '@ckb-mines/chain';
import {
  buildCloseTx,
  buildSessionLossTx,
  buildSessionReceiptsTx,
  buildSessionSettleTx,
  closingOf,
  committedAt,
  followSessionCell,
  mustDecodeState,
  postedState,
  sessionArgsFromJson,
  stateHashFor,
  type SessionCell,
} from '@ckb-mines/chain/session';
import { withBet } from './bets';
import { config } from './config';
import { pool, updateSession, type RoundRow, type SessionRow } from './db';
import { Sessions } from './sessions';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[session]', ...a);

/** Block median time lags the wall clock; settle this long after the window to avoid an immature since. */
const SINCE_LAG_MS = 150_000;

/**
 * Moves sessions forward from what the chain says, and defends the operator's balance:
 * answers a stale close with our latest state, posts loss proofs, settles after the window,
 * and closes idle sessions. Safe to run after a restart: everything is in the database.
 */
export class SessionWatcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastCheck = new Map<string, number>();

  constructor(private readonly sessions: Sessions) {}

  start() {
    this.timer = setInterval(() => void this.tick(), config.watchIntervalMs);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  private get client(): ccc.Client {
    return this.sessions.client;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = (
        await pool.query<SessionRow>("select * from sessions where status in ('committed', 'opening', 'open', 'withdrawing', 'closing') order by created_at")
      ).rows;
      for (const s of rows) {
        try {
          await withBet(s.id, () => this.step(s.id));
        } catch (e) {
          log(s.id, s.status, 'error', String(e).slice(0, 300));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async step(id: string) {
    const s = (await pool.query<SessionRow>('select * from sessions where id = $1', [id])).rows[0];
    const age = (Date.now() - s.updated_at.getTime()) / 1000;
    if (s.status === 'committed') {
      if (age > config.commitTimeoutSeconds) {
        await updateSession(id, { status: 'expired' }, 'committed');
        await this.sessions.releaseAll(s.house_in);
        log(id, 'expired, house cell released');
      }
      return;
    }
    if (s.status === 'opening') {
      const r = await this.client.getTransaction(s.deposit_tx!);
      if (r?.status === 'committed') {
        const at = await committedAt(this.client, s.deposit_tx!);
        await updateSession(id, { status: 'open', cell_at: new Date(at ?? Date.now()), last_activity: new Date() }, 'opening');
        log(id, 'open', s.deposit_tx);
      } else if (r?.status === 'rejected' || (!r && age > 600)) {
        await updateSession(id, { status: 'failed', error: `deposit tx ${r?.status ?? 'unknown'}` }, 'opening');
        await this.sessions.releaseAll(s.house_in);
        log(id, 'deposit', r?.status ?? 'unknown');
      }
      return;
    }
    // open sessions are checked every 15 s; withdrawals and disputes on every tick
    if (s.status === 'open') {
      const last = this.lastCheck.get(id) ?? 0;
      if (Date.now() - last < 15_000) return;
      this.lastCheck.set(id, Date.now());
    }
    if (await this.inFlight(s)) return;
    await this.follow(s);
  }

  /** True while our last transition is still on its way. */
  private async inFlight(s: SessionRow): Promise<boolean> {
    if (!s.chain_tx) return false;
    const r = await this.client.getTransaction(s.chain_tx);
    if (r && ['pending', 'proposed'].includes(r.status)) return true;
    if (r?.status === 'rejected' || !r) {
      log(s.id, 'our tx', s.chain_tx, r?.status ?? 'unknown', r?.reason ?? '');
    }
    await updateSession(s.id, { chain_tx: null });
    return false;
  }

  private async follow(s: SessionRow) {
    const args = sessionArgsFromJson(s.args);
    let cellKey = s.cell!;
    let f = await followSessionCell(this.client, args, ccc.OutPoint.from({ txHash: cellKey.split(':')[0], index: BigInt(cellKey.split(':')[1]) }));
    while (f.kind === 'spent' && f.next) {
      if (!f.nextCommitted) return;
      cellKey = outPointKey(f.next.outPoint);
      const at = await committedAt(this.client, f.txHash);
      await updateSession(s.id, { cell: cellKey, cell_at: new Date(at ?? Date.now()) });
      s.cell = cellKey;
      s.cell_at = new Date(at ?? Date.now());
      log(s.id, 'session cell moved', f.txHash);
      f = await followSessionCell(this.client, args, f.next.outPoint);
    }
    if (f.kind === 'unknown') return;
    if (f.kind === 'spent') {
      const r = await this.client.getTransaction(f.txHash);
      if (r?.status !== 'committed') return;
      const playerLock = ccc.Script.from(s.player_lock);
      const paid = r.transaction.outputs.filter((o) => o.lock.eq(playerLock)).reduce((a, o) => a + o.capacity, 0n);
      await updateSession(s.id, { status: 'closed', close_tx: f.txHash, paid_player: paid, chain_tx: null, error: null });
      log(s.id, 'closed', f.txHash, 'player got', ccc.fixedPointToString(paid));
      return;
    }

    const cell = f.cell;
    const closing = closingOf(cell);
    if (!closing) {
      if (s.status === 'withdrawing') {
        const latest = this.sessions.latest(s);
        const txHash = await this.sessions.sendCoop(s, latest);
        log(s.id, 'coop close sent', txHash);
        return;
      }
      const idle = (Date.now() - s.last_activity.getTime()) / 1000 > config.sessionIdleSeconds;
      if (idle) {
        const txHash = await this.post(s, buildCloseTx({ cell, signed: this.sessions.latest(s) }));
        await updateSession(s.id, { status: 'closing' });
        log(s.id, 'idle: closed unilaterally', txHash);
      }
      return;
    }
    if (s.status !== 'closing') {
      await updateSession(s.id, { status: 'closing' });
      log(s.id, 'closing on chain', outPointKey(cell.outPoint), 'posted n', closing.n);
    }
    await this.defend(s, cell);
  }

  private async post(s: SessionRow, tx: ccc.Transaction): Promise<string> {
    const txHash = await this.sessions.send(tx);
    await updateSession(s.id, { chain_tx: txHash });
    return txHash;
  }

  private async defend(s: SessionRow, cell: SessionCell) {
    const c = closingOf(cell)!;
    const latest = this.sessions.latest(s);
    const ours = mustDecodeState(latest.state);
    if (ours.n > c.n) {
      log(s.id, 'stale close at n', c.n, '-> posting n', ours.n, await this.post(s, buildCloseTx({ cell, signed: latest })));
      return;
    }
    const posted = P.bytesEqual(c.stateHash, stateHashFor(cell.args, latest.state)) ? latest.state : await postedState(this.client, cell);
    if (!posted) return;
    const st = mustDecodeState(posted);

    if (st.game && !c.lossProven) {
      const round = (
        await pool.query<RoundRow>('select * from session_rounds where session_id = $1 and n = $2', [s.id, st.n.toString()])
      ).rows[0];
      if (round?.status === 'lost' && round.loss) {
        const tx = buildSessionLossTx({ cell, state: posted, S: bytes(round.seed_s), t: round.loss.t, p: bytes(round.loss.p), pickProof: round.loss.proof.map(bytes) });
        log(s.id, 'posting loss proof', await this.post(s, tx));
        return;
      }
      // a win the player never countersigned: post the receipts we issued, so it is paid as the rules say
      if (round?.status === 'won' && (round.k ?? 0) > 0 && c.k === 0) {
        const layout = P.buildLayout(bytes(round.seed_s), round.m, H);
        const tiles = (await pool.query<{ tile: number }>('select tile from session_reveals where round_id = $1 and safe order by created_at', [round.id])).rows;
        const receipts = tiles.map((t) => P.makeReceipt(layout, bytes(round.seed_c!), t.tile, H)!);
        log(s.id, 'posting receipts for an unsigned win', await this.post(s, buildSessionReceiptsTx({ cell, state: posted, receipts })));
        return;
      }
    }

    const due = (s.cell_at?.getTime() ?? Date.now()) + Number(cell.args.dChallenge) * 1000 + SINCE_LAG_MS;
    if (Date.now() < due) return;
    try {
      const tx = buildSessionSettleTx({ cell, parties: this.sessions.parties(s), state: posted });
      log(s.id, 'settling', await this.post(s, tx));
    } catch (e) {
      await updateSession(s.id, { error: `settle: ${String(e).slice(0, 300)}` });
      log(s.id, 'settle not accepted yet', String(e).slice(0, 200));
    }
  }
}
