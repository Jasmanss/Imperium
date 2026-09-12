"use client";

import { useNow } from "@/hooks/useNow";
import { cx } from "@/lib/cx";
import type { StreamStatus } from "@/lib/events";
import type { Tone } from "@/lib/labels";
import { useEventStream, useStreamState } from "./providers/EventStreamProvider";
import { button, TONE } from "./ui";

export const STREAM_STATUS: Record<StreamStatus, { label: string; tone: Tone; description: string }> = {
  idle: { label: "Idle", tone: "muted", description: "Not connected to the event stream." },
  connecting: { label: "Connecting", tone: "pending", description: "Connecting to the Mac’s event stream." },
  live: { label: "Live", tone: "ok", description: "Receiving events from the Mac as they happen." },
  reconnecting: { label: "Reconnecting", tone: "pending", description: "The connection to the Mac dropped." },
  offline: { label: "Offline", tone: "danger", description: "Can’t reach the Mac. Still retrying." },
  unauthorized: { label: "Not paired", tone: "danger", description: "The Mac rejected this device’s pairing." },
};

export function StreamStatusPill({ className }: { className?: string }) {
  const { status } = useStreamState();
  const view = STREAM_STATUS[status];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 font-mono text-[11px] leading-none tracking-[0.08em] uppercase",
        TONE[view.tone].text,
        className,
      )}
    >
      <span aria-hidden="true" className="relative flex h-2 w-2">
        {status === "live" && (
          <span className={cx("absolute inset-0 animate-ping-slow rounded-full opacity-60", TONE.ok.dot)} />
        )}
        <span className={cx("relative h-2 w-2 rounded-full", TONE[view.tone].dot)} />
      </span>
      <span>
        <span className="sr-only">Event stream: </span>
        {view.label}
      </span>
    </span>
  );
}

/** A banner for screens that depend on the stream, shown while it is down. */
export function StreamNotice({ className }: { className?: string }) {
  const { client } = useEventStream();
  const state = useStreamState();
  const waiting = state.retryAt !== null;
  const now = useNow(0, 1000, waiting);
  if (state.status !== "reconnecting" && state.status !== "offline") return null;

  const view = STREAM_STATUS[state.status];
  const seconds = waiting && now > 0 && state.retryAt !== null ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : null;
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border px-4 py-3",
        TONE[view.tone].border,
        TONE[view.tone].wash,
        className,
      )}
    >
      <p className={cx("text-[14px] leading-5", TONE[view.tone].text)}>
        {view.description}
        {seconds !== null && ` Next attempt in ${seconds} s.`}
      </p>
      <button type="button" onClick={() => client.reconnect()} className={button("secondary", "sm")}>
        Reconnect now
      </button>
    </div>
  );
}
