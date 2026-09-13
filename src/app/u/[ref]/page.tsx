import type { Metadata } from "next";
import { ProfileView } from "@/components/community/ProfileView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";

// No `revalidate`: the server renders only the shell here and ProfileView fetches the profile in the
// browser, so a 60 s cache on the shell was caching nothing that changes. Rendering the profile on the
// server would need the route's own loader (repositories, badges, a portfolio snapshot) in the page,
// which this page does not own; the client fetch stays.

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ref } = await params;
  return { title: `${ref.startsWith("0x") ? `${ref.slice(0, 6)}…` : `@${ref}`} · Profile` };
}

/** Public pages are part of Community; the section tabs stay so the way back is one tap. */
export default async function ProfilePage({ params }: Props) {
  const { ref } = await params;
  return (
    <StrategiesShell tab="community" compact>
      <ProfileView refParam={ref} />
    </StrategiesShell>
  );
}
