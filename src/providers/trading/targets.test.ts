import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { isKnownTarget, knownTargets } from "./targets";
import { ZEROX_ALLOWANCE_HOLDER } from "./zero-x/adapter";
import { KYBER_ROUTER } from "./kyber/adapter";
import { OKX_DEX_ROUTER, OKX_TOKEN_APPROVE } from "./okx/adapter";
import { UNISWAP_SWAP_PROXY } from "./uniswap/adapter";
import { VELORA_AUGUSTUS_V6_2 } from "./velora/adapter";
import { AERODROME_ROUTER } from "./aerodrome/adapter";
import { GPV2_SETTLEMENT, GPV2_VAULT_RELAYER } from "./cow/adapter";

const STRANGER = "0x000000000000000000000000000000000000dEaD" as Address;

describe("trade target allowlist", () => {
  it("knows each route's own contracts, whatever the letter case", () => {
    expect(isKnownTarget("zeroX", ZEROX_ALLOWANCE_HOLDER)).toBe(true);
    expect(isKnownTarget("kyber", KYBER_ROUTER.toLowerCase() as Address)).toBe(true);
    expect(isKnownTarget("okx", OKX_DEX_ROUTER)).toBe(true);
    expect(isKnownTarget("okx", OKX_TOKEN_APPROVE)).toBe(true);
    expect(isKnownTarget("uniswap", UNISWAP_SWAP_PROXY)).toBe(true);
    expect(isKnownTarget("velora", VELORA_AUGUSTUS_V6_2)).toBe(true);
    expect(isKnownTarget("aerodrome", AERODROME_ROUTER)).toBe(true);
    expect(isKnownTarget("cow", GPV2_SETTLEMENT)).toBe(true);
    expect(isKnownTarget("cow", GPV2_VAULT_RELAYER)).toBe(true);
  });

  it("refuses a contract another route uses, and anything it has never seen", () => {
    // One provider's router is not a spender for another: a Kyber quote sending the wallet to Velora's Augustus is wrong.
    expect(isKnownTarget("kyber", VELORA_AUGUSTUS_V6_2)).toBe(false);
    expect(isKnownTarget("velora", KYBER_ROUTER)).toBe(false);
    expect(isKnownTarget("zeroX", STRANGER)).toBe(false);
    expect(isKnownTarget("cow", null)).toBe(false);
    expect(isKnownTarget("cow", undefined)).toBe(false);
  });

  it("lists every route's contracts for diagnostics", () => {
    expect(knownTargets("okx")).toHaveLength(2);
    expect(knownTargets("aerodrome")).toEqual([AERODROME_ROUTER.toLowerCase()]);
  });
});
