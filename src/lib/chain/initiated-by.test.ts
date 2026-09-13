import { describe, expect, it } from "vitest";
import { keccak256, pad, toBytes, type Address, type Hex } from "viem";
import { initiatedBy, type ReceiptLog } from "./receipt-checks";

const WALLET = "0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac" as Address;
const OTHER = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address;

const topic = (sig: string) => keccak256(toBytes(sig));
const addr = (a: Address): Hex => pad(a, { size: 32 });
const log = (address: Address, topics: Hex[], logIndex = 0): ReceiptLog => ({ address, topics, data: "0x", logIndex });

describe("initiatedBy", () => {
  it("is the transaction's sender for an EOA", () => {
    expect(initiatedBy([], WALLET, WALLET)).toBe(true);
    expect(initiatedBy([], OTHER, WALLET)).toBe(false);
    expect(initiatedBy([], undefined, WALLET)).toBe(false);
  });

  it("is the user operation's sender for a smart account behind a bundler", () => {
    const userOp = log(ENTRY_POINT, [topic("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"), pad("0x01", { size: 32 }), addr(WALLET), addr(OTHER)]);
    expect(initiatedBy([userOp], OTHER, WALLET)).toBe(true); // the bundler sent it, the wallet owns it
    expect(initiatedBy([userOp], OTHER, OTHER)).toBe(true); // the bundler itself is still the sender
    const someoneElses = log(ENTRY_POINT, [topic("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"), pad("0x01", { size: 32 }), addr(OTHER), addr(OTHER)]);
    expect(initiatedBy([someoneElses], "0x000000000000000000000000000000000000dEaD", WALLET)).toBe(false);
  });

  it("is the order owner for a CoW settlement a solver sent", () => {
    const trade = log(SETTLEMENT, [topic("Trade(address,address,address,uint256,uint256,uint256,bytes)"), addr(WALLET)]);
    expect(initiatedBy([trade], "0x000000000000000000000000000000000000dEaD", WALLET)).toBe(true);
    expect(initiatedBy([trade], "0x000000000000000000000000000000000000dEaD", OTHER)).toBe(false);
  });

  it("does not mistake a transfer for a user operation", () => {
    const transfer = log(WALLET, [topic("Transfer(address,address,uint256)"), addr(OTHER), addr(WALLET)]);
    expect(initiatedBy([transfer], OTHER, WALLET)).toBe(false);
  });
});
