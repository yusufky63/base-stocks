"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { cx } from "@/components/ui/primitives";

export interface DocEntry {
  /** Anchor id on the page, so a hit can be jumped to. */
  id: string;
  title: string;
  /** Everything a reader might search for in this section, concatenated. */
  body: string;
}

/**
 * Search across one documentation page, in the page itself.
 *
 * These pages are long and the answer to a question is usually one paragraph deep inside a section
 * a reader has no reason to guess at: "why is my reference price frozen" lives under a heading
 * called Price model. Browser find works only on what is on screen and matches nothing useful in a
 * collapsed FAQ, so the sections are indexed from the same arrays that render them and filtered
 * here. Nothing is fetched, and an empty query renders nothing at all.
 */
export function DocSearch({ entries, placeholder = "Search this page" }: { entries: DocEntry[]; placeholder?: string }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const hits = useMemo(() => {
    if (query.length < 2) return [];
    // Every word has to appear somewhere in the section, in any order: "stale reference" should
    // find a paragraph that says "the reference price is stale" as readily as one that does not.
    const words = query.split(/\s+/).filter(Boolean);
    return entries
      .map((e) => ({ e, hay: `${e.title} ${e.body}`.toLowerCase() }))
      .filter(({ hay }) => words.every((w) => hay.includes(w)))
      .map(({ e }) => ({ ...e, excerpt: excerptAround(e.body, words[0]!) }))
      .slice(0, 8);
  }, [entries, query]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search size={15} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full h-11 pl-9 pr-9 rounded-[8px] border border-line bg-canvas text-[14px] text-ink placeholder:text-ink-muted outline-none focus-visible:border-primary transition-fast"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink transition-fast">
            <X size={15} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {query.length >= 2 && (
        <div className="border border-line rounded-[8px] bg-canvas overflow-hidden">
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-ink-secondary">
              Nothing on this page matches “{q.trim()}”.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {hits.map((h) => (
                <li key={h.id + h.title}>
                  <a href={`#${h.id}`} onClick={() => setQ("")} className={cx("block px-3 py-2.5 hover:bg-surface transition-fast")}>
                    <span className="block text-[13px] font-medium">{h.title}</span>
                    <span className="block text-[12px] text-ink-secondary leading-snug mt-0.5 line-clamp-2">{h.excerpt}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** A window of the section's own text around the first match, so the reader sees why it matched. */
function excerptAround(body: string, word: string): string {
  const at = body.toLowerCase().indexOf(word);
  // The word may have matched the title instead; the opening of the body is the useful fallback.
  if (at < 0) return body.slice(0, 180).trim();
  const start = Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + body.slice(start, start + 200).trim();
}
