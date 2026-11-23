// Background jobs. Phase 2: sweep expired holds every 30 s. Safe to run several copies.
import pg from 'pg';
import { sweep } from './holds.js';

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
if (!process.env.DATABASE_URL) { log('fatal', 'missing env var DATABASE_URL'); process.exit(1); }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', (err) => log('warn', 'idle postgres client error', { err: err.message }));

// ponytail: the seat map already shows expired holds as free (lazy), so the sweep pushes nothing. Phase 5 adds pushes.
async function tick() {
  try {
    const n = await sweep(pool);
    if (n.holds || n.seats) log('info', 'swept expired holds', n);
  } catch (err) {
    log('error', 'sweep failed', { err: err.message });
  }
}
const timer = setInterval(tick, Number(process.env.SWEEP_EVERY_MS ?? 30_000));
tick();

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { clearInterval(timer); await pool.end(); process.exit(0); });
