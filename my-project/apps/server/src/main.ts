import { Game } from './bets';
import { config } from './config';
import { migrate, pool } from './db';
import { House } from './house';
import { buildApp } from './http';
import { Watcher } from './watcher';
import { Sessions } from './sessions';
import { SessionWatcher } from './session-watcher';

async function main() {
  await migrate();
  const house = await House.create();
  const game = new Game(house);
  const watcher = new Watcher(game);
  const sessions = new Sessions(house);
  const sessionWatcher = new SessionWatcher(sessions);
  const app = await buildApp(game, sessions);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  watcher.start();
  sessionWatcher.start();
  console.log(
    `CKB Mines server on :${config.port} | house ${await house.signer.getRecommendedAddress()} | T_play ${config.tPlaySeconds}s D_exit ${config.dExitSeconds}s D_forfeit ${config.dForfeitSeconds}s D_challenge ${config.dChallengeSeconds}s idle ${config.sessionIdleSeconds}s`,
  );
  const shutdown = async () => {
    watcher.stop();
    sessionWatcher.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
