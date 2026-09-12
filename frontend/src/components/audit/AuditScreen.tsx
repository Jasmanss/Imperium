"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import { describeError, isAbortError } from "@/lib/api";
import {
  appendPage,
  AUDIT_PAGE_SIZE,
  auditHref,
  EMPTY_AUDIT_LIST,
  firstPage,
  mergeLatest,
  readAuditParams,
  searchRows,
  type AuditListState,
} from "@/lib/auditLog";
import { cx } from "@/lib/cx";
import { DECISION_FILTERS } from "@/lib/labels";
import type { AuditPage, AuditRow, Decision } from "@/lib/types";
import { CrossIcon, SearchIcon } from "../icons";
import { EmptyState, ErrorNotice } from "../Notice";
import { PageBody, PageHeader } from "../PageHeader";
import { useAuth } from "../providers/AuthProvider";
import { useStreamSignal } from "../providers/EventStreamProvider";
import { button, chip, INPUT } from "../ui";
import { AuditDetail } from "./AuditDetail";
import { AuditList, AuditListSkeleton } from "./AuditList";

/** Events after which the newest audit rows may have changed. */
const REFRESH_EVENTS = ["finished", "pending", "confirmed", "cancelled"];

const NO_ROWS: readonly AuditRow[] = [];

interface ListState {
  /** The filter the loaded entries belong to. */
  key: string | null;
  data: AuditListState;
  /** The first-page request (filter and retry count) that last settled. */
  settled: string | null;
  error: string | null;
  loadingMore: boolean;
  moreError: string | null;
}

type ListAction =
  | { type: "loaded"; request: string; key: string; page: AuditPage }
  | { type: "failed"; request: string; message: string }
  | { type: "loadingMore" }
  | { type: "appended"; key: string; page: AuditPage }
  | { type: "moreFailed"; key: string; message: string }
  | { type: "refreshed"; key: string; page: AuditPage };

const INITIAL_LIST: ListState = {
  key: null,
  data: EMPTY_AUDIT_LIST,
  settled: null,
  error: null,
  loadingMore: false,
  moreError: null,
};

function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "loaded":
      return { ...INITIAL_LIST, key: action.key, data: firstPage(action.page), settled: action.request };
    case "failed":
      return { ...state, settled: action.request, error: action.message };
    case "loadingMore":
      return { ...state, loadingMore: true, moreError: null };
    case "appended":
      if (action.key !== state.key) return { ...state, loadingMore: false };
      return { ...state, data: appendPage(state.data, action.page), loadingMore: false };
    case "moreFailed":
      return { ...state, loadingMore: false, moreError: action.key === state.key ? action.message : null };
    case "refreshed":
      return action.key === state.key ? { ...state, data: mergeLatest(state.data, action.page) } : state;
  }
}

export function AuditScreen() {
  return (
    <PageBody>
      <PageHeader
        title="Audit"
        description="Every decision the Mac recorded: what ran, what failed, what the policy blocked, and what waited for confirmation."
      />
      <Suspense
        fallback={
          <div className="mt-6">
            <AuditListSkeleton />
          </div>
        }
      >
        <AuditView />
      </Suspense>
    </PageBody>
  );
}

