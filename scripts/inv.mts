import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
const db = await getDb();
if (!db) throw new Error("no db");
const rows = await db.execute(sql`SELECT source, freshness, commodity, COUNT(*) AS n FROM tariffs GROUP BY source, freshness, commodity ORDER BY n DESC`);
console.log(JSON.stringify((rows as any)[0], null, 1));
process.exit(0);
