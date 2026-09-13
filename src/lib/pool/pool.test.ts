import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, getAddress, hashTypedData, keccak256, stringToHex, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  isKnownPoolContract,
  LEGACY_GIFT_POOL_ADDRESSES,
  makePoolLinkSecret,
  onchainIdFor,
  parsePoolFragment,
  poolContractOf,
  poolIdFor,
  poolMemo,
  poolPath,
  poolSalt,
  POOL_TICKET_TYPES,
  poolTicketDomain,
  signPoolTicket,
  splitIntoShares,
} from "./index";

const CONTRACT = getAddress("0x000000000000000000000000000000000000c0de");
const CREATOR = getAddress("0x00000000000000000000000000000000c4ea7043");
const OTHER_CONTRACT = getAddress("0x0000000000000000000000000000000000001234");
const RECIPIENT = getAddress("0x000000000000000000000000000000000000beef");
const THIEF = getAddress("0x000000000000000000000000000000000000dead");

/**
 * Which GiftPool a pool lives in. Records written before the column exists are pools in the first
 * deployment, so the fallback is that address and nothing else; `NEXT_PUBLIC_GIFT_POOL_ADDRESS`
 * is only for pools being created now (unset under vitest, so only the legacy list is known here).
 */
describe("pool contract resolution for existing pools", () => {
  const LEGACY = "0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10";
  it("uses the stored contract, and the first deployment when there is none", () => {
    expect(LEGACY_GIFT_POOL_ADDRESSES[0]).toBe(LEGACY);
    expect(poolContractOf({ contractAddress: CONTRACT })).toBe(CONTRACT);
    expect(poolContractOf({})).toBe(LEGACY);
    expect(poolContractOf({ contractAddress: null })).toBe(LEGACY);
  });
  it("knows every legacy contract, case-insensitively, and nothing it was not told about", () => {
    expect(isKnownPoolContract(LEGACY.toLowerCase())).toBe(true);
    expect(isKnownPoolContract(OTHER_CONTRACT)).toBe(false);
  });
});

describe("pool ids", () => {
  it("derives the onchain id exactly like GiftPool.poolId (keccak of abi.encode(creator, salt))", () => {
    const salt = poolSalt("pool_abc123");
    expect(poolIdFor(CREATOR, salt)).toBe(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [CREATOR, salt])));
    expect(onchainIdFor(CREATOR, "pool_abc123")).toBe(poolIdFor(CREATOR, salt));
  });

  it("namespaces ids by creator, so the same app id from two wallets never collides", () => {
    const other = getAddress("0x00000000000000000000000000000000deadbeef");
    expect(onchainIdFor(CREATOR, "pool_abc123")).not.toBe(onchainIdFor(other, "pool_abc123"));
  });

  it("keeps the salt and the memo distinct, and both reproducible from the app id alone", () => {
    expect(poolSalt("pool_x")).toBe(keccak256(stringToHex("bstocks:pool:salt:pool_x")));
    expect(poolMemo("pool_x")).toBe(keccak256(stringToHex("bstocks:pool:pool_x")));
    expect(poolSalt("pool_x")).not.toBe(poolMemo("pool_x"));
    expect(poolSalt("pool_x")).toBe(poolSalt("pool_x"));
  });
});

describe("share links", () => {
  it("round-trips the link key through the URL fragment", () => {
    const secret = makePoolLinkSecret();
    const path = poolPath("pool_abc123", secret.privateKey);
    expect(path).toBe(`/pools/pool_abc123#k=${secret.privateKey}`);
    const parsed = parsePoolFragment(`#${path.split("#")[1]}`);
    expect(parsed?.gateAddress).toBe(secret.gateAddress);
  });

  it("omits the fragment for open and quest-gated pools", () => {
    expect(poolPath("pool_abc123")).toBe("/pools/pool_abc123");
    expect(parsePoolFragment("")).toBeNull();
  });

  it("rejects malformed fragments", () => {
    expect(parsePoolFragment("#k=0x1234")).toBeNull();
    expect(parsePoolFragment("#key=abc")).toBeNull();
  });
});

