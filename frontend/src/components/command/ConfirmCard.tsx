"use client";

import { useNow } from "@/hooks/useNow";
import { formatCountdown, fractionRemaining, isExpired, secondsRemaining } from "@/lib/countdown";
import { cx } from "@/lib/cx";
import { formatClock } from "@/lib/format";
import { categoryLabel, tierLabel } from "@/lib/labels";
import type { ParkedCommand } from "@/lib/types";
import { TierBadge } from "../Badge";
import { AlertIcon, RetryIcon, ShieldIcon } from "../icons";
import type { FeedEntry } from "../providers/CommandSessionProvider";
import { button, TONE } from "../ui";

interface ConfirmCardProps {
  entry: FeedEntry;
  parked: ParkedCommand;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  retryDisabled: boolean;
}

/**
 * A parked command waiting for Confirm or Cancel. The countdown runs on the
 * Mac's clock (server_time), so a phone whose clock is off still shows the
 * real time left.
 */
export function ConfirmCard({ entry, parked, onConfirm, onCancel, onRetry, onDismiss, retryDisabled }: ConfirmCardProps) {
  const receivedAt = entry.parkedAt ?? 0;
  const now = useNow(receivedAt, 1000, !entry.closed);
  const remaining = secondsRemaining(parked.expires_at, parked.server_time, receivedAt, Math.max(now, receivedAt));
  const expired = isExpired(remaining);
  const confirming = entry.phase === "confirming";
  const cancelling = entry.phase === "cancelling";
  const acting = confirming || cancelling;
  const open = acting || (!entry.closed && !expired);
  const tier = tierLabel(parked.tier);
  const headingId = `confirm-${entry.key}`;

  let title = "Confirm before it runs";
  if (confirming) title = "Confirming…";
  else if (cancelling) title = "Cancelling…";
  else if (entry.closed) title = "Confirmation closed";
  else if (expired) title = "Confirmation expired";

  return (
    <section
      aria-labelledby={headingId}
      className={cx("overflow-hidden rounded-xl border bg-panel", open ? TONE[tier.tone].border : "border-line")}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-4 py-3">
        <ShieldIcon className={cx("h-[18px] w-[18px] shrink-0", open ? TONE[tier.tone].text : "text-fg-faint")} />
        <h2 id={headingId} className="text-[14px] leading-5 font-semibold text-fg">
          {title}
        </h2>
        <TierBadge tier={parked.tier} />
        <span className="font-mono text-[12px] leading-5 text-fg-muted">{categoryLabel(parked.category)}</span>
        <span
          role="timer"
          aria-label={expired ? "Expired" : `Expires in ${formatCountdown(remaining)}`}
          className={cx(
            "ml-auto font-mono text-[13px] leading-5 font-medium tabular-nums",
            expired || entry.closed ? "text-fg-faint" : remaining <= 15 ? "text-danger" : "text-pending",
          )}
        >
          {expired ? "Expired" : formatCountdown(remaining)}
        </span>
      </div>

      <div aria-hidden="true" className="h-0.5 bg-control">
        <div
          className={cx(
            "h-full origin-left transition-transform duration-1000 ease-linear",
            remaining <= 15 ? "bg-danger" : "bg-pending",
          )}
          style={{ transform: `scaleX(${entry.closed ? 0 : fractionRemaining(remaining, parked.ttl_seconds)})` }}
        />
      </div>

      <dl className="divide-y divide-line border-b border-line px-4">
        {parked.details.map((row, index) => (
          <div key={`${index}-${row.label}`} className="grid gap-1 py-3 sm:grid-cols-[7.5rem_1fr] sm:gap-4">
            <dt className="legend sm:pt-1">{row.label}</dt>
            <dd className="min-w-0 text-[16px] leading-6 font-medium break-words whitespace-pre-wrap text-fg">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="space-y-3 px-4 py-3">
        <p className="text-[13px] leading-5 text-fg-muted">
          {entry.restored ? "Parked before this page opened" : "Parked"} at {formatClock(parked.created_at)}. Nothing
          runs until you confirm.
        </p>

        {entry.error ? (
          <p role="alert" className="flex gap-2 text-[14px] leading-5 font-medium break-words text-danger">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0">{entry.error}</span>
          </p>
        ) : (
          !open && (
            <p className="flex gap-2 text-[14px] leading-5 text-fg-muted">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0">This confirmation expired and nothing ran. Send the command again to retry.</span>
            </p>
          )
        )}

        <div className="flex flex-wrap gap-2">
          {open ? (
            <>
              <button
                type="button"
                onClick={onConfirm}
                disabled={acting}
                className={button(tier.tone === "danger" ? "danger" : "primary", "md", "min-w-28 flex-1 sm:flex-none")}
              >
                {confirming ? "Confirming…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={acting}
                className={button("secondary", "md", "min-w-28 flex-1 sm:flex-none")}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onRetry} disabled={retryDisabled} className={button("secondary")}>
                <RetryIcon className="h-4 w-4" />
                Send again
              </button>
              <button type="button" onClick={onDismiss} className={button("ghost")}>
                Dismiss
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
