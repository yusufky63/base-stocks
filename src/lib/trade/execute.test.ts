import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hash, PublicClient, WalletClient } from "viem";

const ACCOUNT = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const TARGET = "0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hash;

/** The client API, replaced wholesale: the executor's only contact with the server. */
const apiPost = vi.fn();
vi.mock("@/lib/client-api", () => {
  class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { apiPost: (...args: unknown[]) => apiPost(...args), apiGet: vi.fn(), apiDelete: vi.fn(), ApiError };
});
vi.mock("@/lib/attribution", () => ({ withAttribution: (d: string) => d, attributionCapabilities: () => ({}) }));
vi.mock("@/config/env", () => ({ publicEnv: { paymasterUrl: "" } }));

const { ApiError } = await import("@/lib/client-api");
const { callAfterApproval, executeTrade, isReviewAgain, postTradeRecord, refetchedQuoteAcceptable } = await import("./execute");
type ExecutableQuoteDTO = import("@/domain/trade").ExecutableQuoteDTO;

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

/* ---------- re-quotes ---------- */

function firmQuote(over: Partial<ExecutableQuoteDTO> = {}): ExecutableQuoteDTO {
  return {
    provider: "kyber",
    side: "buy",
    assetAddress: NVDA,
    sellToken: USDC,
    buyToken: NVDA,
    sellAmount: "10000000",
    buyAmount: "5000000",
    minBuyAmount: "4950000",
    executablePriceUsd: 200,
    executablePricePerShareUsd: 200,
    priceImpactPct: 0,
    priceImpactBasis: "market",
    estimatedNetworkFeeWei: null,
    estimatedNetworkFeeUsd: null,
    integratorFee: null,
    liquidityAvailable: true,
    allowanceRequired: false,
    allowanceSpender: ROUTER,
    balanceInsufficient: false,
    route: [],
    fetchedAt: Date.now(),
    warnings: [],
    transaction: { to: ROUTER, data: "0x1234", value: "0", gas: null, gasPrice: null },
    quoteId: null,
    expiresAt: Date.now() + 30_000,
    ...over,
  };
}

describe("refetchedQuoteAcceptable", () => {
  const reviewed = firmQuote({ buyAmount: "1000000" });

  it("accepts the same route paying out within half the slippage allowance", () => {
    expect(refetchedQuoteAcceptable(reviewed, firmQuote({ buyAmount: "1000000" }), 100)).toEqual({ ok: true });
    expect(refetchedQuoteAcceptable(reviewed, firmQuote({ buyAmount: "995000" }), 100)).toEqual({ ok: true }); // −0.5% = exactly half of 1%
    expect(refetchedQuoteAcceptable(reviewed, firmQuote({ buyAmount: "1200000" }), 100)).toEqual({ ok: true }); // more is never a problem
  });

  it("refuses a worse payout or a different route", () => {
    expect(refetchedQuoteAcceptable(reviewed, firmQuote({ buyAmount: "994999" }), 100)).toMatchObject({ ok: false, reason: expect.stringMatching(/price moved/i) });
    expect(refetchedQuoteAcceptable(reviewed, firmQuote({ buyAmount: "1000000", provider: "velora" }), 100)).toMatchObject({ ok: false, reason: expect.stringMatching(/route changed/i) });
  });
});

/**
 * A re-quote used to be a fresh call with the original parameters: any route could answer, with
 * any output, and the wallet opened on it. Now the refetch is pinned to the reviewed route, the
 * refreshed calldata goes through the simulation, and a refetch that no longer matches the review
 * sends the sheet back to READY instead of to the wallet.
 */
