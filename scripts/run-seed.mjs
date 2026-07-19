// One-off seeder trigger: runs ensureSeeded() to completion and exits.
// Usage: npx tsx scripts/run-seed.mjs
import { ensureSeeded } from "../server/seed/runSeeders";

const t0 = Date.now();
await ensureSeeded();
console.log(`[run-seed] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