describe("claim tickets", () => {
  const poolId = keccak256(stringToHex("pool"));
  const recipient = RECIPIENT;

  it("recovers to the gate address and binds the recipient", async () => {
    const secret = makePoolLinkSecret();
    const deadline = 1_800_000_000n;
    const ticket = await signPoolTicket(secret.privateKey, CONTRACT, poolId, recipient, deadline);

    const ok = await verifyTypedData({
      address: secret.gateAddress,
      domain: poolTicketDomain(CONTRACT),
      types: POOL_TICKET_TYPES,
      primaryType: "Ticket",
      message: { poolId, recipient, deadline },
      signature: { v: BigInt(ticket.v), r: ticket.r, s: ticket.s },
    });
    expect(ok).toBe(true);

    const thief = await verifyTypedData({
      address: secret.gateAddress,
      domain: poolTicketDomain(CONTRACT),
      types: POOL_TICKET_TYPES,
      primaryType: "Ticket",
      message: { poolId, recipient: THIEF, deadline },
      signature: { v: BigInt(ticket.v), r: ticket.r, s: ticket.s },
    });
    expect(thief).toBe(false);
  });

  it("binds the pool, so a ticket cannot be replayed against another one", async () => {
    const secret = makePoolLinkSecret();
    const deadline = 1_800_000_000n;
    const ticket = await signPoolTicket(secret.privateKey, CONTRACT, poolId, recipient, deadline);
    const otherPool = await verifyTypedData({
      address: secret.gateAddress,
      domain: poolTicketDomain(CONTRACT),
      types: POOL_TICKET_TYPES,
      primaryType: "Ticket",
      message: { poolId: keccak256(stringToHex("other")), recipient, deadline },
      signature: { v: BigInt(ticket.v), r: ticket.r, s: ticket.s },
    });
    expect(otherPool).toBe(false);
  });

  it("binds the deadline and the contract address", async () => {
    const secret = makePoolLinkSecret();
    const ticket = await signPoolTicket(secret.privateKey, CONTRACT, poolId, recipient, 1_800_000_000n);
    const stretched = await verifyTypedData({
      address: secret.gateAddress,
      domain: poolTicketDomain(CONTRACT),
      types: POOL_TICKET_TYPES,
      primaryType: "Ticket",
      message: { poolId, recipient, deadline: 1_900_000_000n },
      signature: { v: BigInt(ticket.v), r: ticket.r, s: ticket.s },
    });
    expect(stretched).toBe(false);

    const otherContract = await verifyTypedData({
      address: secret.gateAddress,
      domain: poolTicketDomain(OTHER_CONTRACT),
      types: POOL_TICKET_TYPES,
      primaryType: "Ticket",
      message: { poolId, recipient, deadline: 1_800_000_000n },
      signature: { v: BigInt(ticket.v), r: ticket.r, s: ticket.s },
    });
    expect(otherContract).toBe(false);
  });

  it("produces a low-s, 27/28 signature — the contract rejects anything else", async () => {
    const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    for (let i = 0; i < 8; i++) {
      const secret = makePoolLinkSecret();
      const ticket = await signPoolTicket(secret.privateKey, CONTRACT, keccak256(stringToHex(`p${i}`)), recipient, 1_800_000_000n);
      expect(BigInt(ticket.s)).toBeLessThanOrEqual(HALF_ORDER);
      expect([27, 28]).toContain(ticket.v);
    }
  });

  it("keeps the link key off the network: the fragment holds the private half, the chain the address", () => {
    const secret = makePoolLinkSecret();
    expect(privateKeyToAccount(secret.privateKey).address).toBe(secret.gateAddress);
    expect(poolPath("pool_a", secret.privateKey)).toContain(secret.privateKey);
    expect(poolPath("pool_a", secret.privateKey)).not.toContain(secret.gateAddress);
  });
});

describe("splitting a total into shares", () => {
  it("never leaves the contract holding dust: funded is exactly perClaim × slots", () => {
    const { perClaim, funded, dust } = splitIntoShares(1_000_000_007n, 10);
    expect(perClaim).toBe(100_000_000n);
    expect(funded).toBe(1_000_000_000n);
    expect(dust).toBe(7n);
    expect(perClaim * 10n).toBe(funded);
  });

  it("divides evenly when it can", () => {
    const { perClaim, funded, dust } = splitIntoShares(1_000_000_000n, 4);
    expect(perClaim).toBe(250_000_000n);
    expect(funded).toBe(1_000_000_000n);
    expect(dust).toBe(0n);
  });

  it("refuses to fund a pool whose shares would round to nothing", () => {
    const { perClaim, funded, dust } = splitIntoShares(5n, 10);
    expect(perClaim).toBe(0n);
    expect(funded).toBe(0n);
    expect(dust).toBe(5n);
  });

  it("treats a zero or negative slot count as nothing funded", () => {
    expect(splitIntoShares(100n, 0)).toEqual({ perClaim: 0n, funded: 0n, dust: 100n });
    expect(splitIntoShares(100n, -3)).toEqual({ perClaim: 0n, funded: 0n, dust: 100n });
  });

  it("holds the invariant the contract relies on for any total and slot count", () => {
    for (const total of [1n, 7n, 999n, 10n ** 12n, 123_456_789_012_345n]) {
      for (const slots of [1, 2, 3, 7, 10, 97, 1000]) {
        const { perClaim, funded, dust } = splitIntoShares(total, slots);
        expect(perClaim * BigInt(slots)).toBe(funded);
        expect(funded + dust).toBe(total);
        expect(dust).toBeLessThan(BigInt(slots));
      }
    }
  });
});

/**
 * The ticket digest, recomputed the way GiftPool.sol computes it.
 *
 * The app signed under "BaseStocks GiftPool" while the deployed contract's constructor had fixed
 * its separator from "BStocks GiftPool". Nothing failed until a claim reached the chain, where
 * `ecrecover` returned a stranger and every quest- and link-gated pool reverted with BadSignature.
 * A digest asserted against the contract's own formula catches that before a deploy does.
 */
describe("ticket digest matches GiftPool.sol", () => {
  const POOL = "0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10" as const;
  const id = "0x37d29beba4d25642369383d7359cfc13a4a57ca99b8566557a0e90ac9cfc740c" as const;
  const recipient = "0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac" as const;
  const deadline = 1_789_000_000n;

  /** keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)), built from the literals in the contract. */
  function contractDigest(name: string): Hex {
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(stringToHex(name)),
          keccak256(stringToHex("1")),
          8453n,
          POOL,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint64" }],
        [keccak256(stringToHex("Ticket(bytes32 poolId,address recipient,uint64 deadline)")), id, recipient, deadline],
      ),
    );
    return keccak256(concat(["0x1901", domainSeparator, structHash]));
  }

  it("signs under the name the contract's constructor fixed", () => {
    const signed = hashTypedData({ domain: poolTicketDomain(POOL), types: POOL_TICKET_TYPES, primaryType: "Ticket", message: { poolId: id, recipient, deadline } });
    expect(signed).toBe(contractDigest("BStocks GiftPool"));
    // The name the app used to send. Kept as an assertion so the regression cannot come back quietly.
    expect(signed).not.toBe(contractDigest("BaseStocks GiftPool"));
  });
});
