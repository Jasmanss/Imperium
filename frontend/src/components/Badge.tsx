import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { decisionLabel, tierLabel, type Tone } from "@/lib/labels";
import { TONE } from "./ui";

export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] border px-1.5 font-mono text-[10.5px] leading-none font-medium tracking-[0.07em] whitespace-nowrap uppercase",
        TONE[tone].badge,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function TierBadge({ tier }: { tier: string | null | undefined }) {
  const { label, tone } = tierLabel(tier);
  return (
    <ToneBadge tone={tone}>
      <span className="sr-only">Tier: </span>
      {label}
    </ToneBadge>
  );
}

export function DecisionBadge({ decision }: { decision: string | null | undefined }) {
  const { label, tone } = decisionLabel(decision);
  return (
    <ToneBadge tone={tone}>
      <span className="sr-only">Decision: </span>
      {label}
    </ToneBadge>
  );
}
