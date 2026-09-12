"use client";

import { useMemo, useState } from "react";
import type { LoggedEvent } from "@/lib/eventLog";
import { groupByCommand } from "@/lib/steps";
import { PauseIcon, PlayIcon } from "../icons";
import { EmptyState } from "../Notice";
import { PageBody, PageHeader } from "../PageHeader";
import { useCommandSession } from "../providers/CommandSessionProvider";
import { useEventLog, useStreamState } from "../providers/EventStreamProvider";
import { StreamNotice, StreamStatusPill } from "../StreamStatus";
import { button } from "../ui";
import { ActivityGroup } from "./ActivityGroup";

/** How many of the most recent commands start with their trace expanded. */
const OPEN_GROUPS = 4;

export function ActivityScreen() {
  const log = useEventLog();
  const { status } = useStreamState();
  const { clientIds } = useCommandSession();
  // While paused, the screen shows the log as it was when Pause was pressed.
  const [frozen, setFrozen] = useState<readonly LoggedEvent[] | null>(null);
  const paused = frozen !== null;
  const visible = frozen ?? log;
  const groups = useMemo(() => groupByCommand(visible), [visible]);

  const frozenSeq = frozen && frozen.length > 0 ? frozen[frozen.length - 1].seq : 0;
  const waiting = paused ? log.filter((item) => item.seq > frozenSeq).length : 0;

  return (
    <PageBody>
      <PageHeader
        title="Activity"
        description="Live events from every paired device since this page opened. Older commands are in the audit log."
        actions={
          <>
            <StreamStatusPill className="mr-2" />
            <button
              type="button"
              aria-pressed={paused}
              onClick={() => setFrozen(paused ? null : log)}
              className={button("secondary", "sm")}
            >
              {paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
              {paused ? "Resume" : "Pause"}
            </button>
          </>
        }
      />

      <StreamNotice className="mt-6" />

      {paused && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-pending/35 bg-pending/5 px-4 py-3">
          <p role="status" className="text-[14px] leading-5 text-pending">
            Paused.{" "}
            {waiting === 0 ? "No new events yet." : waiting === 1 ? "1 new event waiting." : `${waiting} new events waiting.`}
          </p>
          <button type="button" onClick={() => setFrozen(null)} className={button("secondary", "sm")}>
            <PlayIcon className="h-4 w-4" />
            Resume
          </button>
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyState title="No activity yet" className="mt-8">
          {status === "live"
            ? "Commands sent from any paired device appear here step by step while they run."
            : "Events appear here once the connection to the Mac is live."}
        </EmptyState>
      ) : (
        <ol aria-label="Commands, most recent first" className="mt-6 space-y-3">
          {groups.map((group, index) => (
            <ActivityGroup
              key={group.commandId}
              group={group}
              fromThisDevice={group.clientId !== null && clientIds.has(group.clientId)}
              defaultOpen={index < OPEN_GROUPS}
            />
          ))}
        </ol>
      )}
    </PageBody>
  );
}
