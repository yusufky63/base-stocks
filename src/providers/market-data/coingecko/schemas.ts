import { z } from "zod";

const numLike = z.union([z.number(), z.string()]).nullable().optional();

export const tokenPriceResponseSchema = z.object({
  data: z.object({
    attributes: z.object({
      token_prices: z.record(z.string(), z.string()).default({}),
      h24_volume_usd: z.record(z.string(), numLike).optional(),
      h24_price_change_percentage: z.record(z.string(), numLike).optional(),
      market_cap_usd: z.record(z.string(), numLike).optional(),
      total_reserve_in_usd: z.record(z.string(), numLike).optional(),
    }),
  }),
});

export const poolSchema = z.object({
  id: z.string(),
  attributes: z.object({
    address: z.string(),
    name: z.string().optional(),
    reserve_in_usd: numLike,
    base_token_price_usd: numLike,
    quote_token_price_usd: numLike,
    volume_usd: z.object({ h24: numLike }).partial().optional(),
    price_change_percentage: z.object({ h24: numLike }).partial().optional(),
  }),
  relationships: z
    .object({
      base_token: z.object({ data: z.object({ id: z.string() }) }).optional(),
      quote_token: z.object({ data: z.object({ id: z.string() }) }).optional(),
      dex: z.object({ data: z.object({ id: z.string() }) }).optional(),
    })
    .optional(),
});

export const tokenInfoResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({
      address: z.string(),
      name: z.string().optional(),
      symbol: z.string().optional(),
      decimals: z.number().optional(),
      image_url: z.string().nullable().optional(),
      price_usd: numLike,
      fdv_usd: numLike,
      market_cap_usd: numLike,
      total_reserve_in_usd: numLike,
      volume_usd: z.object({ h24: numLike }).partial().optional(),
    }),
    relationships: z
      .object({
        top_pools: z.object({ data: z.array(z.object({ id: z.string() })) }).optional(),
      })
      .optional(),
  }),
  included: z.array(poolSchema).optional(),
});

export const ohlcvResponseSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.tuple([z.number(), numLike, numLike, numLike, numLike, numLike])),
    }),
  }),
});

export type CoinGeckoPool = z.infer<typeof poolSchema>;

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
