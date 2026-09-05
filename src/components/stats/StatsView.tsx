"use client";

import { useState } from "react";
import Link from "next/link";
import type { DailyStat, LedgerEntry, PlatformStats, StatsSummary, StatsWindowKey } from "@/domain/stats";
import { useStats } from "@/hooks/queries";
import { formatUsd, formatUsdCompact, timeAgo } from "@/lib/format";
import { Badge, KeyValue, Module, ModuleHeader, PageTitle, Skeleton, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { Collapsible } from "@/components/ui/Collapsible";
import { TimeAgo } from "@/components/common/TimeAgo";
import { TxLink } from "@/components/common/display";

const WINDOWS: Array<{ value: StatsWindowKey; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];
const WINDOW_LABEL: Record<StatsWindowKey, string> = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };

const usd = (v: number) => (Math.abs(v) >= 100_000 ? formatUsdCompact(v) : formatUsd(v));
const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

const PROVIDER_LABEL: Record<string, string> = { kyber: "KyberSwap", okx: "OKX DEX", uniswap: "Uniswap API", velora: "Velora", aerodrome: "Aerodrome", cow: "CoW Protocol", zeroX: "0x", "auto-invest": "AutoInvest contract", basket: "Basket (route not recorded)", morpho: "Morpho", aave: "Aave V3", compound: "Compound v3" };
const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;

const LEDGER_LABEL: Record<LedgerEntry["kind"], string> = { buy: "Bought", sell: "Sold", gift: "Gift", link: "Gift link funded", "link-claim": "Gift link claimed", pool: "Pool funded", "pool-claim": "Pool share claimed", "earn-deposit": "Earn deposit", "earn-withdraw": "Earn withdrawal", "lp-add": "Liquidity added", "lp-remove": "Liquidity withdrawn", "lp-collect": "LP fees collected", basket: "Basket", "plan-run": "Plan run" };

/**
 * Everything done through the app, as numbers a reader can check. The page leads with one
 * window's headline figures, then breaks them down by where they happened — trading, strategies,
 * gifts, Earn — and ends with how they were verified and the transactions behind them.
 */
export function StatsView() {
  const { data, isLoading, isError } = useStats();
  const [win, setWin] = useState<StatsWindowKey>("all");
  const s = data?.windows[win];

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="Stats"
        title="Platform statistics"
        lead="What has been done through BStocks, counted from the app's own records and checked against Base. A transaction counts only once its receipt says it succeeded; nothing here is estimated."
        action={<Segmented<StatsWindowKey> size="sm" className="w-[240px] shrink-0" ariaLabel="Window" value={win} onChange={setWin} options={WINDOWS} />}
      />

      {isError && <p className="text-[14px] text-danger-fg">Statistics could not be loaded.</p>}
      {isLoading && !data && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      )}

      {data && s && (
        <>
          <Headline s={s} windowKey={win} data={data} />

          <Module>
            <ModuleHeader title="Activity by day · last 30 days" action={<span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted">UTC · verified only</span>} />
            <DailyBars days={data.daily} />
            <Collapsible title="Table view" className="px-4">
              <DailyTable days={data.daily} />
            </Collapsible>
          </Module>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Trading data={data} />
            <Strategies data={data} />
            <Gifts data={data} />
            <div className="flex flex-col gap-6">
              <Earn data={data} />
              <People data={data} />
            </div>
          </div>

          <Verification data={data} />
          <Ledger entries={data.ledger} />
        </>
      )}
    </div>
  );
}

/* ------------------------------ headline ------------------------------ */

