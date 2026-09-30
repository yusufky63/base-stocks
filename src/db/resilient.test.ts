import { describe, expect, it } from "vitest";
import { StorageError, resilient } from "./resilient";

/**
 * A durable write must never answer "saved" for a row that did not land. It used to: every failed
 * insert fell back to returning its input, so a trade filed during a Supabase blip was lost with a
 * 201 and nothing but an in-memory counter to show for it.
 */
class FailingRepo {
  constructor(private readonly error: unknown) {}
  async create(row: { id: string }) {
    void row;
    throw this.error;
  }
  async list(): Promise<string[]> {
    throw this.error;
  }
}

const pgError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});
const wrap = (error: unknown) => resilient("trades", new FailingRepo(error), { create: (r: { id: string }) => r, list: [] }, { durable: ["create"] });

describe("resilient", () => {
  it("raises a durable write's failure as a StorageError that keeps the Postgres code", async () => {
    const repo = wrap(pgError("connection terminated unexpectedly", "08006"));
    const err = await repo.create({ id: "t1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe("08006");
    expect((err as StorageError).message).toContain("trades.create");
  });

  it("still falls back when the table does not exist: the feature is not set up here", async () => {
    const repo = wrap(pgError('relation "public.trade_records" does not exist', "42P01"));
    await expect(repo.create({ id: "t1" })).resolves.toEqual({ id: "t1" });
  });

  it("treats a duplicate as already stored, the way a retried request expects", async () => {
    const repo = wrap(pgError('duplicate key value violates unique constraint "trade_records_pkey"', "23505"));
    await expect(repo.create({ id: "t1" })).resolves.toEqual({ id: "t1" });
  });

  it("keeps reads and non-durable writes on their fallbacks", async () => {
    const repo = wrap(pgError("fetch failed"));
    await expect(repo.list()).resolves.toEqual([]);
    const loose = resilient("cursors", new FailingRepo(pgError("fetch failed")), { create: (r: { id: string }) => r });
    await expect(loose.create({ id: "c1" })).resolves.toEqual({ id: "c1" });
  });
});
