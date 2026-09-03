import { describe, expect, it } from "vitest";
import { humanizeError, AppError } from "./errors";

describe("humanizeError", () => {
  it("maps B20 custom error selectors", () => {
    expect(humanizeError(new Error("execution reverted: 0xa43fec12")).code).toBe("B20_POLICY_BLOCKED");
    expect(humanizeError(new Error("revert data 0xf9df5ac9")).code).toBe("B20_TRANSFER_PAUSED");
    expect(humanizeError(new Error("0xdb42144d")).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("maps wallet rejection and chain mismatch", () => {
    expect(humanizeError({ name: "UserRejectedRequestError", message: "User rejected the request." }).code).toBe("USER_REJECTED");
    expect(humanizeError({ name: "ChainMismatchError", message: "The current chain of the wallet (id: 1) does not match" }).code).toBe("WRONG_NETWORK");
  });

  it("passes through typed AppErrors and keeps copy human-readable", () => {
    const h = humanizeError(new AppError("QUOTE_EXPIRED", "The price moved.", 409));
    expect(h.code).toBe("QUOTE_EXPIRED");
    expect(h.message).not.toMatch(/0x/);
  });

  it("never returns raw rpc text as the primary message", () => {
    const h = humanizeError(new Error("Internal JSON-RPC error. {\"code\":-32000}"));
    expect(h.message).not.toMatch(/JSON-RPC/);
    expect(h.detail).toMatch(/JSON-RPC/);
  });
});
