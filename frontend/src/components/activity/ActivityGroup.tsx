"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { auditHref } from "@/lib/auditLog";
import { cx } from "@/lib/cx";
import { formatClock } from "@/lib/format";
import { categoryLabel } from "@/lib/labels";
import { findFinished, outcomeOf, traceSteps, type CommandGroup } from "@/lib/steps";
import { TierBadge, ToneBadge } from "../Badge";
import { ChevronRightIcon, LedgerIcon } from "../icons";
import { ProgressTrace } from "../ProgressTrace";
import { button } from "../ui";

interface ActivityGroupProps {
  group: CommandGroup;
  /** The command was sent from this page. */
  fromThisDevice: boolean;
  /** Whether the trace starts expanded; later changes are the user's. */
  defaultOpen: boolean;
}

function sourceLabel(group: CommandGroup, fromThisDevice: boolean): string {
  if (fromThisDevice) return "this device";
  return group.clientId ? "another device" : "other client";
}

/** One command's events on the Activity screen, collapsible to its summary. */
export function ActivityGroup({ group, fromThisDevice, defaultOpen }: ActivityGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const outcome = outcomeOf(group.events);
  const running = findFinished(group.events) === null && (outcome?.label === "Running" || outcome?.label === "Confirmed");

  return (
    <li className="animate-rise rounded-xl border border-line bg-panel">
      <div className="flex items-start gap-3 py-2 pr-4 pl-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised"
        >
          <ChevronRightIcon
            className={cx(
              "mt-1 h-4 w-4 shrink-0 text-fg-faint transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cx(
                "block text-[15px] leading-6 font-medium break-words",
                group.command ? "text-fg" : "text-fg-muted italic",
              )}
            >
              {group.command ?? "Sent before this page connected"}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[12px] leading-5 text-fg-muted">
              <span className="tabular-nums">{formatClock(group.firstTs)}</span>
              {group.category && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{categoryLabel(group.category)}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>{sourceLabel(group, fromThisDevice)}</span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1.5 pt-2">
          {outcome && (
            <ToneBadge tone={outcome.tone}>
              <span className="sr-only">Status: </span>
              {outcome.label}
            </ToneBadge>
          )}
          {group.tier && <TierBadge tier={group.tier} />}
        </div>
      </div>

      {open && (
        <div id={panelId} className="border-t border-line px-4 pt-3.5 pb-2">
          <ProgressTrace
            steps={traceSteps(group.events)}
            running={running}
            label={`Steps for ${group.command ?? `command ${group.commandId}`}`}
            originTs={group.firstTs}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-1.5">
            <span className="font-mono text-[11px] text-fg-faint">
              <span className="sr-only">Command id </span>
              {group.commandId}
            </span>
            <Link href={auditHref({ commandId: group.commandId })} className={button("ghost", "sm")}>
              <LedgerIcon className="h-4 w-4" />
              Audit entries
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}
