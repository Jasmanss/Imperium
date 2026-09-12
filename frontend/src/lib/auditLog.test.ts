import { describe, expect, it } from "vitest";
import { auditPage, auditRow } from "@/test/fixtures";
import {
  appendPage,
  auditHref,
  EMPTY_AUDIT_LIST,
  firstPage,
  flagText,
  matchesSearch,
  mergeLatest,
  readAuditParams,
  searchRows,
} from "./auditLog";

function params(query: string) {
  return new URLSearchParams(query);
}

function ids(state: { entries: { id: number }[] }): number[] {
  return state.entries.map((row) => row.id);
}

describe("readAuditParams", () => {
  it("reads a well-formed query", () => {
    expect(readAuditParams(params("decision=failed&command_id=a1b2c3d4e5f6&id=137"))).toEqual({
      decision: "failed",
      commandId: "a1b2c3d4e5f6",
      id: 137,
    });
  });

  it("ignores anything malformed rather than querying the Mac with it", () => {
    expect(readAuditParams(params(""))).toEqual({ decision: null, commandId: null, id: null });
    expect(readAuditParams(params("decision=DROP+TABLE&command_id=../../etc&id=0"))).toEqual({
      decision: null,
      commandId: null,
      id: null,
    });
    // command_id is 12 lowercase hex characters, exactly.
    expect(readAuditParams(params("command_id=A1B2C3D4E5F6")).commandId).toBeNull();
    expect(readAuditParams(params("command_id=a1b2c3d4e5f")).commandId).toBeNull();
    expect(readAuditParams(params("command_id=a1b2c3d4e5f67")).commandId).toBeNull();
    for (const id of ["-1", "1.5", "01", "9e9", "999999999999999999"]) {
      expect(readAuditParams(params(`id=${id}`)).id).toBeNull();
    }
  });
});

describe("auditHref", () => {
  it("builds the screen's URL and drops empty filters", () => {
    expect(auditHref()).toBe("/audit/");
    expect(auditHref({ decision: null, commandId: null, id: null })).toBe("/audit/");
    expect(auditHref({ decision: "executed", id: 12 })).toBe("/audit/?decision=executed&id=12");
    expect(auditHref({ commandId: "a1b2c3d4e5f6" })).toBe("/audit/?command_id=a1b2c3d4e5f6");
  });
});

describe("paging", () => {
  it("keeps rows newest first, one per id", () => {
    const state = firstPage({ entries: [auditRow({ id: 8 }), auditRow({ id: 10 }), auditRow({ id: 8 })], next_before_id: 8 });
    expect(ids(state)).toEqual([10, 8]);
    expect(state.next).toBe(8);
  });

  it("appends an older page and takes its cursor", () => {
    const state = appendPage(firstPage(auditPage([10, 9], 9)), auditPage([8, 7], null));
    expect(ids(state)).toEqual([10, 9, 8, 7]);
    expect(state.next).toBeNull();
  });

  it("ignores rows the Mac sent without an id", () => {
    const page = { entries: [auditRow({ id: 4 }), { ts: 1 } as never], next_before_id: null };
    expect(ids(firstPage(page))).toEqual([4]);
  });
});

describe("mergeLatest", () => {
  it("merges a refreshed first page into what is already loaded", () => {
    const loaded = appendPage(firstPage(auditPage([10, 9], 9)), auditPage([8], null));
    const merged = mergeLatest(loaded, auditPage([12, 11, 10], 10));
    expect(ids(merged)).toEqual([12, 11, 10, 9, 8]);
    // The cursor stays where the loaded list left off, not where the fresh page did.
    expect(merged.next).toBeNull();
  });

  it("restarts rather than hide rows that were never fetched", () => {
    const loaded = firstPage(auditPage([10, 9], 9));
    // The fresh page reaches back only to 40: rows 39..11 were never loaded.
    const merged = mergeLatest(loaded, auditPage([42, 41, 40], 40));
    expect(ids(merged)).toEqual([42, 41, 40]);
    expect(merged.next).toBe(40);
  });

  it("restarts when there was nothing loaded, nothing fresh, or no older rows", () => {
    expect(ids(mergeLatest(EMPTY_AUDIT_LIST, auditPage([3], 3)))).toEqual([3]);
    expect(ids(mergeLatest(firstPage(auditPage([3], 3)), auditPage([], null)))).toEqual([]);
    expect(ids(mergeLatest(firstPage(auditPage([3], 3)), auditPage([9, 8], null)))).toEqual([9, 8]);
  });
});

describe("search", () => {
  it("requires every term, anywhere in the row", () => {
    const row = auditRow({ command: "text Mum saying running late", decision: "cancelled", error: null });
    expect(matchesSearch(row, "")).toBe(true);
    expect(matchesSearch(row, "mum late")).toBe(true);
    expect(matchesSearch(row, "Cancelled")).toBe(true);
    expect(matchesSearch(row, "#1")).toBe(true);
    expect(matchesSearch(row, "mum email")).toBe(false);
  });

  it("copies the rows through when the query is blank", () => {
    const rows = [auditRow({ id: 2 }), auditRow({ id: 1 })];
    const result = searchRows(rows, "   ");
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });
});

describe("flagText", () => {
  it("distinguishes 0 from an absent value", () => {
    expect(flagText(1)).toBe("Yes");
    expect(flagText(0)).toBe("No");
    expect(flagText(null)).toBeNull();
    expect(flagText(undefined)).toBeNull();
  });
});
