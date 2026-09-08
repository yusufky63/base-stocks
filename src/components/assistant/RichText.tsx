"use client";

import { Fragment, useMemo } from "react";
import Link from "next/link";
import { useAssets } from "@/hooks/queries";
import { AssetLogo } from "@/components/common/display";
import { cx } from "@/components/ui/primitives";

/**
 * Assistant text, rendered as structure instead of a paragraph blob: "Label: value" lines get a
 * strong label, "- " lines become bullets, money and percentages are set in the numeric face, and
 * every ticker the app knows becomes an inline chip linking to that stock. The model still writes
 * plain sentences — all of this is matched here against live data, so nothing is invented.
 */
export function RichText({ text }: { text: string }) {
  const { data } = useAssets();
  const byTicker = useMemo(() => new Map((data?.assets ?? []).map((a) => [a.underlying.toUpperCase(), a])), [data]);
  const lines = useMemo(() => text.split("\n"), [text]);

  return (
    <div className="flex flex-col gap-1">
      {lines.map((line, i) => {
        const bullet = /^\s*[-•*]\s+/.test(line);
        const body = bullet ? line.replace(/^\s*[-•*]\s+/, "") : line;
        // "Label: rest" — a short, punctuation-free lead only, so a sentence that happens to end
        // in a colon is left as prose.
        const m = /^([^:.,!?]{2,30}):\s*(.*)$/.exec(body);
        const label = m && !bullet ? m[1] : null;
        const rest = m && !bullet ? m[2]! : body;
        if (!line.trim()) return <span key={i} className="h-1" />;
        return (
          <p key={i} className={cx("text-[13px] leading-relaxed", bullet && "pl-3 relative")}>
            {bullet && <span aria-hidden className="absolute left-0 top-[0.6em] h-1 w-1 rounded-full bg-primary" />}
            {/*
              The label goes through Inline too. The prompt tells the model to lead lines with
              "NVDA: …", so rendering the label as plain text defeated the ticker chips on exactly
              the format the prompt mandates.
            */}
            {label && (
              <span className="font-semibold text-ink">
                <Inline text={label} byTicker={byTicker} />:{" "}
              </span>
            )}
            <Inline text={rest} byTicker={byTicker} />
          </p>
        );
      })}
    </div>
  );
}

type Asset = { address: string; logoURI?: string; symbol: string };

/** Ticker chips and numeric emphasis inside one line. */
function Inline({ text, byTicker }: { text: string; byTicker: Map<string, Asset> }) {
  const parts = useMemo(() => {
    const tickers = [...byTicker.keys()].sort((a, b) => b.length - a.length);
    // Longest ticker first so GOOGL is not shadowed; optional trailing "c" catches the B20 symbol.
    const tickerRe = tickers.length ? `\\b(?:${tickers.join("|")})c?\\b` : null;
    const numberRe = "[$₺€]\\s?\\d[\\d.,]*\\s?[kKmMbB]?|[-+]?\\d+[.,]?\\d*\\s?%|%\\s?[-+]?\\d+[.,]?\\d*";
    const re = new RegExp(`(${[tickerRe, numberRe].filter(Boolean).join("|")})`, "g");
    const out: Array<{ t: "text" | "ticker" | "num"; v: string }> = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ t: "text", v: text.slice(last, at) });
      const raw = m[0];
      const asTicker = byTicker.get(raw.toUpperCase().replace(/C$/, "")) ?? byTicker.get(raw.toUpperCase());
      out.push(asTicker ? { t: "ticker", v: raw } : { t: "num", v: raw });
      last = at + raw.length;
    }
    if (last < text.length) out.push({ t: "text", v: text.slice(last) });
    return out;
  }, [text, byTicker]);

  return (
    <>
      {parts.map((p, i) => {
        if (p.t === "text") return <Fragment key={i}>{p.v}</Fragment>;
        if (p.t === "num")
          return (
            <span key={i} className="num font-medium text-ink">
              {p.v}
            </span>
          );
        const ticker = p.v.toUpperCase().replace(/C$/, "");
        const asset = byTicker.get(ticker) ?? byTicker.get(p.v.toUpperCase());
        return asset ? <TickerChip key={i} ticker={ticker} asset={asset} /> : <Fragment key={i}>{p.v}</Fragment>;
      })}
    </>
  );
}

function TickerChip({ ticker, asset }: { ticker: string; asset: Asset }) {
  return (
    <Link
      href={`/stocks/${asset.address}`}
      title={`Open ${ticker}`}
      className="inline-flex items-center gap-1 align-baseline mx-[1px] px-1.5 h-[20px] rounded-[4px] border border-line bg-surface font-mono text-[11px] font-medium text-ink hover:border-primary hover:text-primary transition-fast"
    >
      <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={12} />
      {ticker}
    </Link>
  );
}
