import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { getSharedReturn, type SharedReturn } from "@/services/pnl-service";
import { pageMeta } from "@/lib/page-meta";
import { formatPct, formatUsd } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { LinkButton, Module, PageTitle } from "@/components/ui/primitives";

type Props = { params: Promise<{ wallet: string; asset: string }> };

/** Read on every request; the figures underneath are shared-cached for five minutes (`getSharedReturn`). */
export const dynamic = "force-dynamic";

async function load(params: Props["params"]): Promise<{ r: SharedReturn | null; path: string }> {
  const { wallet, asset } = await params;
  const path = `/pnl/${wallet}/${asset}`;
  if (!isAddress(wallet)) return { r: null, path };
  return { r: await getSharedReturn(getAddress(wallet), asset).catch(() => null), path };
}

const pct = (v: number) => formatPct(v, { digits: 1 });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { r, path } = await load(params);
  // A person's return is theirs to pass around, not a page for search engines.
  if (!r) return pageMeta({ title: "Return", path, noindex: true });
  return pageMeta({
    title: `${r.underlying} ${pct(r.returnPct)}`,
    description: `${pct(r.returnPct)} on ${r.underlying} bought on BStocks: ${formatUsd(r.avgCostPerShare)} average cost, ${formatUsd(r.pricePerShare)} per share now. Tokenized stocks on Base.`,
    path,
    noindex: true,
  });
}

/**
 * A shared return: the stock, the percentage and the two per-share prices behind it. No dollar
 * amounts, no share count and no address on the page, the same as on its card.
 */
export default async function SharedReturnPage({ params }: Props) {
  const { r } = await load(params);
  if (!r) notFound();
  const up = r.returnPct >= 0;
  return (
    <div className="flex flex-col gap-6 max-w-[720px]">
      <PageTitle
        index="Return"
        title={
          <span className="inline-flex items-center gap-3">
            <AssetLogo src={r.logoURI} symbol={r.underlying} size={40} />
            {r.underlying}
          </span>
        }
        lead={`${r.name}, held as a Coinbase Tokenized Stock on Base and bought on BStocks.`}
      />
      <Module>
        <div className="p-4 md:p-6 flex flex-col gap-4">
          <div className={up ? "display num text-[56px] leading-none text-positive-fg" : "display num text-[56px] leading-none text-danger-fg"}>{pct(r.returnPct)}</div>
          <dl className="grid grid-cols-2 gap-4 max-w-[420px]">
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Average cost</dt>
              <dd className="num text-[18px] font-medium mt-1">{formatUsd(r.avgCostPerShare)} / share</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Now</dt>
              <dd className="num text-[18px] font-medium mt-1">{formatUsd(r.pricePerShare)} / share</dd>
            </div>
          </dl>
          <p className="text-[13px] text-ink-secondary">
            Measured on the shares bought through BStocks and still held, against the current market price on Base{r.partial ? "; stock that arrived as a gift or transfer has no purchase price and is left out" : ""}. Past returns say nothing about future ones, and this is not investment advice.
          </p>
        </div>
        <div className="border-t border-line p-4 md:px-6 flex flex-wrap gap-2">
          <LinkButton href={`/stocks/${r.assetAddress}`} variant="primary">
            Open {r.underlying}
          </LinkButton>
          <LinkButton href="/how-it-works">How BStocks works</LinkButton>
        </div>
      </Module>
    </div>
  );
}