function AuditView() {
  const { api } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { decision, commandId, id } = readAuditParams(searchParams);
  const filterKey = `${decision ?? ""}|${commandId ?? ""}`;
  const [retries, setRetries] = useState(0);
  const request = `${filterKey}#${retries}`;
  const [list, dispatch] = useReducer(listReducer, INITIAL_LIST);
  const [query, setQuery] = useState("");
  // The detail view was opened by tapping a row, so closing it can go back in history.
  const openedFromList = useRef(false);
  const activity = useStreamSignal(REFRESH_EVENTS, 1200);

  useEffect(() => {
    const controller = new AbortController();
    api
      .audit(
        { limit: AUDIT_PAGE_SIZE, decision: decision ?? undefined, command_id: commandId ?? undefined },
        { signal: controller.signal },
      )
      .then(
        (page) => {
          if (!controller.signal.aborted) dispatch({ type: "loaded", request, key: filterKey, page });
        },
        (error: unknown) => {
          if (controller.signal.aborted || isAbortError(error)) return;
          dispatch({ type: "failed", request, message: describeError(error) });
        },
      );
    return () => controller.abort();
  }, [api, decision, commandId, filterKey, request]);

  const refreshLatest = useEffectEvent((signal: AbortSignal) => {
    const key = filterKey;
    api
      .audit({ limit: AUDIT_PAGE_SIZE, decision: decision ?? undefined, command_id: commandId ?? undefined }, { signal })
      .then(
        (page) => {
          if (!signal.aborted) dispatch({ type: "refreshed", key, page });
        },
        () => undefined,
      );
  });

  useEffect(() => {
    if (activity === 0) return;
    const controller = new AbortController();
    refreshLatest(controller.signal);
    return () => controller.abort();
  }, [activity]);

  useEffect(() => {
    if (id === null) openedFromList.current = false;
  }, [id]);

  const current = list.key === filterKey;
  const loading = list.settled !== request;
  const error = list.settled === request ? list.error : null;
  const entries = current ? list.data.entries : NO_ROWS;
  const shown = useMemo(() => searchRows(entries, query), [entries, query]);
  const selected = id === null ? null : (entries.find((row) => row.id === id) ?? null);
  const searching = query.trim() !== "";

  function setFilters(next: { decision?: Decision | null; commandId?: string | null }) {
    const href = auditHref({
      decision: next.decision === undefined ? decision : next.decision,
      commandId: next.commandId === undefined ? commandId : next.commandId,
    });
    router.replace(href, { scroll: false });
  }

  async function loadMore() {
    const before = list.data.next;
    if (before === null || list.loadingMore || !current) return;
    const key = filterKey;
    dispatch({ type: "loadingMore" });
    try {
      const page = await api.audit({
        limit: AUDIT_PAGE_SIZE,
        before_id: before,
        decision: decision ?? undefined,
        command_id: commandId ?? undefined,
      });
      dispatch({ type: "appended", key, page });
    } catch (loadError) {
      dispatch({ type: "moreFailed", key, message: describeError(loadError) });
    }
  }

  function closeDetail() {
    if (openedFromList.current) {
      openedFromList.current = false;
      router.back();
    } else {
      router.replace(auditHref({ decision, commandId }), { scroll: false });
    }
  }

  let body;
  if (error) {
    body = <ErrorNotice message={error} onRetry={() => setRetries((count) => count + 1)} />;
  } else if (!current) {
    body = <AuditListSkeleton />;
  } else if (entries.length === 0) {
    body = (
      <EmptyState title={decision || commandId ? "No matching entries" : "The audit log is empty"}>
        {decision || commandId
          ? "Nothing recorded matches this filter yet."
          : "Every command the Mac receives is recorded here, including the ones it refuses."}
      </EmptyState>
    );
  } else {
    body = (
      <>
        <div className="mb-2 flex items-center justify-between gap-4">
          <p aria-live="polite" className="legend tabular-nums">
            {searching ? `${shown.length} of ${entries.length} loaded` : `${entries.length} loaded`}
          </p>
          {loading && <p className="legend">Refreshing…</p>}
        </div>
        {shown.length === 0 ? (
          <EmptyState title="Nothing matches">
            No loaded entry contains “{query.trim()}”.
            {list.data.next !== null && " Load more to search older entries."}
          </EmptyState>
        ) : (
          <AuditList
            rows={shown}
            hrefFor={(rowId) => auditHref({ decision, commandId, id: rowId })}
            selectedId={id}
            onOpen={() => {
              openedFromList.current = true;
            }}
          />
        )}
        <div className="mt-4 flex flex-col items-center gap-3">
          {list.moreError && <ErrorNotice message={list.moreError} className="w-full" />}
          {list.data.next !== null ? (
            <button type="button" onClick={loadMore} disabled={list.loadingMore} className={button("secondary")}>
              {list.loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : (
            <p className="legend py-2">End of the log</p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mt-6 space-y-4">
        <div
          role="group"
          aria-label="Filter by decision"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden"
        >
          {DECISION_FILTERS.map((filter) => {
            const active = filter.value === decision;
            return (
              <button
                key={filter.label}
                type="button"
                aria-pressed={active}
                onClick={() => setFilters({ decision: filter.value })}
                className={chip(active, "shrink-0")}
              >
                {filter.label}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-faint" />
          <label htmlFor="audit-search" className="sr-only">
            Search loaded entries
          </label>
          <input
            id="audit-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search loaded entries"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className={cx(INPUT, "pl-9")}
          />
        </div>

        {commandId && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-act/35 bg-act/5 py-1.5 pr-1.5 pl-4">
            <p className="min-w-0 text-[14px] leading-5 text-fg">
              Entries for command <code className="font-mono text-[13px] text-act">{commandId}</code>
            </p>
            <button type="button" onClick={() => setFilters({ commandId: null })} className={button("ghost", "sm")}>
              <CrossIcon className="h-4 w-4" />
              Show all
            </button>
          </div>
        )}
      </div>

      <div className="mt-5">{body}</div>

      {id !== null && (
        <AuditDetail
          id={id}
          row={selected}
          hrefFor={(rowId) => auditHref({ decision, commandId, id: rowId })}
          commandHref={(rowCommandId) => auditHref({ commandId: rowCommandId })}
          onClose={closeDetail}
        />
      )}
    </>
  );
}
