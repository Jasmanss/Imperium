import { describe, expect, it } from "vitest";
import type { StreamStatus } from "@/lib/events";
import { STREAM_STATUS, streamDescription } from "./StreamStatus";

const STATUSES: StreamStatus[] = ["idle", "connecting", "live", "reconnecting", "offline", "busy", "unauthorized"];

describe("STREAM_STATUS", () => {
  it("has a label and a description for every status the client can report", () => {
    for (const status of STATUSES) {
      expect(STREAM_STATUS[status].label).toBeTruthy();
      expect(STREAM_STATUS[status].description).toBeTruthy();
    }
  });
});

describe("streamDescription", () => {
  it("prefers the Mac's own explanation over the generic copy", () => {
    const message = "Too many open event streams — close the app on another device or tab and retry.";
    expect(streamDescription({ status: "busy", rejection: message })).toBe(message);
  });

  it("never tells the user the Mac is unreachable when it answered", () => {
    expect(streamDescription({ status: "busy", rejection: null })).not.toContain("Can’t reach the Mac");
    expect(streamDescription({ status: "offline", rejection: null })).toBe(STREAM_STATUS.offline.description);
  });
});
