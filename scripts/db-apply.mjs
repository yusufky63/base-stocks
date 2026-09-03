/**
 * Apply supabase/schema.sql to a Postgres database.
 * Usage: DATABASE_URL=postgresql://... pnpm db:apply
 * (Supabase → Project Settings → Database → Connection string; use the "session" pooler or direct URL.)
 * Idempotent: the schema only uses CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (Supabase → Project Settings → Database → Connection string).");
  process.exit(1);
}
const sql = readFileSync(join(here, "..", "supabase", "schema.sql"), "utf8");
const client = new pg.Client({ connectionString: url, ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  const { rows } = await client.query("select table_name from information_schema.tables where table_schema = 'public' order by table_name");
  console.log("Schema applied. Tables:", rows.map((r) => r.table_name).join(", "));
} catch (err) {
  await client.query("rollback").catch(() => undefined);
  console.error("Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await client.end();
}
