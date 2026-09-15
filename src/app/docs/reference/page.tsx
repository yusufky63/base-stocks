import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import Link from "next/link";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdown } from "@/lib/markdown";

export const metadata: Metadata = pageMeta({
  title: "Technical reference",
  description: "The full technical reference for BStocks, generated from docs/HOW_IT_WORKS.md: contracts, data sources, providers, environment, routes and operations.",
  path: "/docs/reference",
});

/**
 * `docs/HOW_IT_WORKS.md`, rendered. The Markdown file is the maintained source — it changes with
 * every feature — and this page is generated from it at build time, so the two can no longer
 * drift apart. The narrative on `/docs` stays hand-written; this is the reference behind it.
 */
export default function ReferencePage() {
  const md = readFileSync(resolve(process.cwd(), "docs/HOW_IT_WORKS.md"), "utf8");
  const { html, headings } = renderMarkdown(md);
  const toc = headings.filter((h) => h.level === 2 || h.level === 3);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="eyebrow mb-2">Docs — Reference</div>
        <h1 className="display text-[36px] md:text-[48px] leading-none">Technical reference</h1>
        <p className="mt-3 text-[15px] text-ink-secondary max-w-[64ch]">
          Generated at build time from <code className="font-mono text-[13px]">docs/HOW_IT_WORKS.md</code> in the repository, so the page and the file cannot disagree. The narrative version is on <Link href="/docs" className="text-primary font-medium">Technical docs</Link>.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-6 items-start">
        <nav aria-label="Sections" className="lg:sticky lg:top-header border border-line rounded-[8px] bg-canvas p-3 max-h-[80vh] overflow-y-auto">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted mb-2">Sections</div>
          <ol className="flex flex-col gap-0.5">
            {toc.map((h) => (
              <li key={h.id} className={h.level === 3 ? "pl-3" : ""}>
                <a href={`#${h.id}`} className="block py-1 text-[13px] text-ink-secondary hover:text-primary truncate">
                  {h.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="prose-docs border border-line rounded-[8px] bg-canvas p-5 md:p-8 min-w-0" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
