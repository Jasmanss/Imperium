"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import type { LoggedEvent } from "@/lib/eventLog";
import { formatClock } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import type { ResultView } from "@/lib/results";
import { traceSteps } from "@/lib/steps";
import { AlertIcon, CheckIcon, CrossIcon, EditIcon, RetryIcon } from "../icons";
import { ProgressTrace } from "../ProgressTrace";
import { useCommandSession, type FeedEntry } from "../providers/CommandSessionProvider";
import { button, TONE } from "../ui";
import { ConfirmCard } from "./ConfirmCard";
import { ResultCard } from "./ResultCard";

interface FeedItemProps {
  entry: FeedEntry;
  events: readonly LoggedEvent[];
  view: ResultView | null;
  busy: boolean;
  onEdit: (command: string) => void;
  onRetry: (command: string) => void;
}

/** Steps after the confirmation, for a command that is running once confirmed. */
function runEvents(events: readonly LoggedEvent[]): LoggedEvent[] {
  return events.filter((item) => item.event.type !== "command" && item.event.type !== "pending");
}

/** One command in the session feed: what was sent, then its progress, confirmation, or result. */
export function FeedItem({ entry, events, view, busy, onEdit, onRetry }: FeedItemProps) {
  const { confirm, cancel, dismiss } = useCommandSession();
  const edit = () => onEdit(entry.command);
  const retry = () => onRetry(entry.command);
  const parked = entry.parked;

  let body: ReactNode = null;
  switch (entry.phase) {
    case "sending":
      body = <ProgressTrace steps={traceSteps(events)} running label="Progress" />;
      break;
    case "parked":
    case "confirming":
    case "cancelling":
      body = parked && (
        <div className="space-y-4">
          <ConfirmCard
            entry={entry}
            parked={parked}
            onConfirm={() => confirm(entry.key, parked.pending_id)}
            onCancel={() => cancel(entry.key, parked.pending_id)}
            onRetry={retry}
            onDismiss={() => dismiss(entry.key)}
            retryDisabled={busy}
          />
          {entry.phase === "confirming" && (
            <ProgressTrace steps={traceSteps(runEvents(events))} running label="Progress" />
          )}
        </div>
      );
      break;
    case "cancelled":
      body = (
        <ClosedNote tone="muted" title="Cancelled" text="Nothing ran on your Mac." onEdit={edit} onRetry={retry} onDismiss={() => dismiss(entry.key)} retryDisabled={busy} />
      );
      break;
    case "resolved":
      if (entry.resolvedAs === "cancelled") {
        body = (
          <ClosedNote tone="muted" title="Cancelled on another device" text="Nothing ran on your Mac." onEdit={edit} onRetry={retry} onDismiss={() => dismiss(entry.key)} retryDisabled={busy} />
        );
      } else if (view) {
        body = (
          <ResultCard view={view} events={events} note="Confirmed on another device." onEdit={edit} onRetry={retry} retryDisabled={busy} />
        );
      } else {
        body = (
          <div className="space-y-4">
            <ClosedNote tone="act" title="Confirmed on another device" text="It is running on your Mac now." />
            <ProgressTrace steps={traceSteps(runEvents(events))} running label="Progress" />
          </div>
        );
      }
      break;
    case "done":
      body = view && <ResultCard view={view} events={events} onEdit={edit} onRetry={retry} retryDisabled={busy} />;
      break;
    case "rejected":
      body = (
        <ClosedNote tone="danger" title="Not run" text={entry.error} onEdit={edit} onRetry={retry} onDismiss={() => dismiss(entry.key)} retryDisabled={busy} />
      );
      break;
  }

  return (
    <li className="animate-rise">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="font-mono text-[16px] leading-6 text-fg-faint">
          ›
        </span>
        <p className="min-w-0 flex-1 text-[15px] leading-6 font-medium break-words whitespace-pre-wrap text-fg">
          {entry.command}
        </p>
        <span className="shrink-0 pt-0.5 font-mono text-[11px] leading-5 text-fg-faint tabular-nums">
          {formatClock(entry.submittedAt / 1000)}
        </span>
      </div>
      <div className="mt-3 min-w-0 sm:pl-6">{body}</div>
    </li>
  );
}

const NOTE_ICONS: Partial<Record<Tone, typeof CheckIcon>> = {
  danger: AlertIcon,
  act: CheckIcon,
};

function ClosedNote({
  tone,
  title,
  text,
  onEdit,
  onRetry,
  onDismiss,
  retryDisabled = false,
}: {
  tone: Tone;
  title: string;
  text: string | null;
  onEdit?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
  retryDisabled?: boolean;
}) {
  const Icon = NOTE_ICONS[tone] ?? CrossIcon;
  const actions = onEdit || onRetry || onDismiss;
  return (
    <div className={cx("rounded-xl border bg-panel", TONE[tone].border)}>
      <div className="px-4 pt-3.5 pb-3">
        <p className={cx("flex items-center gap-2 text-[14px] leading-5 font-semibold", TONE[tone].text)}>
          <Icon className="h-[18px] w-[18px] shrink-0" />
          {title}
        </p>
        {text && <p className="mt-1.5 text-[14px] leading-5 break-words whitespace-pre-wrap text-fg">{text}</p>}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1.5">
          {onDismiss && (
            <button type="button" onClick={onDismiss} className={button("ghost", "sm")}>
              Dismiss
            </button>
          )}
          <span className="flex-1" />
          {onEdit && (
            <button type="button" onClick={onEdit} className={button("ghost", "sm")}>
              <EditIcon className="h-4 w-4" />
              Edit
            </button>
          )}
          {onRetry && (
            <button type="button" onClick={onRetry} disabled={retryDisabled} className={button("ghost", "sm")}>
              <RetryIcon className="h-4 w-4" />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
