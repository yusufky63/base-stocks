import type { ComponentType, ReactNode } from "react";

/**
 * The section furniture the long-form pages share (/docs, /developers): a numbered heading that
 * anchors clear of the sticky header, and a cell for a three-up grid of short points. One copy, so
 * the two pages cannot drift in spacing or in how far an anchor lands below the header.
 */
export function SectionHead({ n, id, title, sub }: { n: number; id: string; title: string; sub?: string }) {
  return (
    <div id={id} className="scroll-mt-header flex flex-wrap items-baseline justify-between gap-2">
      <div className="flex items-baseline gap-3">
        <span className="display num text-[28px] md:text-[34px] text-primary leading-none">{String(n).padStart(2, "0")}</span>
        <h2 className="display-medium text-[22px] md:text-[26px]">{title}</h2>
      </div>
      {sub && <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-muted">{sub}</span>}
    </div>
  );
}

export function Cell({ icon: Icon, title, children }: { icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; title: string; children: ReactNode }) {
  return (
    <article className="rail p-4 md:p-5 flex flex-col gap-2">
      <Icon size={18} strokeWidth={1.75} className="text-primary" />
      <div className="font-medium">{title}</div>
      <p className="text-[13px] text-ink-secondary leading-relaxed">{children}</p>
    </article>
  );
}
