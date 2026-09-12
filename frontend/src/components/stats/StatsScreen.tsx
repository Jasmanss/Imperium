"use client";

import { useState } from "react";
import { useResource } from "@/hooks/useResource";
import { describeError } from "@/lib/api";
import { cx } from "@/lib/cx";
import { formatCount, formatDuration, formatPercent, formatTokens, hasActivity, normalizeStats } from "@/lib/format";
import { categoryRows, rateTone, statGroups, type CategoryRow, type StatGroup } from "@/lib/statsView";
import { RetryIcon } from "../icons";
import { EmptyState, ErrorNotice } from "../Notice";
import { PageBody, PageHeader } from "../PageHeader";
import { useAuth } from "../providers/AuthProvider";
import { useStreamSignal } from "../providers/EventStreamProvider";
import { button, TONE } from "../ui";

/** Events after which the aggregates may have changed. */
const REFRESH_EVENTS = ["finished", "pending", "confirmed", "cancelled"];

export function StatsScreen() {
  const { api } = useAuth();
  const activity = useStreamSignal(REFRESH_EVENTS, 2000);
  const [refreshes, setRefreshes] = useState(0);
  const stats = useResource(`stats:${activity}:${refreshes}`, (signal) =>
    api.stats({ signal }).then((raw) => normalizeStats(raw)),
  );
  const data = stats.data;

  return (
    <PageBody wide>
      <PageHeader
        title="Stats"
        description="How commands on this Mac have gone, aggregated from the audit log."
        actions={
          <button
            type="button"
            onClick={() => setRefreshes((count) => count + 1)}
            disabled={stats.loading}
            className={button("secondary", "sm")}
          >
            <RetryIcon className="h-4 w-4" />
            {stats.loading && data ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {stats.error !== null && (
        <ErrorNotice
          className="mt-6"
          message={describeError(stats.error)}
          onRetry={() => setRefreshes((count) => count + 1)}
        />
      )}

      {data ? (
        <>
          {!hasActivity(data) && (
            <EmptyState className="mt-6" title="No commands yet">
              Send a command from the Command screen and its numbers show up here.
            </EmptyState>
          )}
          <div className="mt-8 grid gap-8 lg:grid-cols-2">
            {statGroups(data).map((group) => (
              <TileGroup key={group.key} group={group} />
            ))}
          </div>
          <CategoryTable rows={categoryRows(data)} />
        </>
      ) : (
        stats.error === null && <StatsSkeleton />
      )}
    </PageBody>
  );
}

function TileGroup({ group }: { group: StatGroup }) {
  const wide = group.tiles.length > 2;
  const headingId = `stats-${group.key}`;
  return (
    <section aria-labelledby={headingId} className={cx(wide && "lg:col-span-2")}>
      <h2 id={headingId} className="legend">
        {group.title}
      </h2>
      <dl
        className={cx(
          "mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line",
          wide && "sm:grid-cols-4",
        )}
      >
        {group.tiles.map((tile) => (
          <div key={tile.key} className="flex min-w-0 flex-col bg-panel px-4 py-4 sm:px-5">
            <dt className="flex items-center gap-2 text-[12.5px] leading-5 text-fg-muted">
              {tile.tone && <span aria-hidden="true" className={cx("h-1.5 w-1.5 shrink-0 rounded-full", TONE[tile.tone].dot)} />}
              {tile.label}
            </dt>
            <dd className="mt-1.5 min-w-0">
              <span
                className={cx(
                  "block truncate font-mono text-[26px] leading-8 font-medium tracking-[-0.03em] tabular-nums sm:text-[30px] sm:leading-9",
                  tile.valueTone ? TONE[tile.valueTone].text : "text-fg",
                )}
              >
                {tile.value}
              </span>
              {tile.detail && <span className="mt-1 block text-[12px] leading-4 text-fg-faint">{tile.detail}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CategoryTable({ rows }: { rows: CategoryRow[] }) {
  return (
    <section aria-labelledby="stats-categories" className="mt-10">
      <h2 id="stats-categories" className="legend">
        By category
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-[14px] leading-6 text-fg-muted">No commands have run yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[42rem] border-collapse text-left">
            <caption className="sr-only">Commands, success rate, p95 latency, and tokens for each category</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="legend px-4 py-2.5 text-left">
                  Category
                </th>
                <th scope="col" className="legend px-4 py-2.5 text-right">
                  Commands
                </th>
                <th scope="col" className="legend w-[34%] px-4 py-2.5 text-left">
                  Success
                </th>
                <th scope="col" className="legend px-4 py-2.5 text-right">
                  p95
                </th>
                <th scope="col" className="legend px-4 py-2.5 text-right">
                  Tokens in / out
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.category} className="transition-colors duration-150 hover:bg-raised/60">
                  <th scope="row" className="px-4 py-3 text-left text-[14px] leading-5 font-medium text-fg">
                    {row.label}
                  </th>
                  <td className="px-4 py-3 text-right font-mono text-[13px] text-fg tabular-nums">{formatCount(row.n)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div aria-hidden="true" className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-control">
                        <div
                          className={cx("h-full rounded-full", TONE[rateTone(row.rate)].dot)}
                          style={{ width: `${Math.round((row.rate ?? 0) * 1000) / 10}%` }}
                        />
                      </div>
                      <span className="w-28 shrink-0 text-right font-mono text-[12.5px] text-fg tabular-nums">
                        {formatPercent(row.rate)}{" "}
                        <span className="text-fg-faint">
                          {formatCount(row.okN)}/{formatCount(row.n)}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[13px] text-fg-muted tabular-nums">
                    {formatDuration(row.p95LatencyMs)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[13px] text-fg-muted tabular-nums">
                    {formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatsSkeleton() {
  return (
    <div aria-hidden="true" className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="bg-panel px-5 py-4">
          <span className="block h-3 w-20 animate-pulse rounded bg-raised" />
          <span className="mt-3 block h-7 w-24 animate-pulse rounded bg-control" />
        </div>
      ))}
    </div>
  );
}
