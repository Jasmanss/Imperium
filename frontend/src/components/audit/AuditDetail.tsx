"use client";

import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { useResource } from "@/hooks/useResource";
import { describeError } from "@/lib/api";
import { auditFields } from "@/lib/auditLog";
import { cx } from "@/lib/cx";
import { EMPTY_VALUE, formatClock, formatDateTime } from "@/lib/format";
import { categoryLabel } from "@/lib/labels";
import type { AuditRow } from "@/lib/types";
import { DecisionBadge, TierBadge } from "../Badge";
import { CopyButton } from "../CopyButton";
import { AlertIcon, CrossIcon, LedgerIcon } from "../icons";
import { ErrorNotice } from "../Notice";
import { useAuth } from "../providers/AuthProvider";
import { button } from "../ui";

interface AuditDetailProps {
  id: number;
  /** The row, when the list has it loaded; otherwise it is fetched. */
  row: AuditRow | null;
  hrefFor: (id: number) => string;
  commandHref: (commandId: string) => string;
  onClose: () => void;
}

/** One audit entry in a modal sheet: every field, the exact script, and the command's other entries. */
export function AuditDetail({ id, row, hrefFor, commandHref, onClose }: AuditDetailProps) {
  const { api } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // The API has no single-row route: the newest row with id < id + 1 is this one, if it exists.
  const lookupKey = row ? null : `row:${id}`;
  const lookup = useResource(lookupKey, (signal) => api.audit({ limit: 1, before_id: id + 1 }, { signal }));
  const looked = lookupKey !== null && lookup.dataKey === lookupKey;
  const entry = row ?? (looked ? (lookup.data?.entries.find((item) => item.id === id) ?? null) : null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    closeRef.current?.focus();
    return () => {
      if (!dialog.open) return;
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [id]);

  let content;
  if (entry) {
    content = <EntryDetail entry={entry} hrefFor={hrefFor} commandHref={commandHref} />;
  } else if (lookup.error) {
    content = <ErrorNotice message={describeError(lookup.error)} />;
  } else if (looked && !lookup.loading) {
    content = <p className="text-[15px] leading-6 text-fg-muted">There is no audit entry #{id}.</p>;
  } else {
    content = <p className="legend">Loading…</p>;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 m-0 mt-auto h-[92dvh] max-h-none w-full max-w-none overflow-hidden rounded-t-2xl border border-line-strong bg-panel p-0 text-fg shadow-2xl sm:mt-0 sm:ml-auto sm:h-dvh sm:max-w-xl sm:rounded-none sm:border-y-0 sm:border-r-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-3 border-b border-line py-2 pr-2 pl-4 sm:pl-5">
          <div className="min-w-0 flex-1">
            <p className="legend">Audit entry</p>
            <h2 id={titleId} className="font-mono text-[15px] leading-6 font-semibold text-fg tabular-nums">
              #{id}
            </h2>
          </div>
          {entry && <DecisionBadge decision={entry.decision} />}
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className={button("ghost", "md", "w-11 px-0")}>
            <CrossIcon className="h-5 w-5" />
          </button>
        </div>
        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-5"
        >
          {content}
        </div>
      </div>
    </dialog>
  );
}

function EntryDetail({
  entry,
  hrefFor,
  commandHref,
}: {
  entry: AuditRow;
  hrefFor: (id: number) => string;
  commandHref: (commandId: string) => string;
}) {
  const { api } = useAuth();
  const scriptId = useId();
  const fieldsId = useId();
  const relatedId = useId();
  const commandId = entry.command_id;
  const relatedKey = commandId ? `command:${commandId}` : null;
  const related = useResource(relatedKey, (signal) =>
    api.audit({ command_id: commandId ?? undefined, limit: 50 }, { signal }),
  );
  const relatedRows =
    relatedKey !== null && related.dataKey === relatedKey && related.data
      ? [...related.data.entries].sort((a, b) => a.id - b.id)
      : [];

  return (
    <div className="space-y-7">
      <section>
        <p
          className={cx(
            "text-[17px] leading-7 font-medium break-words whitespace-pre-wrap",
            entry.command ? "text-fg" : "text-fg-muted italic",
          )}
        >
          {entry.command ?? "No command text"}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <TierBadge tier={entry.tier} />
          <span className="font-mono text-[12px] text-fg-muted">{categoryLabel(entry.category)}</span>
          <span className="font-mono text-[12px] text-fg-muted tabular-nums">{formatDateTime(entry.ts)}</span>
        </div>
        {entry.action && (
          <p className="mt-3 text-[14px] leading-6 break-words whitespace-pre-wrap text-fg-muted">{entry.action}</p>
        )}
        {entry.error && (
          <p className="mt-3 flex gap-2 rounded-lg border border-danger/35 bg-danger/5 px-3 py-2.5 text-[14px] leading-5 text-danger">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words whitespace-pre-wrap">{entry.error}</span>
          </p>
        )}
      </section>

      <section aria-labelledby={scriptId}>
        <div className="flex min-h-11 items-center justify-between gap-3 pointer-fine:min-h-8">
          <h3 id={scriptId} className="legend">
            Script
          </h3>
          {entry.script !== null && <CopyButton text={entry.script} label="Copy script" />}
        </div>
        {entry.script !== null ? (
          <pre
            tabIndex={0}
            aria-labelledby={scriptId}
            className="mt-2 max-h-[45dvh] overflow-auto rounded-lg border border-line bg-ground px-3 py-2.5 font-mono text-[12.5px] leading-5 whitespace-pre text-fg"
          >
            {entry.script}
          </pre>
        ) : (
          <p className="mt-1 text-[14px] leading-6 text-fg-muted">No script was generated for this entry.</p>
        )}
      </section>

      <section aria-labelledby={fieldsId}>
        <h3 id={fieldsId} className="legend">
          Fields
        </h3>
        <dl className="mt-2 divide-y divide-line rounded-lg border border-line">
          {auditFields(entry).map((field) => (
            <div key={field.key} className="grid grid-cols-[minmax(6.5rem,36%)_minmax(0,1fr)] gap-3 px-3 py-2">
              <dt className="font-mono text-[12px] leading-5 text-fg-faint">{field.key}</dt>
              <dd
                className={cx(
                  "min-w-0 text-[13px] leading-5 break-words whitespace-pre-wrap",
                  field.value === null ? "text-fg-faint" : "text-fg",
                  field.mono && "font-mono text-[12.5px]",
                )}
              >
                {field.value ?? EMPTY_VALUE}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {commandId && (
        <section aria-labelledby={relatedId}>
          <div className="flex min-h-11 items-center justify-between gap-3">
            <h3 id={relatedId} className="legend">
              Same command
            </h3>
            <Link href={commandHref(commandId)} className={button("ghost", "sm")}>
              <LedgerIcon className="h-4 w-4" />
              Show in list
            </Link>
          </div>
          {related.error ? (
            <ErrorNotice message={describeError(related.error)} className="mt-2" />
          ) : relatedRows.length === 0 ? (
            <p className="legend mt-2">Loading…</p>
          ) : (
            <ol className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line">
              {relatedRows.map((item) => {
                const inner = (
                  <>
                    <DecisionBadge decision={item.decision} />
                    <span className="font-mono text-[12px] text-fg-muted tabular-nums">{formatClock(item.ts)}</span>
                    <span className="ml-auto font-mono text-[12px] text-fg-faint tabular-nums">#{item.id}</span>
                  </>
                );
                return (
                  <li key={item.id}>
                    {item.id === entry.id ? (
                      <div aria-current="true" className="flex min-h-11 items-center gap-3 bg-raised px-3">
                        {inner}
                        <span className="sr-only">(this entry)</span>
                      </div>
                    ) : (
                      <Link
                        href={hrefFor(item.id)}
                        replace
                        scroll={false}
                        className="flex min-h-11 items-center gap-3 px-3 transition-colors duration-150 hover:bg-raised focus-visible:-outline-offset-2"
                      >
                        {inner}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
