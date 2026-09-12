import { cx } from "@/lib/cx";
import { formatOffset } from "@/lib/format";
import type { TraceStep } from "@/lib/steps";
import { TONE } from "./ui";

interface ProgressTraceProps {
  steps: readonly TraceStep[];
  /** Show a live "working" row after the last step. */
  running: boolean;
  label: string;
  /** Server timestamp to show offsets from, such as the first event's ts. */
  originTs?: number | null;
}

/** A command's steps on a rail, coloured by what each step means. */
export function ProgressTrace({ steps, running, label, originTs = null }: ProgressTraceProps) {
  return (
    <ol aria-label={label} className="trace">
      {steps.map((step) => (
        <li key={step.key} className="trace-step animate-rise">
          <span aria-hidden="true" className={cx("trace-dot", TONE[step.tone].dot)} />
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <span className={cx("text-[13px] leading-5 font-medium", step.tone === "neutral" ? "text-fg" : TONE[step.tone].text)}>
              {step.title}
            </span>
            {step.detail && (
              <span className="min-w-0 font-mono text-[12px] leading-5 break-words text-fg-muted">{step.detail}</span>
            )}
            {originTs !== null && (
              <span className="ml-auto font-mono text-[11px] leading-5 text-fg-faint tabular-nums">
                {formatOffset(originTs, step.ts)}
              </span>
            )}
          </div>
          {step.note && <p className="mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-fg-muted">{step.note}</p>}
          {step.code && (
            <pre className="mt-1.5 max-h-44 overflow-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-fg-muted">
              {step.code}
            </pre>
          )}
        </li>
      ))}
      {running && (
        <li className="trace-step">
          <span aria-hidden="true" className="trace-dot animate-breathe bg-pending" />
          <span className="text-[13px] leading-5 text-fg-muted">
            {steps.length === 0 ? "Sending to the Mac…" : "Working…"}
          </span>
        </li>
      )}
    </ol>
  );
}
