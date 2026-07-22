import "dotenv/config";
import { getDb } from "../server/db";
import { tariffs } from "../drizzle/schema";
import { like, or } from "drizzle-orm";

const db = await getDb();
const rows = await db.select({ id: tariffs.id, u: tariffs.utilityName, n: tariffs.name, sec: tariffs.sector, st: tariffs.state, c: tariffs.commodity }).from(tariffs).where(or(like(tariffs.utilityName, "%UniSource%"), like(tariffs.utilityName, "%UNS%")));
console.log(JSON.stringify(rows, null, 1));
process.exit(0);
