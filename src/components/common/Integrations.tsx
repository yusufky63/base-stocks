import Link from "next/link";
import { FOOTER_INTEGRATIONS, INTEGRATIONS } from "@/content/integrations";
import { IntegrationMark } from "./IntegrationMark";

/** Full list for /how-it-works: one module per job, each platform with its role. */
export function IntegrationsSection() {
  return (
    <section id="integrations" className="flex flex-col gap-3 scroll-mt-24">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="eyebrow">Integrations</div>
        <Link href="/status" className="text-[13px] text-primary hover:underline">
          Live state of every dependency →
        </Link>
      </div>
      <div className="module-grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 ticks">
        {INTEGRATIONS.map((g) => (
          <article key={g.id} className="rail p-4 flex flex-col gap-3">
            <div>
              <div className="font-medium">{g.title}</div>
              <p className="text-[13px] text-ink-secondary mt-1">{g.blurb}</p>
            </div>
            <ul className="flex flex-col gap-2">
              {g.items.map((i) => (
                <li key={`${g.id}-${i.name}`} className="flex items-center gap-2.5 min-w-0">
                  <IntegrationMark name={i.name} mark={i.mark} color={i.color} size={20} />
                  <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-[14px] font-medium hover:text-primary transition-fast shrink-0">
                    {i.name}
                  </a>
                  <span className="text-[12px] text-ink-muted truncate">{i.role}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <p className="text-[12px] text-ink-muted">Which routes and venues are active depends on the deployment keys and on what each protocol lists; the app never assumes a market exists. Protocol names are shown on every final confirmation.</p>
    </section>
  );
}

/** Compact mark strip for the footer; every mark links to the full list. */
export function IntegrationsStrip() {
  return (
    <Link href="/how-it-works#integrations" className="inline-flex items-center gap-2 text-[12px] text-ink-muted hover:text-primary transition-fast" aria-label="Integrated platforms">
      <span className="inline-flex items-center -space-x-1.5">
        {FOOTER_INTEGRATIONS.slice(0, 10).map((i) => (
          <span key={i.name} title={i.name} className="rounded-full ring-2 ring-canvas">
            <IntegrationMark name={i.name} mark={i.mark} color={i.color} size={18} />
          </span>
        ))}
      </span>
      <span>Integrations</span>
    </Link>
  );
}