function Headline({ s, windowKey, data }: { s: StatsSummary; windowKey: StatsWindowKey; data: PlatformStats }) {
  const delivered = s.directGifts + s.linksClaimed + s.poolClaims;
  const tiles: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Trade volume", value: usd(s.tradeVolumeUsd), sub: `${usd(s.buyVolumeUsd)} bought · ${usd(s.sellVolumeUsd)} sold` },
    { label: "Trades", value: n(s.trades), sub: `${plural(s.buys, "buy")} · ${plural(s.sells, "sell")}` },
    { label: "Wallets", value: n(s.wallets), sub: "with a confirmed action" },
    { label: "Gifts delivered", value: n(delivered), sub: `${n(s.directGifts)} direct · ${n(s.linksClaimed)} links · ${n(s.poolClaims)} pool shares` },
    { label: "USDC into Earn", value: usd(s.earnDepositUsd), sub: `${plural(s.earnDeposits, "deposit")} · ${usd(s.earnWithdrawalUsd)} withdrawn` },
    { label: "Baskets built", value: n(s.basketsBuilt), sub: "at least one leg landed" },
    { label: "Plan runs", value: n(s.planRuns), sub: `${usd(s.planRunUsd)} bought on schedule` },
    { label: "Reverted", value: n(s.reverted), sub: "submitted, failed onchain" },
  ];
  return (
    <Module ticks>
      <ModuleHeader title={`Headline · ${WINDOW_LABEL[windowKey]}`} action={<span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted">updated <TimeAgo value={data.generatedAt} /></span>} />
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line">
        {tiles.map((t) => (
          <div key={t.label} className="bg-canvas p-4 md:p-5 flex flex-col gap-1.5 min-w-0">
            <dt className="eyebrow">{t.label}</dt>
            <dd className="display num text-[26px] md:text-[32px] leading-none truncate">{t.value}</dd>
            {t.sub && <dd className="text-[12px] text-ink-secondary num leading-snug">{t.sub}</dd>}
          </div>
        ))}
      </dl>
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">
        {n(data.verification.verified)} transactions verified on Base
        {data.verification.pending > 0 ? ` · ${n(data.verification.pending)} still pending` : ""}
        {data.verification.reverted > 0 ? ` · ${n(data.verification.reverted)} reverted and left out` : ""}. Times are block times where the receipt was read.
      </p>
    </Module>
  );
}

/* ------------------------------ daily bars ------------------------------ */

/**
 * One series, thirty columns: dollars traded per day. The bar is the only loud thing; ticks and
 * the baseline are hairlines, the peak carries the one direct label, and every bar answers on
 * hover with the day, the volume and the count. The table below has the same numbers for anyone
 * who would rather read than hover.
 */
