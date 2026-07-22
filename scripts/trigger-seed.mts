import "dotenv/config";
import { ensureSeeded } from "../server/seed/runSeeders";

const t0 = Date.now();
await ensureSeeded();
console.log(`Seed done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
