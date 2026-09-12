import Link from "next/link";
import { auditHref } from "@/lib/auditLog";
import { cx } from "@/lib/cx";
import type { LoggedEvent } from "@/lib/eventLog";
import { formatDuration, formatTokens } from "@/lib/format";
import { repairLabel, type ResultView } from "@/lib/results";
import { traceSteps } from "@/lib/steps";
import { ToneBadge } from "../Badge";
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CrossIcon,
  EditIcon,
  LedgerIcon,
  RetryIcon,
  ShieldIcon,
  WrenchIcon,
} from "../icons";
import { ProgressTrace } from "../ProgressTrace";
import { button, TONE } from "../ui";

interface ResultCardProps {
  view: ResultView;
  events: readonly LoggedEvent[];
  /** Context above the result, such as where the command was confirmed. */
  note?: string | null;
  onEdit: () => void;
  onRetry: () => void;
  retryDisabled: boolean;
}

export function ResultCard({ view, events, note = null, onEdit, onRetry, retryDisabled }: ResultCardProps) {
  const steps = traceSteps(events);
  const repair = repairLabel(view.metrics);
  const StatusIcon = view.ok ? CheckIcon : view.blocked ? ShieldIcon : CrossIcon;

  return (
    <article className={cx("rounded-xl border bg-panel", TONE[view.tone].border)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5">
        <p className={cx("flex items-center gap-2 text-[14px] leading-5 font-semibold", TONE[view.tone].text)}>
          <StatusIcon className="h-[18px] w-[18px]" />
          {view.title}
        </p>
        {repair && (
          <ToneBadge tone={repair.tone}>
            <WrenchIcon className="h-3 w-3" />
            {repair.label}
          </ToneBadge>
        )}
        <dl className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] leading-5 text-fg-muted tabular-nums">
          <div className="flex gap-1">
            <dt className="sr-only">Duration</dt>
            <dd>{formatDuration(view.durationMs)}</dd>
          </div>
          {view.metrics && (
            <div className="flex gap-1">
              <dt className="sr-only">Tokens</dt>
              <dd>
                {formatTokens(view.metrics.input_tokens)} in · {formatTokens(view.metrics.output_tokens)} out
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className="space-y-3 px-4 pt-2 pb-3">
        {note && <p className="text-[13px] leading-5 text-fg-muted">{note}</p>}
        {view.action && (
          <p className="text-[15px] leading-6 break-words whitespace-pre-wrap text-fg">{view.action}</p>
        )}
        {view.error && (
          <p className="flex gap-2 text-[14px] leading-5 text-danger">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words whitespace-pre-wrap">{view.error}</span>
          </p>
        )}
        {view.output && (
          <pre
            aria-label="Output"
            className="max-h-48 overflow-auto rounded-lg border border-line bg-raised px-3 py-2 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap text-fg-muted"
          >
            {view.output}
          </pre>
        )}
        {steps.length > 0 && (
          <details className="group">
            <summary className="inline-flex min-h-11 list-none items-center gap-1.5 rounded-md text-[13px] text-fg-muted hover:text-fg pointer-fine:min-h-8 [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon className="h-4 w-4 transition-transform duration-150 group-open:rotate-90" />
              Steps ({steps.length})
            </summary>
            <div className="pt-2 pb-1">
              <ProgressTrace steps={steps} running={false} label="Steps" originTs={steps[0].ts} />
            </div>
          </details>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1.5">
        <Link href={auditHref({ commandId: view.commandId })} className={button("ghost", "sm")}>
          <LedgerIcon className="h-4 w-4" />
          Audit entries
        </Link>
        <span className="flex-1" />
        <button type="button" onClick={onEdit} className={button("ghost", "sm")}>
          <EditIcon className="h-4 w-4" />
          Edit
        </button>
        <button type="button" onClick={onRetry} disabled={retryDisabled} className={button("ghost", "sm")}>
          <RetryIcon className="h-4 w-4" />
          Retry
        </button>
      </div>
    </article>
  );
}
