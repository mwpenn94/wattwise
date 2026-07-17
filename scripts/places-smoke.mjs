// Live smoke test for the Places proxy path used by server/places.ts.
// Run: node scripts/places-smoke.mjs "1600 Pennsylvania Ave"
// Env: expects BUILT_IN_FORGE_API_URL / BUILT_IN_FORGE_API_KEY in process env.
import { readFileSync } from "fs";

let base = process.env.BUILT_IN_FORGE_API_URL;
let key = process.env.BUILT_IN_FORGE_API_KEY;
if (!base || !key) {
  // Dev convenience: parse the local env file (read-only) like the server does.
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (!m) continue;
      if (m[1] === "BUILT_IN_FORGE_API_URL") base = base || m[2];
      if (m[1] === "BUILT_IN_FORGE_API_KEY") key = key || m[2];
    }
  } catch {
    /* fall through */
  }
}
if (!base || !key) {
  console.error("Missing BUILT_IN_FORGE_API_URL / BUILT_IN_FORGE_API_KEY");
  process.exit(1);
}
const q = process.argv[2] ?? "500 N Central Ave, Phoenix";

async function req(path, params) {
  const url = new URL(`${base.replace(/\/+$/, "")}/v1/maps/proxy${path}`);
  url.searchParams.set("key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const ac = await req("/maps/api/place/autocomplete/json", { input: q, types: "address", components: "country:us" });
console.log("autocomplete status:", ac.status, "predictions:", (ac.predictions ?? []).length);
for (const p of (ac.predictions ?? []).slice(0, 3)) console.log("  -", p.description);
const first = ac.predictions?.[0];
if (first) {
  const det = await req("/maps/api/place/details/json", {
    place_id: first.place_id,
    fields: "place_id,formatted_address,address_component,geometry,type",
  });
  console.log("details status:", det.status);
  const comps = det.result?.address_components ?? [];
  const get = (t) => comps.find((c) => c.types.includes(t));
  console.log("  formatted:", det.result?.formatted_address);
  console.log("  state:", get("administrative_area_level_1")?.short_name, "zip:", get("postal_code")?.long_name, "city:", get("locality")?.long_name);
  console.log("  types:", det.result?.types);
}
