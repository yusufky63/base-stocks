/**
 * Store the app's CRON_SECRET in Supabase Vault under the name `cron_secret`, which is what the
 * pg_cron jobs (migration `pg_cron_app_schedules`) read before calling the cron routes.
 *
 * Usage: node scripts/vault-cron-secret.mjs
 * Reads CRON_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, falling
 * back to .env, and calls the service-role-only RPC `app_store_cron_secret` over PostgREST (the
 * direct database host is IPv6-only). Prints lengths only, never a value. Idempotent.
 */
import { existsSync, readFileSync } from "node:fs";

function fromDotEnv() {
  if (!existsSync(".env")) return {};
  return Object.fromEntries(
    readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        let v = l.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return [l.slice(0, i), v];
      }),
  );
}

const env = { ...fromDotEnv(), ...process.env };
const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, CRON_SECRET: secret } = env;
if (!url || !key || !secret) {
  console.error(`missing: ${!url ? "SUPABASE_URL " : ""}${!key ? "SUPABASE_SERVICE_ROLE_KEY " : ""}${!secret ? "CRON_SECRET" : ""}`);
  process.exit(1);
}
console.log(`CRON_SECRET length ${secret.length}`);
const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/app_store_cron_secret`, {
  method: "POST",
  headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ value: secret }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(`vault readback length ${text.trim()} (must equal ${secret.length})`);
