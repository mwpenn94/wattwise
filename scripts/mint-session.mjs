// Mints signed session JWTs for virtual E2E test users (dev sandbox only).
// Usage: node scripts/mint-session.mjs <openId> <name>
import { SignJWT } from "jose";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

const [openId = "e2e-user", name = "E2E User"] = process.argv.slice(2);
const secret = process.env.JWT_SECRET;
const appId = process.env.VITE_APP_ID;
if (!secret || !appId) {
  console.error("JWT_SECRET / VITE_APP_ID missing");
  process.exit(1);
}
const key = new TextEncoder().encode(secret);
const token = await new SignJWT({ openId, appId, name })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setExpirationTime(Math.floor(Date.now() / 1000) + 86400)
  .sign(key);
console.log(token);
