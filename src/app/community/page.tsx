import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CommunityView } from "@/components/community/CommunityView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";

export const metadata: Metadata = pageMeta({ title: "Community", path: "/community" });

export default function CommunityPage() {
  return (
    <StrategiesShell
      tab="community"
      action={
        <Link href="/build" className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-[6px] bg-primary text-primary-contrast font-medium text-[14px] hover:bg-primary-strong transition-fast">
          Publish a basket <ArrowRight size={16} strokeWidth={1.75} />
        </Link>
      }
    >
      <CommunityView embedded />
    </StrategiesShell>
  );
}