function DailyBars({ days }: { days: DailyStat[] }) {
  const W = 720;
  const H = 160;
  const PAD = { top: 18, right: 12, bottom: 22, left: 44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = Math.max(0, ...days.map((d) => d.volumeUsd));
  const top = niceCeil(max);
  const slot = innerW / Math.max(1, days.length);
  const bar = Math.min(24, Math.max(4, slot - 2));
  const y = (v: number) => PAD.top + innerH - (top > 0 ? (v / top) * innerH : 0);
  const peak = days.reduce((best, d, i) => (d.volumeUsd > (days[best]?.volumeUsd ?? -1) ? i : best), -1);
  const ticks = top > 0 ? [0, top / 2, top] : [0];
  const quiet = max === 0;
  return (
    <div className="px-2 pt-3 pb-1 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[520px]" role="img" aria-label="Trade volume per day, last 30 days">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fontFamily="var(--font-mono), ui-monospace, monospace" fill="var(--text-muted)">
              {t === 0 ? "$0" : formatUsdCompact(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD.left + i * slot + (slot - bar) / 2;
          const h = Math.max(0, y(0) - y(d.volumeUsd));
          const r = Math.min(4, h);
          const label = `${d.day} · ${formatUsd(d.volumeUsd)} · ${plural(d.trades, "trade")} · ${plural(d.wallets, "wallet")}`;
          return (
            <g key={d.day} className="stats-bar" tabIndex={0} aria-label={label}>
              <title>{label}</title>
              {/* The hit target is the whole slot, not the painted bar. */}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} fill="transparent" />
              {h > 0 ? <path d={`M${x},${y(0)} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${bar - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`} fill="var(--primary)" /> : <rect x={x} y={y(0) - 1} width={bar} height={1} fill="var(--border-strong)" />}
              {i === peak && d.volumeUsd > 0 && (
                <text x={x + bar / 2} y={y(d.volumeUsd) - 5} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono), ui-monospace, monospace" fill="var(--text-secondary)">
                  {formatUsdCompact(d.volumeUsd)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth="1" />
        {[0, Math.floor(days.length / 2), days.length - 1].map((i) => {
          const d = days[i];
          if (!d) return null;
          return (
            <text key={d.day} x={PAD.left + i * slot + slot / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} fontSize="10" fontFamily="var(--font-mono), ui-monospace, monospace" fill="var(--text-muted)">
              {d.day.slice(5)}
            </text>
          );
        })}
      </svg>
      {quiet && <p className="px-2 pb-2 text-[12px] text-ink-secondary">No verified trades in the last 30 days.</p>}
      <style>{`.stats-bar:hover path, .stats-bar:focus-visible path { fill: var(--primary-strong); } .stats-bar:focus-visible { outline: none; }`}</style>
    </div>
  );
}

/** A clean top for the axis: 1, 2, 5 × 10ⁿ at or above the maximum. */
function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function DailyTable({ days }: { days: DailyStat[] }) {
  const rows = [...days].reverse().filter((d) => d.events > 0);
  if (rows.length === 0) return <p className="text-[13px] text-ink-secondary py-1">Nothing verified in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] font-mono">
        <thead>
          <tr className="text-ink-muted uppercase tracking-[0.06em] text-[10px]">
            <th className="text-left py-2 pr-3">day (UTC)</th>
            <th className="text-right py-2 px-2">trades</th>
            <th className="text-right py-2 px-2">volume</th>
            <th className="text-right py-2 px-2">events</th>
            <th className="text-right py-2 pl-2">wallets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.day} className="border-t border-line">
              <td className="py-1.5 pr-3">{d.day}</td>
              <td className="text-right py-1.5 px-2 num">{n(d.trades)}</td>
              <td className="text-right py-1.5 px-2 num">{formatUsd(d.volumeUsd)}</td>
              <td className="text-right py-1.5 px-2 num">{n(d.events)}</td>
              <td className="text-right py-1.5 pl-2 num">{n(d.wallets)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ sections ------------------------------ */

function Trading({ data }: { data: PlatformStats }) {
  const { byAsset, byProvider, withoutUsd } = data.trading;
  return (
    <Module>
      <ModuleHeader title="Trading · all time" action={<Link href="/markets" className="text-[13px] text-primary font-medium">Markets</Link>} />
      {byAsset.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-ink-secondary">No verified trades yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] font-mono">
            <thead>
              <tr className="text-ink-muted uppercase tracking-[0.06em] text-[10px]">
                <th className="text-left px-4 py-2">stock</th>
                <th className="text-right px-2 py-2">buys</th>
                <th className="text-right px-2 py-2">bought</th>
                <th className="text-right px-2 py-2">sells</th>
                <th className="text-right px-2 py-2">sold</th>
                <th className="text-right px-4 py-2">gifted</th>
              </tr>
            </thead>
            <tbody>
              {byAsset.map((a) => (
                <tr key={a.assetAddress} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    <Link href={`/stocks/${a.assetAddress}`} className="font-medium text-ink hover:text-primary">
                      {a.underlying}
                    </Link>
                  </td>
                  <td className="text-right px-2 py-1.5 num">{n(a.buys)}</td>
                  <td className="text-right px-2 py-1.5 num">{formatUsd(a.buyUsd)}</td>
                  <td className="text-right px-2 py-1.5 num">{n(a.sells)}</td>
                  <td className="text-right px-2 py-1.5 num">{formatUsd(a.sellUsd)}</td>
                  <td className="text-right px-4 py-1.5 num text-ink-secondary">{a.gifted > 0 ? `${a.gifted.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${a.underlying}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-4 py-3 border-t border-line">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">By route</div>
        {byProvider.length === 0 && <p className="text-[13px] text-ink-secondary">—</p>}
        {byProvider.map((p) => (
          <KeyValue key={p.provider} k={providerLabel(p.provider)} v={`${plural(p.count, "trade")} · ${formatUsd(p.usd)}`} />
        ))}
      </div>
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">
        A trade is one stock in one transaction; a basket of four is four trades, one auto-invest run of three stocks is three. Volume is the USD the app recorded when the quote was taken.
        {withoutUsd > 0 ? ` ${plural(withoutUsd, "trade")} carried no USD value and ${withoutUsd === 1 ? "is" : "are"} counted but not summed.` : ""}
      </p>
    </Module>
  );
}

function Strategies({ data }: { data: PlatformStats }) {
  const { executions: e, autoInvest: a, manualPlans: m, community: c } = data.strategies;
  return (
    <Module>
      <ModuleHeader title="Strategies · all time" action={<Link href="/build" className="text-[13px] text-primary font-medium">Build</Link>} />
      <div className="px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Baskets and rebalances</div>
        <KeyValue k="Started" v={n(e.started)} />
        <KeyValue k="Complete · partial · failed" v={`${n(e.complete)} · ${n(e.partial)} · ${n(e.failed)}`} />
        <KeyValue k="Legs landed · failed" v={`${n(e.legsConfirmed)} · ${n(e.legsFailed)}`} />
        <KeyValue k="Bought through baskets" v={formatUsd(e.usd)} />
      </div>
      <div className="px-4 py-3 border-t border-line">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Auto-invest (onchain plans)</div>
        <KeyValue k="Plans" v={`${n(a.plans)} · ${n(a.active)} active · ${n(a.paused)} paused · ${n(a.cancelled)} cancelled`} />
        <KeyValue k="Runs that bought" v={`${n(a.runs)} · ${n(a.keeperRuns)} by the keeper · ${n(a.walletRuns)} from a wallet${a.runs > a.keeperRuns + a.walletRuns ? ` · ${n(a.runs - a.keeperRuns - a.walletRuns)} from trade records only` : ""}`} />
        <KeyValue k="Runs that failed" v={n(a.failedRuns)} />
        <KeyValue k="Bought on schedule" v={formatUsd(a.usd)} />
      </div>
      <div className="px-4 py-3 border-t border-line">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Manual plans (confirmed per run)</div>
        <KeyValue k="Plans" v={`${n(m.plans)} · ${n(m.active)} active`} />
        <KeyValue k="Runs · bought" v={`${n(m.runs)} · ${formatUsd(m.usd)}`} />
      </div>
      <div className="px-4 py-3 border-t border-line">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Community</div>
        <KeyValue k="Published baskets" v={n(c.baskets)} />
        <KeyValue k="Votes · clones" v={`${n(c.votes)} · ${n(c.clones)}`} />
      </div>
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">A basket&apos;s legs are already in the trade figures; nothing here is added to volume twice.</p>
    </Module>
  );
}

function Gifts({ data }: { data: PlatformStats }) {
  const { direct, links, pools } = data.gifts;
  return (
    <Module>
      <ModuleHeader title="Gifts · all time" action={<Link href="/gifts" className="text-[13px] text-primary font-medium">Gifts</Link>} />
      <div className="px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Direct</div>
        <KeyValue k="Sent from a wallet" v={n(direct.sendExisting)} />
        <KeyValue k="Bought for someone" v={n(direct.buyForRecipient)} />
        <KeyValue k="Worth today" v={formatUsd(direct.valueUsdToday)} />
      </div>
      <div className="px-4 py-3 border-t border-line">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Claim links</div>
        <KeyValue k="Funded" v={n(links.created)} />
        <KeyValue k="Claimed · open · expired · cancelled" v={`${n(links.claimed)} · ${n(links.open)} · ${n(links.expired)} · ${n(links.reclaimed)}`} />
        <KeyValue k="Funded, worth today" v={formatUsd(links.valueUsdToday)} />
      </div>
      <div className="px-4 py-3 border-t border-line">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Gift pools</div>
        <KeyValue k="Funded" v={`${n(pools.created)} · ${n(pools.live)} open · ${n(pools.closed)} closed`} />
        <KeyValue k="Shares offered" v={n(pools.slots)} />
        <KeyValue k="Shares claimed" v={`${n(pools.claimsConfirmed + pools.claimsReconciled)} · ${n(pools.claimsReconciled)} matched to a PoolClaimed log`} />
        <KeyValue k="Shares offered, worth today" v={formatUsd(pools.sharesValueUsdToday)} />
      </div>
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">Transfers carry no USD figure at the time, so gifts are valued at today&apos;s price. A gift bought for someone is also one trade in the trading figures.</p>
    </Module>
  );
}

function Earn({ data }: { data: PlatformStats }) {
  const { deposits, withdrawals, byProvider, liquidity } = data.earn;
  return (
    <Module>
      <ModuleHeader title="Earn · all time" action={<Link href="/earn" className="text-[13px] text-primary font-medium">Earn</Link>} />
      <div className="px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">USDC lending · Morpho, Aave, Compound</div>
        <KeyValue k="Deposits" v={`${n(deposits.count)} · ${formatUsd(deposits.usd)}`} />
        <KeyValue k="Withdrawals" v={`${n(withdrawals.count)} · ${formatUsd(withdrawals.usd)}`} />
        <KeyValue k="Net into venues" v={formatUsd(deposits.usd - withdrawals.usd)} />
      </div>
      {byProvider.length > 0 && (
        <div className="px-4 py-3 border-t border-line">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">By venue</div>
          {byProvider.map((p) => (
            <KeyValue key={p.provider} k={providerLabel(p.provider)} v={`in ${formatUsd(p.depositUsd)} (${n(p.deposits)}) · out ${formatUsd(p.withdrawalUsd)} (${n(p.withdrawals)})`} />
          ))}
        </div>
      )}
      <div className="px-4 py-3 border-t border-line">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Liquidity positions · Uniswap v3, Aerodrome Slipstream</div>
        <KeyValue k="Opened" v={`${n(liquidity.added.count)} · ${formatUsd(liquidity.added.usd)}`} />
        <KeyValue k="Withdrawn" v={`${n(liquidity.removed.count)} · ${formatUsd(liquidity.removed.usd)}`} />
        <KeyValue k="Fees collected" v={`${n(liquidity.collected.count)} · ${formatUsd(liquidity.collected.usd)}`} />
      </div>
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">
        Lending deposits and withdrawals are read from the venues&apos; own events on Base for every wallet the app knows, so a record the browser failed to write is still counted. Liquidity positions are recorded when opened, withdrawn or harvested in the app, at the pool price at the time. Positions opened at a venue directly are not counted.
      </p>
    </Module>
  );
}

function People({ data }: { data: PlatformStats }) {
  const p = data.people;
  return (
    <Module>
      <ModuleHeader title="People" action={<Link href="/community" className="text-[13px] text-primary font-medium">Community</Link>} />
      <div className="px-4 py-3">
        <KeyValue k="Wallets with a confirmed action" v={n(p.transactingWallets)} />
        <KeyValue k="Wallets known to the app" v={n(p.knownWallets)} />
        <KeyValue k="Profiles · public" v={`${n(p.profiles)} · ${n(p.publicProfiles)}`} />
        <KeyValue k="Opened their portfolio" v={n(p.portfolioWallets)} />
        <KeyValue k="Watchlists · entries" v={`${n(p.watchlistWallets)} · ${n(p.watchlistEntries)}`} />
        <KeyValue k="AI briefs written · spend this month" v={`${n(p.aiBriefs)} · ${formatUsd(p.aiSpendUsd)}`} />
      </div>
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">A wallet counts once, however much it did. Nobody is named here.</p>
    </Module>
  );
}

function Verification({ data }: { data: PlatformStats }) {
  const v = data.verification;
  return (
    <Module>
      <ModuleHeader title="How these numbers are made" />
      <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-line">
        {[
          { label: "Verified", value: n(v.verified), tone: "positive" as const },
          { label: "Pending", value: n(v.pending), tone: v.pending > 0 ? ("warning" as const) : ("neutral" as const) },
          { label: "Reverted", value: n(v.reverted), tone: v.reverted > 0 ? ("danger" as const) : ("neutral" as const) },
          { label: "No transaction", value: n(v.withoutTx), tone: "neutral" as const },
          { label: "Duplicates collapsed", value: n(v.duplicatesCollapsed), tone: "neutral" as const },
          { label: "Not checked", value: n(v.unchecked), tone: v.unchecked > 0 ? ("warning" as const) : ("neutral" as const) },
        ].map((t) => (
          <div key={t.label} className="bg-canvas p-4 flex flex-col gap-1.5">
            <span className="eyebrow">{t.label}</span>
            <span className="display num text-[24px] leading-none">{t.value}</span>
            <Badge tone={t.tone} className="w-fit">
              {t.tone === "positive" ? "counted" : t.tone === "neutral" && t.label === "Duplicates collapsed" ? "counted once" : "left out"}
            </Badge>
          </div>
        ))}
      </div>
      <ul className="px-4 py-3 border-t border-line text-[13px] text-ink-secondary flex flex-col gap-1.5 list-disc pl-8">
        <li>Every transaction hash the app recorded is looked up on Base once; the receipt is kept, so the numbers are the same from every server. Only receipts that say <span className="font-mono">success</span> count.</li>
        <li>One transaction, one stock, one side is one trade. The basket executor writes both an execution and a trade row per leg, and an auto-invest run writes one row per stock: they are merged on that key, never added twice.</li>
        <li>A gift bought for someone is one trade and one gift on the same transaction, and appears in both sections on purpose.</li>
        <li>Records without a hash (a review that was closed, a draft) and hashes not yet mined are listed above and excluded. Times use the block when it is known, otherwise the app&apos;s clock.</li>
        <li>Recomputed from the tables every five minutes; nothing is a running counter that could drift.</li>
      </ul>
    </Module>
  );
}

function Ledger({ entries }: { entries: LedgerEntry[] }) {
  return (
    <Module>
      <ModuleHeader title="Latest verified transactions" action={<span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted">last {entries.length}</span>} />
      {entries.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-ink-secondary">Nothing verified yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] font-mono">
            <thead>
              <tr className="text-ink-muted uppercase tracking-[0.06em] text-[10px]">
                <th className="text-left px-4 py-2">when</th>
                <th className="text-left px-2 py-2">what</th>
                <th className="text-left px-2 py-2">stock</th>
                <th className="text-right px-2 py-2">usd</th>
                <th className="text-right px-2 py-2">block</th>
                <th className="text-right px-4 py-2">tx</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.txHash}:${e.kind}:${i}`} className="border-t border-line">
                  <td className="px-4 py-1.5 whitespace-nowrap" title={new Date(e.at).toISOString()}>
                    {timeAgo(e.at)}
                  </td>
                  <td className={cx("px-2 py-1.5 whitespace-nowrap", e.kind === "buy" || e.kind === "link-claim" || e.kind === "pool-claim" ? "text-positive-fg" : e.kind === "sell" ? "text-danger-fg" : "text-ink")}>
                    {LEDGER_LABEL[e.kind]}
                    {e.count && e.count > 1 ? ` × ${e.count}` : ""}
                  </td>
                  <td className="px-2 py-1.5">{e.symbol?.replace(/c$/, "") ?? "—"}</td>
                  <td className="text-right px-2 py-1.5 num">{e.usd !== undefined ? formatUsd(e.usd) : "—"}</td>
                  <td className="text-right px-2 py-1.5 num text-ink-muted">{e.blockNumber ?? "—"}</td>
                  <td className="text-right px-4 py-1.5">
                    <TxLink hash={e.txHash}>{e.txHash.slice(0, 10)}…</TxLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">Each line is one receipt on Base; open it on Basescan to check the figure. Gift values are at today&apos;s price.</p>
    </Module>
  );
}
