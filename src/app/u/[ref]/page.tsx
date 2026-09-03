import type { Metadata } from "next";
import { ProfileView } from "@/components/community/ProfileView";

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ref } = await params;
  return { title: `${ref.startsWith("0x") ? `${ref.slice(0, 6)}…` : `@${ref}`} · Profile` };
}

export default async function ProfilePage({ params }: Props) {
  const { ref } = await params;
  return <ProfileView refParam={ref} />;
}
