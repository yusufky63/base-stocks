import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { callAfterApproval } from "./execute";

const ACCOUNT = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const TARGET = "0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10" as Address;

/** What a node a block behind our own approval actually returns: the B20 selector, unwrapped. */
const STALE_ALLOWANCE = () => new Error("execution reverted: custom error 0x192b9e4e");
/** What a router that pulls via TransferHelper returns on the same stale state: a bare revert. */
const GENERIC_REVERT = () => new Error("execution reverted");

function clientThatFails(times: number, then: () => void = () => {}, makeError: () => Error = STALE_ALLOWANCE) {
  let calls = 0;
  const client = {
    call: async () => {
      calls += 1;
      if (calls <= times) throw makeError();
      then();
      return { data: undefined };
    },
  };
  return { client: client as unknown as PublicClient, calls: () => calls };
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Creating a gift pool once failed with "InsufficientAllowance" straight after its own approvals
 * were mined, and succeeded on a retry. The fallback transport spreads reads across RPCs, so the
 * node answering the simulation can be a block behind the one that gave us the receipt. These
 * cover the helper that absorbs that, because nothing did.
 */
describe("callAfterApproval", () => {
  it("passes straight through when the node is already caught up", async () => {
    const { client, calls } = clientThatFails(0);
    await expect(callAfterApproval(client, ACCOUNT, { to: TARGET, data: "0x" })).resolves.toBeUndefined();
    expect(calls()).toBe(1);
  });

  it("retries a stale allowance revert until the node catches up", async () => {
    vi.useFakeTimers();
    const { client, calls } = clientThatFails(2);
    const done = callAfterApproval(client, ACCOUNT, { to: TARGET, data: "0x" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toBeUndefined();
    expect(calls()).toBe(3);
  });

  it("absorbs more lag when given a bigger budget — a pool approves one token per leg", async () => {
    vi.useFakeTimers();
    const { client, calls } = clientThatFails(5);
    const done = callAfterApproval(client, ACCOUNT, { to: TARGET, data: "0x" }, 6);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBeUndefined();
    expect(calls()).toBe(6);
  });

  it("gives up once the budget is spent, so a real missing allowance still surfaces", async () => {
    vi.useFakeTimers();
    const { client, calls } = clientThatFails(99);
    const done = callAfterApproval(client, ACCOUNT, { to: TARGET, data: "0x" }, 2);
    // Attach the handler before advancing: the rejection lands inside the timer advance, and an
    // unobserved one there is reported as an unhandled rejection.
    const rejects = expect(done).rejects.toThrow(/0x192b9e4e/);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejects;
    expect(calls()).toBe(3); // the first try plus two retries
  });

  it("never retries a revert that is not about the allowance", async () => {
    const client = {
      call: async () => {
        throw new Error("execution reverted: custom error 0xa43fec12"); // PolicyForbids
      },
    } as unknown as PublicClient;
    await expect(callAfterApproval(client, ACCOUNT, { to: TARGET, data: "0x" })).rejects.toThrow(/0xa43fec12/);
  });

  // A router can revert stale allowance generically ("execution reverted", no allowance selector),
  // e.g. Uniswap's TransferHelper "STF" — the "fails on the first buy/sell, works on the next" case.
  it("does not retry a bare revert by default, so a genuine failure surfaces at once", async () => {
    const { client, calls } = clientThatFails(99, () => {}, GENERIC_REVERT);
    await expect(callAfterApproval(client, ACCOUNT, { to: TARGET, data: "0x" })).rejects.toThrow(/execution reverted/);
    expect(calls()).toBe(1);
  });

  it("retries a bare revert straight after an approval, when told one just landed", async () => {
    vi.useFakeTimers();
    const { client, calls } = clientThatFails(2, () => {}, GENERIC_REVERT);
    const done = callAfterApproval(client, ACCOUNT, { to: TARGET, data: "0x" }, 4, true);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toBeUndefined();
    expect(calls()).toBe(3);
  });
});
