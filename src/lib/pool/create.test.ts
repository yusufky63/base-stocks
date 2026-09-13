import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { AppError } from "@/lib/errors";
import { checkPoolCreate, poolCreateSchema, type PoolCreateBody } from "./create";

const CREATOR = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const AAPL = "0xb200000000000000000000C4d72dE09E9c6d1F4b";
const KEY = "0x000000000000000000000000000000000000bEEF" as Address;
const SIGNER = "0x000000000000000000000000000000000000c0de" as Address;
const NOW = 1_700_000_000_000;

const body = (over: Partial<PoolCreateBody> = {}): PoolCreateBody =>
  poolCreateSchema.parse({
    creator: CREATOR,
    gateMode: "open",
    slots: 10,
    legs: [{ token: NVDA, amountPerClaim: "1000000" }],
    expiry: NOW + 86_400_000,
    ...over,
  });

const reject = (b: PoolCreateBody, env = { now: NOW, gateSigner: SIGNER as Address | null }) => {
  try {
    checkPoolCreate(b, env);
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected a refusal");
};

describe("pool creation: the schema", () => {
  it("normalises addresses and fills the defaults", () => {
    const b = body();
    expect(b.visibility).toBe("unlisted");
    expect(b.lockedUntil).toBe(0);
    expect(b.quests).toEqual([]);
  });
  it("refuses a javascript: link in a visit step, and a profile URL where a post is wanted", () => {
    expect(() => body({ gateMode: "signer", quests: [{ type: "visit-url", url: "javascript:alert(1)" }] } as never)).toThrow();
    expect(() => body({ gateMode: "signer", quests: [{ type: "repost-x", tweetUrl: "https://x.com/someone" }] } as never)).toThrow();
    expect(body({ gateMode: "signer", quests: [{ type: "visit-url", url: "https://example.com/post" }] } as never).quests).toHaveLength(1);
  });
});

describe("pool creation: the rules", () => {
  it("accepts an open pool and stores address(0) as its gate", () => {
    expect(checkPoolCreate(body(), { now: NOW, gateSigner: SIGNER })).toEqual({ gateAddress: "0x0000000000000000000000000000000000000000" });
  });
  it("bounds the claim window to the next year", () => {
    expect(reject(body({ expiry: NOW - 1 })).httpStatus).toBe(400);
    expect(reject(body({ expiry: NOW + 400 * 86_400_000 })).message).toMatch(/within the next year/);
  });
  it("refuses a lock that outlasts the window", () => {
    expect(reject(body({ lockedUntil: NOW + 2 * 86_400_000 })).message).toMatch(/lock cannot outlast/);
  });
  it("refuses a repeated stock and a zero share", () => {
    expect(reject(body({ legs: [{ token: NVDA, amountPerClaim: "1" }, { token: NVDA.toLowerCase(), amountPerClaim: "1" }] } as never)).message).toMatch(/only appear once/);
    expect(reject(body({ legs: [{ token: NVDA, amountPerClaim: "0" }] } as never)).message).toMatch(/greater than zero/);
    expect(checkPoolCreate(body({ legs: [{ token: NVDA, amountPerClaim: "1" }, { token: AAPL, amountPerClaim: "2" }] } as never), { now: NOW, gateSigner: null }).gateAddress).toBeDefined();
  });
  it("a link pool needs its claim key, and stores it as the gate", () => {
    expect(reject(body({ gateMode: "link" })).message).toMatch(/claim key/);
    expect(checkPoolCreate(body({ gateMode: "link", gateAddress: KEY } as never), { now: NOW, gateSigner: null })).toEqual({ gateAddress: KEY });
  });
  it("a quest pool needs the campaign signer and at least one step, and stores the signer as the gate", () => {
    expect(reject(body({ gateMode: "signer", quests: [{ type: "sign-in" }] } as never), { now: NOW, gateSigner: null }).httpStatus).toBe(503);
    expect(reject(body({ gateMode: "signer" })).message).toMatch(/at least one requirement/);
    expect(checkPoolCreate(body({ gateMode: "signer", quests: [{ type: "hold-basename" }] } as never), { now: NOW, gateSigner: SIGNER })).toEqual({ gateAddress: SIGNER });
  });
  it("an open pool cannot carry quests: nothing would check them", () => {
    expect(reject(body({ quests: [{ type: "sign-in" }] } as never)).message).toMatch(/cannot check anything/);
  });
});
