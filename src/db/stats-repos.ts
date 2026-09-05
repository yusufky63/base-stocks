import type { DayRollup } from "@/domain/stats";
import { getSupabaseAdmin } from "./supabase";

/**
 * Stored daily rollups of the platform statistics (`stats_daily`): one row per finished day, the
 * reduced form of that day's verified events. Written once by the rollup job, read on every
 * statistics computation in place of the records they stand for. See `buildDayRollup`.
 */
export interface StatsDailyRepo {
  /** Every stored day, oldest first. */
  list(): Promise<DayRollup[]>;
  upsert(rollup: DayRollup): Promise<void>;
  /** The latest stored day (YYYY-MM-DD), or null when nothing has been rolled up yet. */
  latestDay(): Promise<string | null>;
}

export class MemoryStatsDailyRepo implements StatsDailyRepo {
  private items = new Map<string, DayRollup>();
  async list() {
    return [...this.items.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }
  async upsert(rollup: DayRollup) {
    this.items.set(rollup.day, rollup);
  }
  async latestDay() {
    const days = [...this.items.keys()].sort();
    return days[days.length - 1] ?? null;
  }
}

type Row = Record<string, unknown>;

export class SupabaseStatsDailyRepo implements StatsDailyRepo {
  private sb() {
    const client = getSupabaseAdmin();
    if (!client) throw new Error("Supabase admin client is not configured");
    return client;
  }
  async list() {
    const out: DayRollup[] = [];
    const PAGE = 1_000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb().from("stats_daily").select("day, rollup").order("day", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as Row[];
      for (const r of rows) out.push({ ...(r.rollup as DayRollup), day: String(r.day) });
      if (rows.length < PAGE) break;
    }
    return out;
  }
  async upsert(rollup: DayRollup) {
    const { error } = await this.sb().from("stats_daily").upsert({ day: rollup.day, rollup, events: rollup.events, computed_at: new Date(rollup.computedAt).toISOString() });
    if (error) throw error;
  }
  async latestDay() {
    const { data, error } = await this.sb().from("stats_daily").select("day").order("day", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? String((data as Row).day) : null;
  }
}
