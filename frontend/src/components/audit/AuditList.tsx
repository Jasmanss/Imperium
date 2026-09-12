import Link from "next/link";
import { cx } from "@/lib/cx";
import { formatDateTime, formatDuration, formatTokens } from "@/lib/format";
import { categoryLabel, tierLabel } from "@/lib/labels";
import type { AuditRow } from "@/lib/types";
import { DecisionBadge } from "../Badge";
import { ChevronRightIcon } from "../icons";
import { TONE } from "../ui";

interface AuditListProps {
  rows: readonly AuditRow[];
  hrefFor: (id: number) => string;
  /** The entry open in the detail view. */
  selectedId: number | null;
  onOpen: () => void;
}

export function AuditList({ rows, hrefFor, selectedId, onOpen }: AuditListProps) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
      {rows.map((row) => (
        <AuditListItem key={row.id} row={row} href={hrefFor(row.id)} selected={row.id === selectedId} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function AuditListItem({
  row,
  href,
  selected,
  onOpen,
}: {
  row: AuditRow;
  href: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const tier = tierLabel(row.tier);
  const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
  return (
    <li>
      <Link
        href={href}
        scroll={false}
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "grid min-h-11 grid-cols-[5.25rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3 transition-colors duration-150 hover:bg-raised focus-visible:-outline-offset-2",
          selected && "bg-raised",
        )}
      >
        <span className="pt-0.5">
          <DecisionBadge decision={row.decision} />
        </span>
        <span className="min-w-0">
          <span
            className={cx(
              "line-clamp-2 text-[14px] leading-5 font-medium break-words",
              row.command ? "text-fg" : "text-fg-muted italic",
            )}
          >
            {row.command ?? "No command text"}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11.5px] leading-5 text-fg-muted tabular-nums">
            <span className="text-fg-faint">#{row.id}</span>
            <span>{formatDateTime(row.ts)}</span>
            <span aria-hidden="true">·</span>
            <span>{categoryLabel(row.category)}</span>
            {row.tier && <span className={TONE[tier.tone].text}>{tier.label.toLowerCase()}</span>}
            {row.duration_ms !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatDuration(row.duration_ms)}</span>
              </>
            )}
            {tokens > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatTokens(tokens)} tok</span>
              </>
            )}
          </span>
          {row.error && (
            <span className="mt-1 line-clamp-1 text-[12.5px] leading-5 break-all text-danger">{row.error}</span>
          )}
        </span>
        <ChevronRightIcon className="mt-0.5 h-4 w-4 text-fg-faint" />
      </Link>
    </li>
  );
}

/** Placeholder rows while the first page loads. */
export function AuditListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 px-4 py-3.5">
          <span className="h-5 w-16 animate-pulse rounded-[5px] bg-control" />
          <span className="space-y-2">
            <span className="block h-4 w-3/4 animate-pulse rounded bg-control" />
            <span className="block h-3 w-1/2 animate-pulse rounded bg-raised" />
          </span>
        </li>
      ))}
    </ul>
  );
}
