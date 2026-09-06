import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, verifyTypedData } from "viem";
import { claimPath, escrowIdFor, GIFT_ESCROW_ADDRESS, makeClaimSecret, parseClaimFragment, signClaim } from "./index";
import { BASE_CHAIN_ID } from "@/config/chain";

describe("gift escrow claim links", () => {
  it("round-trips the secret through the link fragment", () => {
    const secret = makeClaimSecret();
    const path = claimPath("gift_abc123", secret.privateKey);
    expect(path).toBe(`/gifts/claim/gift_abc123#k=${secret.privateKey}`);
    const parsed = parseClaimFragment(path.split("#")[1] ? `#${path.split("#")[1]}` : "");
    expect(parsed).not.toBeNull();
    expect(parsed!.claimKey).toBe(secret.claimKey);
    expect(parsed!.escrowId).toBe(secret.escrowId);
  });

  it("derives the onchain id exactly like GiftEscrow.giftId (keccak of abi.encode(address))", () => {
    const secret = makeClaimSecret();
    expect(secret.escrowId).toBe(keccak256(encodeAbiParameters([{ type: "address" }], [secret.claimKey])));
    expect(escrowIdFor(secret.claimKey)).toBe(secret.escrowId);
  });

  it("produces an EIP-712 signature that recovers to the claim key and binds the recipient", async () => {
    const secret = makeClaimSecret();
    const recipient = "0x000000000000000000000000000000000000bEEF" as const;
    const sig = await signClaim(secret.privateKey, secret.escrowId, recipient);
    const ok = await verifyTypedData({
      address: secret.claimKey,
      domain: { name: "BaseStocks GiftEscrow", version: "1", chainId: BASE_CHAIN_ID, verifyingContract: GIFT_ESCROW_ADDRESS },
      types: { Claim: [{ name: "giftId", type: "bytes32" }, { name: "recipient", type: "address" }] },
      primaryType: "Claim",
      message: { giftId: secret.escrowId, recipient },
      signature: { v: BigInt(sig.v), r: sig.r, s: sig.s },
    });
    expect(ok).toBe(true);
    const wrong = await verifyTypedData({
      address: secret.claimKey,
      domain: { name: "BaseStocks GiftEscrow", version: "1", chainId: BASE_CHAIN_ID, verifyingContract: GIFT_ESCROW_ADDRESS },
      types: { Claim: [{ name: "giftId", type: "bytes32" }, { name: "recipient", type: "address" }] },
      primaryType: "Claim",
      message: { giftId: secret.escrowId, recipient: "0x000000000000000000000000000000000000dEaD" },
      signature: { v: BigInt(sig.v), r: sig.r, s: sig.s },
    });
    expect(wrong).toBe(false);
  });

  it("rejects malformed fragments", () => {
    expect(parseClaimFragment("")).toBeNull();
    expect(parseClaimFragment("#k=0x1234")).toBeNull();
    expect(parseClaimFragment("#key=abc")).toBeNull();
  });
});
