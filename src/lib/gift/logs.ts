import type { AbiEvent, Address, GetLogsReturnType } from "viem";
import type { BasePublicClient } from "@/lib/viem/server-client";

/**
 * Finds the one log a record is missing: the `GiftCreated` or `PoolCreated` a draft never had its
 * hash written for. The id is an indexed topic, so the filter is exact; the work is in bounding
 * the block range so a repair never becomes a full-history scan.
 *
 * Newest chunks first, because a stuck draft is minutes or hours old, and the scan stops at the
 * first hit. A public RPC that caps the range answers with a range error; the chunk is halved and
 * retried, as the chain index service does, down to a floor below which the error stands.
 */
export const REPAIR_MAX_BLOCKS = 200_000n;
const CHUNK = 10_000n;
const MIN_CHUNK = 1_000n;

function isRangeLimit(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /limited to|block range|range is too large|exceed|too many blocks|up to \d+ blocks/i.test(m);
}

async function readAdaptive<T>(from: bigint, to: bigint, read: (a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
  try {
    return await read(from, to);
  } catch (err) {
    const span = to - from + 1n;
    if (!isRangeLimit(err) || span <= MIN_CHUNK) throw err;
    const mid = from + span / 2n - 1n;
    return [...(await readAdaptive(from, mid, read)), ...(await readAdaptive(mid + 1n, to, read))];
  }
}

export async function findRecentLog<E extends AbiEvent>(client: BasePublicClient, params: { address: Address; event: E; args: Record<string, unknown>; maxBlocks?: bigint }): Promise<GetLogsReturnType<E>[number] | null> {
  const head = await client.getBlockNumber();
  const floor = head > (params.maxBlocks ?? REPAIR_MAX_BLOCKS) ? head - (params.maxBlocks ?? REPAIR_MAX_BLOCKS) : 0n;
  for (let to = head; to >= floor; to -= CHUNK + 1n) {
    const from = to - CHUNK > floor ? to - CHUNK : floor;
    const logs = await readAdaptive(from, to, (a, b) => client.getLogs({ address: params.address, event: params.event, args: params.args as never, fromBlock: a, toBlock: b }) as Promise<GetLogsReturnType<E>>);
    if (logs.length > 0) return logs[logs.length - 1]!;
    if (from === floor) break;
  }
  return null;
}
