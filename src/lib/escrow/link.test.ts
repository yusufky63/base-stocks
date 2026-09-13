import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, getAddress, hashTypedData, keccak256, stringToHex, verifyTypedData, type Address, type Hex } from "viem";
import { CLAIM_TYPES, claimDomain, claimPath, escrowAddressOf, escrowIdFor, GIFT_ESCROW_ADDRESS, isKnownEscrow, LEGACY_GIFT_ESCROW_ADDRESSES, makeClaimSecret, parseClaimFragment, signClaim } from "./index";

/** The first GiftEscrow deployment, whose `DOMAIN_SEPARATOR()` was read from the chain on 2026-09-12. */
const LEGACY_ESCROW = "0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55" as const;
/** Any other address: what a redeployment's separator has to come out as. */
const OTHER_ESCROW = getAddress("0x000000000000000000000000000000000000eeee");

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
    const sig = await signClaim(secret.privateKey, GIFT_ESCROW_ADDRESS, secret.escrowId, recipient);
    const ok = await verifyTypedData({
      address: secret.claimKey,
      domain: claimDomain(GIFT_ESCROW_ADDRESS),
      types: CLAIM_TYPES,
      primaryType: "Claim",
      message: { giftId: secret.escrowId, recipient },
      signature: { v: BigInt(sig.v), r: sig.r, s: sig.s },
    });
    expect(ok).toBe(true);
    const wrong = await verifyTypedData({
      address: secret.claimKey,
      domain: claimDomain(GIFT_ESCROW_ADDRESS),
      types: CLAIM_TYPES,
      primaryType: "Claim",
      message: { giftId: secret.escrowId, recipient: "0x000000000000000000000000000000000000dEaD" },
      signature: { v: BigInt(sig.v), r: sig.r, s: sig.s },
    });
    expect(wrong).toBe(false);
  });

  it("binds the signature to one escrow: a claim signed for the old contract is a stranger at the new one", async () => {
    const secret = makeClaimSecret();
    const recipient = "0x000000000000000000000000000000000000bEEF" as const;
    const sig = await signClaim(secret.privateKey, LEGACY_ESCROW, secret.escrowId, recipient);
    const atOther = await verifyTypedData({
      address: secret.claimKey,
      domain: claimDomain(OTHER_ESCROW),
      types: CLAIM_TYPES,
      primaryType: "Claim",
      message: { giftId: secret.escrowId, recipient },
      signature: { v: BigInt(sig.v), r: sig.r, s: sig.s },
    });
    expect(atOther).toBe(false);
  });

  it("rejects malformed fragments", () => {
    expect(parseClaimFragment("")).toBeNull();
    expect(parseClaimFragment("#k=0x1234")).toBeNull();
    expect(parseClaimFragment("#key=abc")).toBeNull();
  });
});

/**
 * Which escrow a gift lives in. Records written before the column exists are gifts in the first
 * deployment, so the fallback is that address and nothing else; the current constant is only
 * for gifts being created now.
 */
describe("escrow resolution for existing gifts", () => {
  it("uses the stored escrow, and the first deployment when there is none", () => {
    expect(escrowAddressOf({ escrowAddress: OTHER_ESCROW })).toBe(OTHER_ESCROW);
    expect(escrowAddressOf({})).toBe(LEGACY_ESCROW);
    expect(escrowAddressOf({ escrowAddress: null })).toBe(LEGACY_ESCROW);
    expect(LEGACY_GIFT_ESCROW_ADDRESSES[0]).toBe(LEGACY_ESCROW);
  });

  it("knows the current and every legacy escrow, case-insensitively, and nothing else", () => {
    expect(isKnownEscrow(GIFT_ESCROW_ADDRESS)).toBe(true);
    expect(isKnownEscrow(LEGACY_ESCROW.toLowerCase())).toBe(true);
    expect(isKnownEscrow(OTHER_ESCROW)).toBe(false);
  });
});

/**
 * The claim digest, recomputed the way GiftEscrow.sol computes it.
 *
 * The app signed under "BaseStocks GiftEscrow" after the product rename while the deployed
 * contract's constructor had fixed its separator from "BStocks GiftEscrow". Every test above kept
 * passing, because they verified the library against itself; onchain, `ecrecover` returned a
 * stranger and every claim reverted with BadSignature. Asserting the digest against the contract's
 * own formula (and the deployed separator, read from the chain on 2026-09-12) makes the name a fact
 * the tests know, not a string anyone can retouch.
 */
describe("claim digest matches GiftEscrow.sol", () => {
  const id = "0x37d29beba4d25642369383d7359cfc13a4a57ca99b8566557a0e90ac9cfc740c" as const;
  const recipient = "0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac" as const;
  /** `DOMAIN_SEPARATOR()` of the legacy escrow 0x8D9f…7f55 on Base mainnet. */
  const DEPLOYED_DOMAIN_SEPARATOR = "0x3b8670de3bdbb4e9c0a3625c38b3d9a24d93881355fc3da9288d757b2946f6b8";

  function domainSeparator(name: string, verifyingContract: Address): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(stringToHex(name)),
          keccak256(stringToHex("1")),
          8453n,
          verifyingContract,
        ],
      ),
    );
  }

  /** keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient)))). */
  function contractDigest(name: string, verifyingContract: Address): Hex {
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
        [keccak256(stringToHex("Claim(bytes32 giftId,address recipient)")), id, recipient],
      ),
    );
    return keccak256(concat(["0x1901", domainSeparator(name, verifyingContract), structHash]));
  }

  it("uses the separator the legacy contract reports", () => {
    expect(domainSeparator(claimDomain(LEGACY_ESCROW).name, LEGACY_ESCROW)).toBe(DEPLOYED_DOMAIN_SEPARATOR);
  });

  it("signs under the name the contract's constructor fixed", () => {
    const signed = hashTypedData({ domain: claimDomain(LEGACY_ESCROW), types: CLAIM_TYPES, primaryType: "Claim", message: { giftId: id, recipient } });
    expect(signed).toBe(contractDigest("BStocks GiftEscrow", LEGACY_ESCROW));
    // The name the app sent between 2026-09-07 and 2026-09-13. Kept so the regression cannot come back quietly.
    expect(signed).not.toBe(contractDigest("BaseStocks GiftEscrow", LEGACY_ESCROW));
  });

  it("computes a redeployment's separator from its own address, with the same name", () => {
    // A new escrow fixes its separator from the same literal and its own address; the digest the
    // app signs for it must be that one, and must differ from the legacy contract's.
    const signed = hashTypedData({ domain: claimDomain(OTHER_ESCROW), types: CLAIM_TYPES, primaryType: "Claim", message: { giftId: id, recipient } });
    expect(signed).toBe(contractDigest("BStocks GiftEscrow", OTHER_ESCROW));
    expect(domainSeparator("BStocks GiftEscrow", OTHER_ESCROW)).not.toBe(DEPLOYED_DOMAIN_SEPARATOR);
    expect(signed).not.toBe(contractDigest("BStocks GiftEscrow", LEGACY_ESCROW));
  });
});
