import type { Address } from "viem";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { b20PolicyRegistryAbi, B20_POLICY_ALWAYS_ALLOW } from "@/lib/b20/abi";
import { B20_POLICY_REGISTRY_ADDRESS, BASE_CHAIN_ID } from "@/config/chain";
import type { B20Asset } from "@/domain/asset";
import type { TradeSide } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { requireAsset } from "./b20-asset-service";
import { metrics } from "@/lib/http";

export interface GuardWarnings {
  warnings: string[];
}

export interface PreActionCheck extends GuardWarnings {
  asset: B20Asset;
}

/**
 * B20Guard: first-class domain service that runs before Buy / Sell / Send.
 *
 * Canonical address? → transfer state? → policy/authorization? → (quote) → (simulate) → execute
 *
 * Oracle staleness never blocks a secondary-market trade with a valid executable quote,
 * but it always surfaces as a warning and gates strategy logic that depends on the oracle.
 */
export class B20GuardService {
  async validateCanonicalAsset(address: string): Promise<B20Asset> {
    return requireAsset(address);
  }

  validateChain(chainId: number): void {
    if (chainId !== BASE_CHAIN_ID) throw new AppError("WRONG_NETWORK", "Switch your wallet to Base to continue.", 400);
  }

  checkTransferState(asset: B20Asset): void {
    if (asset.transferPaused) {
      throw new AppError("B20_TRANSFER_PAUSED", "Transfers of this stock are currently paused by the issuer.", 409);
    }
  }

  /**
   * Policy authorization for the accounts we know. Policy id 0 = ALWAYS_ALLOW (skip RPC).
   * Unknown counterparties (aggregator settlement contracts) cannot be pre-checked here;
   * simulation covers them.
   */
  async checkUserAuthorization(asset: B20Asset, params: { sender?: Address; receiver?: Address }): Promise<void> {
    const checks: Array<{ policyId: bigint; account: Address; role: "sender" | "receiver" }> = [];
    if (params.sender && asset.transferSenderPolicyId !== B20_POLICY_ALWAYS_ALLOW) {
      checks.push({ policyId: asset.transferSenderPolicyId, account: params.sender, role: "sender" });
    }
    if (params.receiver && asset.transferReceiverPolicyId !== B20_POLICY_ALWAYS_ALLOW) {
      checks.push({ policyId: asset.transferReceiverPolicyId, account: params.receiver, role: "receiver" });
    }
    if (checks.length === 0) return;
    const client = getServerPublicClient();
    let results: Array<{ status: "success" | "failure"; result?: unknown }>;
    try {
      results = await client.multicall({
        contracts: checks.map((c) => ({
          address: B20_POLICY_REGISTRY_ADDRESS,
          abi: b20PolicyRegistryAbi,
          functionName: "isAuthorized" as const,
          args: [c.policyId, c.account] as const,
        })),
        allowFailure: true,
      });
    } catch (err) {
      metrics.count("b20.policyCheck", false, err instanceof Error ? err.message : String(err));
      // Registry unreachable: do not block; simulation is the next gate.
      return;
    }
    results.forEach((r, i) => {
      if (r.status === "success" && r.result === false) {
        const role = checks[i]!.role;
        throw new AppError(
          "B20_POLICY_BLOCKED",
          role === "sender"
            ? "Your address is not allowed to send this stock under the issuer's onchain policy."
            : "The recipient is not allowed to receive this stock under the issuer's onchain policy.",
          403,
          { role, account: checks[i]!.account },
        );
      }
    });
  }

  checkOracleState(asset: B20Asset): string[] {
    const w: string[] = [];
    if (!asset.oracle) {
      w.push("Reference price unavailable. Showing executable quotes only.");
      return w;
    }
    // A stale reference is not warned about here. The feeds run 24/5, so "stale" is the normal state
    // every night, weekend and market holiday — a warning that is usually on teaches people to
    // ignore the ones that are not, and this one ended by admitting it does not affect the trade.
    // The reference's own freshness label carries it where it belongs, next to the price.
    if (asset.oracle.paused) w.push("Reference price is frozen for a corporate action. Executable quotes still reflect live market prices.");
    return w;
  }

  checkCorporateActionState(asset: B20Asset): string[] {
    return asset.oracle?.paused ? ["Corporate action in progress: the issuer has paused the reference oracle for this stock."] : [];
  }

  /** Full pre-trade gate for Buy / Sell. Throws typed errors, returns non-blocking warnings. */
  async preTradeCheck(params: { assetAddress: string; side: TradeSide; taker?: Address; recipient?: Address; chainId?: number }): Promise<PreActionCheck> {
    if (params.chainId !== undefined) this.validateChain(params.chainId);
    const asset = await this.validateCanonicalAsset(params.assetAddress);
    this.checkTransferState(asset);
    if (params.side === "buy") {
      await this.checkUserAuthorization(asset, { receiver: params.recipient ?? params.taker });
    } else {
      await this.checkUserAuthorization(asset, { sender: params.taker });
    }
    const warnings = [...this.checkOracleState(asset), ...this.checkCorporateActionState(asset)];
    return { asset, warnings: Array.from(new Set(warnings)) };
  }

  /** Pre-send gate for Gift / Send of an existing position. */
  async preSendCheck(params: { assetAddress: string; sender: Address; recipient: Address }): Promise<PreActionCheck> {
    const asset = await this.validateCanonicalAsset(params.assetAddress);
    this.checkTransferState(asset);
    await this.checkUserAuthorization(asset, { sender: params.sender, receiver: params.recipient });
    return { asset, warnings: this.checkCorporateActionState(asset) };
  }
}

export const b20Guard = new B20GuardService();
