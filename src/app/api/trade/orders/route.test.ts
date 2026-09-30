import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex, type Address, type Hex } from "viem";

/**
 * `verifyAppData`: the integrator fee rides in a CoW order's app-data document, so the document a
 * signed order carries must be exactly the one this server issues. The environment is a double;
 * nothing here reaches the order book.
 */
const h = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));

vi.mock("@/config/env", () => ({ serverEnv: () => h.env }));
vi.mock("@/services/b20-guard-service", () => ({ b20Guard: { preTradeCheck: vi.fn() } }));

import { AppError } from "@/lib/errors";
import { appDataFor } from "@/providers/trading/cow/adapter";
import { verifyAppData } from "./route";

const FEE_RECIPIENT = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const ATTACKER = "0x3333333333333333333333333333333333333333" as Address;

type OrderClass = "market" | "limit";
const hashOf = (doc: string) => keccak256(toHex(doc));

/** An order as the browser submits it: the document, its hash, and the hash inside the signed message. */
const order = (appData: string, opts: { orderClass?: OrderClass; hash?: Hex; signed?: Hex } = {}) => {
  const hash = opts.hash ?? hashOf(appData);
  return { orderClass: opts.orderClass ?? "market", appData, appDataHash: hash, typedData: { message: { appData: opts.signed ?? hash } } };
};

/** The issued document with its metadata edited, re-serialised and re-hashed the way a client could. */
const tampered = (edit: (meta: Record<string, unknown>) => void, orderClass: OrderClass = "market", slippage = 50) => {
  const doc = JSON.parse(appDataFor(orderClass, slippage).doc) as { metadata: Record<string, unknown> };
  edit(doc.metadata);
  return order(JSON.stringify(doc), { orderClass });
};

function refusal(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(400);
    expect((err as AppError).code).toBe("BAD_REQUEST");
    return (err as AppError).message;
  }
  throw new Error("expected verifyAppData to refuse the order");
}
const NOT_OURS = /not what this server issues/;

beforeEach(() => {
  h.env = { INTEGRATOR_FEE_BPS: 25, INTEGRATOR_FEE_RECIPIENT: FEE_RECIPIENT };
});

