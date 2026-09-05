/**
 * JSON that survives the things the app's cached values are made of: bigints (every onchain
 * amount), Maps (prices by address) and Sets (reserve lists). `encode` and `decode` are exact
 * inverses for those, and plain JSON for everything else, so a value written by one server
 * instance reads back identical on another.
 */
type Tagged = { $bigint: string } | { $map: Array<[unknown, unknown]> } | { $set: unknown[] };

function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() } satisfies Tagged;
  if (value instanceof Map) return { $map: [...value.entries()] } satisfies Tagged;
  if (value instanceof Set) return { $set: [...value.values()] } satisfies Tagged;
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.$bigint === "string" && Object.keys(v).length === 1) return BigInt(v.$bigint);
    if (Array.isArray(v.$map) && Object.keys(v).length === 1) return new Map(v.$map as Array<[unknown, unknown]>);
    if (Array.isArray(v.$set) && Object.keys(v).length === 1) return new Set(v.$set);
  }
  return value;
}

export function encode(value: unknown): string {
  return JSON.stringify(value, replacer);
}

export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, reviver) as T;
}
