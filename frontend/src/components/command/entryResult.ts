import type { LoggedEvent } from "@/lib/eventLog";
import { resultFromFinished, resultFromResponse, type ResultView } from "@/lib/results";
import { findFinished } from "@/lib/steps";
import type { FeedEntry } from "../providers/CommandSessionProvider";

/** The result card for a feed entry, or null while it has no result to show. */
export function entryResult(entry: FeedEntry, events: readonly LoggedEvent[]): ResultView | null {
  if (entry.phase === "done" && entry.result) {
    return resultFromResponse(entry.result, events, entry.metrics);
  }
  if (entry.phase === "resolved" && entry.resolvedAs === "confirmed") {
    const finished = findFinished(events);
    return finished ? resultFromFinished(finished, events) : null;
  }
  return null;
}
