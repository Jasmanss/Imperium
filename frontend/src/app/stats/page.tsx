import type { Metadata } from "next";
import { StatsScreen } from "@/components/stats/StatsScreen";

export const metadata: Metadata = { title: "Stats" };

export default function StatsPage() {
  return <StatsScreen />;
}
