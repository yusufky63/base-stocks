import type { Metadata } from "next";
import { AutomateView } from "@/components/automate/AutomateView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";

export const metadata: Metadata = { title: "Automate" };

export default function AutomatePage() {
  return (
    <StrategiesShell tab="automate">
      <AutomateView embedded />
    </StrategiesShell>
  );
}
