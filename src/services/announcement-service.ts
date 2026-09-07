import { formatUnits, type Address } from "viem";
import { getLogPublicClient } from "@/lib/viem/server-client";
import { b20AssetAbi } from "@/lib/b20/abi";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";
import type { CorporateActionEvent } from "@/lib/client-api";

/**
 * Corporate-action UX (spec §8.5): index `Announcement` / `EndAnnouncement` / `MultiplierUpdated`
 * emitted by a B20 token over a bounded recent range. Rare events, so wide log ranges are cheap;
 * the scan shrinks its chunk size if the RPC rejects a range.
 */
const LOOKBACK_BLOCKS = 1_300_000n; // ≈ 30 days at 2s blocks
const INITIAL_CHUNK = 100_000n;

const events = b20AssetAbi.filter((x) => x.type === "event" && ["Announcement", "EndAnnouncement", "MultiplierUpdated", "UIMultiplierUpdateCancelled", "ExtraMetadataUpdated"].includes(x.name));

export async function getCorporateActions(asset: Address): Promise<{ events: CorporateActionEvent[]; scannedFromBlock: number }> {
  return cached(`announcements:${asset.toLowerCase()}`, { ttlMs: 10 * 60_000, staleMs: 60 * 60_000, shared: true }, async () => {
    const client = getLogPublicClient();
    const latest = await client.getBlockNumber();
    const from = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
    const out: CorporateActionEvent[] = [];
    let chunk = INITIAL_CHUNK;
    let start = from;
    let failures = 0;
    while (start <= latest) {
      const end = start + chunk > latest ? latest : start + chunk;
      try {
        const logs = await client.getLogs({ address: asset, events, fromBlock: start, toBlock: end });
        for (const log of logs) {
          const args = log.args as Record<string, unknown>;
          const base = { blockNumber: Number(log.blockNumber), txHash: log.transactionHash };
          if (log.eventName === "Announcement") out.push({ kind: "announcement", id: String(args.id ?? ""), description: String(args.description ?? ""), uri: String(args.uri ?? ""), ...base });
          else if (log.eventName === "EndAnnouncement") out.push({ kind: "end-announcement", id: String(args.id ?? ""), ...base });
          else if (log.eventName === "MultiplierUpdated") out.push({ kind: "multiplier", multiplier: formatUnits((args.multiplier as bigint) ?? 0n, 18), ...base });
          else if (log.eventName === "UIMultiplierUpdateCancelled") out.push({ kind: "multiplier-cancelled", multiplier: formatUnits((args.cancelledMultiplier as bigint) ?? 0n, 18), description: `scheduled for ${new Date(Number((args.cancelledEffectiveAt as bigint) ?? 0n) * 1000).toISOString()}`, ...base });
          else if (log.eventName === "ExtraMetadataUpdated") out.push({ kind: "metadata", id: String(args.key ?? ""), description: String(args.value ?? ""), ...base });
        }
        start = end + 1n;
      } catch (err) {
        failures += 1;
        metrics.count("announcements.scan", false, err instanceof Error ? err.message : String(err));
        if (chunk > 10_000n) chunk = chunk / 4n;
        else if (failures > 6) break;
      }
    }
    // Timestamps for the (few) events found.
    const blocks = Array.from(new Set(out.map((e) => e.blockNumber))).slice(0, 25);
    const stamps = await Promise.all(blocks.map((b) => client.getBlock({ blockNumber: BigInt(b) }).then((blk) => [b, Number(blk.timestamp)] as const).catch(() => [b, undefined] as const)));
    const byBlock = new Map(stamps);
    for (const e of out) e.timestamp = byBlock.get(e.blockNumber);
    out.sort((a, b) => b.blockNumber - a.blockNumber);
    return { events: out, scannedFromBlock: Number(from) };
  });
}