describe("executeTrade re-quotes", () => {
  const sendTransaction = vi.fn<(tx: { to: Address; data: string }) => Promise<Hash>>(async () => HASH);
  let simulateResults: Array<Error | null> = [];
  const call = vi.fn(async () => {
    const next = simulateResults.shift() ?? null;
    if (next) throw next;
    return { data: undefined };
  });
  const walletClient = {
    getCapabilities: async () => {
      throw new Error("wallet_getCapabilities not supported");
    },
    sendTransaction,
  } as unknown as WalletClient;
  const publicClient = {
    readContract: async () => 10n ** 30n, // allowance: plenty
    call,
    waitForTransactionReceipt: async () => ({}),
  } as unknown as PublicClient;
  const ctx = { address: ACCOUNT, chainId: 8453, walletClient, publicClient };
  const params = { side: "buy" as const, assetAddress: NVDA, sellAmount: 10_000_000n, slippageBps: 100 };

  beforeEach(() => {
    apiPost.mockReset();
    sendTransaction.mockClear();
    call.mockClear();
    simulateResults = [];
  });

  it("re-quotes an expired review from the same route and sends once the refresh simulates clean", async () => {
    const reviewed = firmQuote({ expiresAt: Date.now() - 1 });
    apiPost.mockImplementation(async (path: string) => (path === "/api/trade/quote" ? firmQuote({ buyAmount: "4990000" }) : {}));
    const states: string[] = [];
    const result = await executeTrade(ctx, { ...params, prefetchedQuote: reviewed }, { onState: (s) => states.push(s) });
    expect(result.txHash).toBe(HASH);
    const quoteCalls = apiPost.mock.calls.filter(([path]) => path === "/api/trade/quote");
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]![1]).toMatchObject({ provider: "kyber", strictProvider: true });
    expect(call).toHaveBeenCalledTimes(1); // simulated before the wallet opened
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(states).toContain("GETTING_FIRM_QUOTE");
  });

  it("goes back to review instead of opening the wallet when the refreshed quote pays out less than reviewed", async () => {
    const reviewed = firmQuote({ expiresAt: Date.now() - 1, buyAmount: "5000000" });
    apiPost.mockImplementation(async () => firmQuote({ buyAmount: "4900000" })); // −2%, past half of the 1% allowance
    const shown: ExecutableQuoteDTO[] = [];
    const err = await executeTrade(ctx, { ...params, prefetchedQuote: reviewed }, { onQuote: (q) => shown.push(q) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isReviewAgain(err)).toBe(true);
    expect((err as InstanceType<typeof ApiError>).message).toMatch(/review the refreshed quote/i);
    expect(shown.map((q) => q.buyAmount)).toEqual(["4900000"]); // the sheet has the new numbers
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("goes back to review when the route changed under the refresh", async () => {
    const reviewed = firmQuote({ expiresAt: Date.now() - 1 });
    // The pinned ask fails; the automatic fallback answers from another route.
    apiPost.mockImplementation(async (_path: string, body: { strictProvider?: boolean }) => {
      if (body.strictProvider) throw new ApiError("PROVIDER_UNAVAILABLE", "kyber down", 503);
      return firmQuote({ provider: "velora" });
    });
    const err = await executeTrade(ctx, { ...params, prefetchedQuote: reviewed }).catch((e: unknown) => e);
    expect(isReviewAgain(err)).toBe(true);
    expect((err as InstanceType<typeof ApiError>).message).toMatch(/route changed/i);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("re-quotes on a stale-price revert and simulates the refreshed calldata before sending", async () => {
    const reviewed = firmQuote();
    simulateResults = [new Error("execution reverted: Too little received")];
    apiPost.mockImplementation(async (path: string) => (path === "/api/trade/quote" ? firmQuote({ buyAmount: "4995000", transaction: { to: ROUTER, data: "0x5678", value: "0", gas: null, gasPrice: null } }) : {}));
    const result = await executeTrade(ctx, { ...params, prefetchedQuote: reviewed });
    expect(result.quote.buyAmount).toBe("4995000");
    expect(call).toHaveBeenCalledTimes(2); // the failed simulation, then the refreshed one
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransaction.mock.calls[0]![0]).toMatchObject({ data: "0x5678" });
  });

  it("does not loop on a second stale-price revert", async () => {
    simulateResults = [new Error("execution reverted: Too little received"), new Error("execution reverted: Too little received")];
    apiPost.mockImplementation(async () => firmQuote());
    await expect(executeTrade(ctx, { ...params, prefetchedQuote: firmQuote() })).rejects.toThrow(/too little received/i);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

/**
 * The record was posted once and the answer thrown away; when the server's node had not seen the
 * hash yet (TX_PENDING, 404) a real trade left no record. It now retries while that is the answer.
 */
describe("postTradeRecord", () => {
  // Braces matter: a hook that returns the mock hands vitest a function, which it calls as a cleanup.
  beforeEach(() => {
    apiPost.mockReset();
  });

  it("retries while the server has not seen the transaction, then files it", async () => {
    vi.useFakeTimers();
    apiPost.mockRejectedValueOnce(new ApiError("TX_PENDING", "not known", 404)).mockRejectedValueOnce(new ApiError("TX_PENDING", "not known", 404)).mockResolvedValueOnce({});
    const done = postTradeRecord({ id: "t" }, [100, 200]);
    await vi.advanceTimersByTimeAsync(400);
    await expect(done).resolves.toBe(true);
    expect(apiPost).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last retry", async () => {
    vi.useFakeTimers();
    apiPost.mockRejectedValue(new ApiError("TX_PENDING", "not known", 404));
    const done = postTradeRecord({ id: "t" }, [100, 200]);
    await vi.advanceTimersByTimeAsync(400);
    await expect(done).resolves.toBe(false);
    expect(apiPost).toHaveBeenCalledTimes(3);
  });

  it("takes any other answer as final", async () => {
    apiPost.mockRejectedValue(new ApiError("TX_MISMATCH", "not yours", 409));
    await expect(postTradeRecord({ id: "t" }, [100])).resolves.toBe(false);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});