describe("verifyAppData with an integrator fee configured", () => {
  it("the issued document carries the configured fee", () => {
    const meta = JSON.parse(appDataFor("market", 50).doc).metadata;
    expect(meta).toEqual({ orderClass: { orderClass: "market" }, quote: { slippageBips: 50 }, partnerFee: { bps: 25, recipient: FEE_RECIPIENT } });
    expect(JSON.parse(appDataFor("limit", 50).doc).metadata).toEqual({ orderClass: { orderClass: "limit" }, partnerFee: { bps: 25, recipient: FEE_RECIPIENT } });
  });

  it("accepts the document the server issued, for a market and a limit order", () => {
    expect(() => verifyAppData(order(appDataFor("market", 50).doc))).not.toThrow();
    expect(() => verifyAppData(order(appDataFor("limit", 0).doc, { orderClass: "limit" }))).not.toThrow();
  });

  it("accepts any slippage the quote could have been asked with, and hashes in either case", () => {
    for (const bips of [0, 1, 300, 10_000]) expect(() => verifyAppData(order(appDataFor("market", bips).doc))).not.toThrow();
    const issued = appDataFor("market", 50);
    const upper = `0x${issued.hash.slice(2).toUpperCase()}` as Hex;
    expect(() => verifyAppData(order(issued.doc, { hash: upper, signed: upper }))).not.toThrow();
  });

  it("refuses a document with the fee removed", () => {
    expect(refusal(() => verifyAppData(tampered((m) => delete m.partnerFee)))).toMatch(NOT_OURS);
    expect(refusal(() => verifyAppData(tampered((m) => delete m.partnerFee, "limit")))).toMatch(NOT_OURS);
  });

  it("refuses a document with the fee lowered or zeroed", () => {
    expect(refusal(() => verifyAppData(tampered((m) => (m.partnerFee = { bps: 10, recipient: FEE_RECIPIENT }))))).toMatch(NOT_OURS);
    expect(refusal(() => verifyAppData(tampered((m) => (m.partnerFee = { bps: 0, recipient: FEE_RECIPIENT }))))).toMatch(NOT_OURS);
  });

  it("refuses a document that pays the fee to another recipient", () => {
    expect(refusal(() => verifyAppData(tampered((m) => (m.partnerFee = { bps: 25, recipient: ATTACKER }))))).toMatch(NOT_OURS);
    expect(refusal(() => verifyAppData(tampered((m) => (m.partnerFee = { bps: 25, recipient: FEE_RECIPIENT.toLowerCase() }))))).toMatch(NOT_OURS);
  });

  it("refuses a second fee added beside ours, and the same content serialised differently", () => {
    expect(refusal(() => verifyAppData(tampered((m) => (m.partnerFee = [{ bps: 25, recipient: FEE_RECIPIENT }, { bps: 50, recipient: ATTACKER }]))))).toMatch(NOT_OURS);
    const pretty = JSON.stringify(JSON.parse(appDataFor("market", 50).doc), null, 2);
    expect(refusal(() => verifyAppData(order(pretty)))).toMatch(NOT_OURS);
  });

  it("refuses a hash that is not the document's", () => {
    const issued = appDataFor("market", 50);
    const other = hashOf("something else");
    expect(refusal(() => verifyAppData(order(issued.doc, { hash: other, signed: other })))).toMatch(NOT_OURS);
    // The document and its hash match, but the signed order commits to another document.
    expect(refusal(() => verifyAppData(order(issued.doc, { signed: other })))).toMatch(NOT_OURS);
    expect(refusal(() => verifyAppData(order(issued.doc, { hash: other, signed: issued.hash })))).toMatch(NOT_OURS);
  });

  it("refuses a market document that is not JSON or does not carry a usable slippage", () => {
    expect(refusal(() => verifyAppData(order("not json")))).toMatch(/not a JSON document/);
    expect(refusal(() => verifyAppData(order("null")))).toMatch(/does not carry the slippage/);
    for (const bad of [undefined, "50", 50.5, -1, 10_001, null]) {
      expect(refusal(() => verifyAppData(tampered((m) => (m.quote = { slippageBips: bad }))))).toMatch(/does not carry the slippage/);
    }
    expect(refusal(() => verifyAppData(tampered((m) => delete m.quote)))).toMatch(/does not carry the slippage/);
  });

  it("refuses a document issued for the other order class", () => {
    expect(refusal(() => verifyAppData(order(appDataFor("market", 50).doc, { orderClass: "limit" })))).toMatch(NOT_OURS);
    expect(refusal(() => verifyAppData(order(appDataFor("limit", 50).doc, { orderClass: "market" })))).toMatch(/does not carry the slippage/);
  });

  it("refuses a document issued while the fee was different", () => {
    h.env = { INTEGRATOR_FEE_BPS: 10, INTEGRATOR_FEE_RECIPIENT: FEE_RECIPIENT };
    const stale = order(appDataFor("market", 50).doc);
    h.env = { INTEGRATOR_FEE_BPS: 25, INTEGRATOR_FEE_RECIPIENT: FEE_RECIPIENT };
    expect(refusal(() => verifyAppData(stale))).toMatch(NOT_OURS);
  });
});

describe("verifyAppData with no integrator fee", () => {
  it.each([
    ["nothing configured", {}],
    ["a rate without a recipient", { INTEGRATOR_FEE_BPS: 25 }],
    ["a recipient without a rate", { INTEGRATOR_FEE_RECIPIENT: FEE_RECIPIENT }],
    ["a zero rate", { INTEGRATOR_FEE_BPS: 0, INTEGRATOR_FEE_RECIPIENT: FEE_RECIPIENT }],
  ])("%s: the issued document has no fee and passes", (_label, env) => {
    h.env = env;
    const issued = appDataFor("market", 50);
    expect(JSON.parse(issued.doc).metadata.partnerFee).toBeUndefined();
    expect(() => verifyAppData(order(issued.doc))).not.toThrow();
  });

  it("refuses a document that adds a fee of its own", () => {
    h.env = {};
    expect(refusal(() => verifyAppData(tampered((m) => (m.partnerFee = { bps: 100, recipient: ATTACKER }))))).toMatch(NOT_OURS);
  });

  it("falls back to the 0x fee settings when the integrator ones are unset", () => {
    h.env = { ZEROX_SWAP_FEE_BPS: 15, ZEROX_SWAP_FEE_RECIPIENT: FEE_RECIPIENT };
    expect(JSON.parse(appDataFor("market", 50).doc).metadata.partnerFee).toEqual({ bps: 15, recipient: FEE_RECIPIENT });
    expect(refusal(() => verifyAppData(tampered((m) => delete m.partnerFee)))).toMatch(NOT_OURS);
  });
});
