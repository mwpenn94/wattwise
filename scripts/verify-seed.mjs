import mysql from "mysql2/promise";
import { readFileSync } from "fs";

let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
  dbUrl = envText.match(/^DATABASE_URL=(.*)$/m)?.[1]?.replace(/^"|"$/g, "");
}
const conn = await mysql.createConnection(dbUrl);
const [rows] = await conn.query(`
  SELECT
    (SELECT COUNT(*) FROM tariffs) AS total_tariffs,
    (SELECT COUNT(DISTINCT state) FROM tariffs) AS tariff_states,
    (SELECT COUNT(DISTINCT utilityName) FROM tariffs) AS utilities,
    (SELECT COUNT(*) FROM weather_normals) AS stations,
    (SELECT COUNT(DISTINCT climateZone) FROM weather_normals) AS zones,
    (SELECT COUNT(*) FROM emissions_factors) AS egrid_rows
`);
console.log(JSON.stringify(rows[0], null, 2));
const [sample] = await conn.query(
  "SELECT state, utilityName, name, sector FROM tariffs WHERE state IN ('NY','TX','CA','FL') ORDER BY state, name LIMIT 12",
);
console.table(sample);
await conn.end();
