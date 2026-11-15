import { ccc } from '@ckb-ccc/core';
import { argsFromJson, betLock } from '@ckb-mines/chain';
import { Game, withBet } from './bets';
import { config } from './config';
import { pool, updateBet, type BetRow } from './db';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[watch]', ...a);

/** Moves bets forward from what the chain says. Safe to run after a restart: everything is in the database. */
export class Watcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastLiveCheck = new Map<string, number>();

  constructor(private readonly game: Game) {}

  start() {
    this.timer = setInterval(() => void this.tick(), config.watchIntervalMs);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  private get client(): ccc.Client {
    return this.game.client;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = (
        await pool.query<BetRow>(
          "select * from bets where status in ('committed', 'opening', 'open', 'cashing', 'settling', 'losing', 'forfeiting') order by created_at",
        )
      ).rows;
      for (const b of rows) {
        try {
          await withBet(b.id, () => this.step(b));
        } catch (e) {
          log(b.id, b.status, 'error', String(e).slice(0, 300));
        }
      }
      await this.game.house.pruneReservations();
    } finally {
      this.running = false;
    }
  }

  private async txState(hash: string): Promise<{ status: string; blockHash?: string }> {
    const r = await this.client.getTransaction(hash);
    if (!r) return { status: 'unknown' };
    return { status: r.status, blockHash: r.blockHash ?? undefined };
  }

  private async step(stale: BetRow) {
    const b = (await pool.query<BetRow>('select * from bets where id = $1', [stale.id])).rows[0];
    const age = (Date.now() - b.updated_at.getTime()) / 1000;
    switch (b.status) {
      case 'committed':
        if (age > config.commitTimeoutSeconds) {
          await updateBet(b.id, { status: 'expired' }, 'committed');
          await this.game.house.release(b.house_in);
          log(b.id, 'expired, house cell released');
        }
        return;
      case 'opening': {
        const s = await this.txState(b.bet_tx!);
        if (s.status === 'committed') {
          const header = await this.client.getHeaderByHash(s.blockHash!);
          const openedAt = new Date(Number(header!.timestamp));
          await updateBet(b.id, { status: 'open', opened_at: openedAt }, 'opening');
          log(b.id, 'open', b.bet_tx);
        } else if (s.status === 'rejected' || (s.status === 'unknown' && age > 600)) {
          await updateBet(b.id, { status: 'failed', error: `bet tx ${s.status}` }, 'opening');
          log(b.id, 'bet tx', s.status);
        }
        return;
      }
      case 'cashing':
        // the player never returned the signed cash-out
        if (age > 120) {
          await this.game.house.release(b.settle_house_in);
          await updateBet(b.id, { status: 'open', settle_draft: null, settle_path: null, settle_house_in: null, payout: null }, 'cashing');
        }
        return;
      case 'settling':
      case 'losing':
      case 'forfeiting': {
        const s = await this.txState(b.settle_tx!);
        const done = { settling: 'won', losing: 'lost', forfeiting: 'forfeited' }[b.status as 'settling'];
        if (s.status === 'committed') {
          await updateBet(b.id, { status: done }, b.status);
          log(b.id, done, b.settle_tx);
        } else if (s.status === 'rejected' || (s.status === 'unknown' && age > 600)) {
          // back to open: a loss is re-claimed on the next reveal retry or forfeit, a cash-out can be asked again
          await this.game.house.release(b.settle_house_in);
          await updateBet(b.id, { status: 'open', error: `settle tx ${s.status}`, settle_tx: null, settle_path: null, settle_house_in: null }, b.status);
          log(b.id, 'settle tx', s.status, 'back to open');
        }
        return;
      }
      case 'open':
        await this.checkOpen(b);
        return;
    }
  }

  private async checkOpen(b: BetRow) {
    const openedMs = b.opened_at!.getTime();
    const forfeitAt = openedMs + Number(b.d_forfeit) * 1000 + 120_000;
    // check at most every 15 s whether the player exited alone (path C)
    const last = this.lastLiveCheck.get(b.id) ?? 0;
    if (Date.now() - last > 15_000) {
      this.lastLiveCheck.set(b.id, Date.now());
      const live = await this.client.getCellLive({ txHash: b.bet_tx!, index: 0 }, false);
      if (!live) {
        const spender = await this.findSpender(b);
        await updateBet(b.id, { status: 'exited', settle_path: 'C', settle_tx: spender }, 'open');
        log(b.id, 'exited by the player', spender);
        return;
      }
    }
    if (Date.now() > forfeitAt) await this.game.forfeit(b);
  }

  private async findSpender(b: BetRow): Promise<string | null> {
    const lock = betLock(argsFromJson(b.args!));
    for await (const t of this.client.findTransactions({ script: lock, scriptType: 'lock', scriptSearchMode: 'exact' }, 'desc', 10)) {
      if (t.isInput && t.txHash !== b.bet_tx) return t.txHash;
    }
    return null;
  }
}
