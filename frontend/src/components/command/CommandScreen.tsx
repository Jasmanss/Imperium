"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { announcement } from "@/lib/results";
import { eventsForCommand } from "@/lib/steps";
import { TierBadge } from "../Badge";
import { useCommandSession } from "../providers/CommandSessionProvider";
import { useEventLog } from "../providers/EventStreamProvider";
import { StreamNotice } from "../StreamStatus";
import { chip } from "../ui";
import { CommandBar } from "./CommandBar";
import { entryResult } from "./entryResult";
import { FeedItem } from "./FeedItem";

export const EXAMPLE_COMMANDS: readonly string[] = [
  "play lofi beats on Spotify",
  "open Notes",
  "git status in imperium",
  "text 555-0100 saying on my way",
];

export function CommandScreen() {
  const { entries, busy, send } = useCommandSession();
  const log = useEventLog();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The input had focus when a command was sent; give it back when the command finishes.
  const refocus = useRef(false);

  const items = useMemo(
    () =>
      entries.map((entry) => {
        const events = eventsForCommand(log, entry.clientId, entry.commandId);
        return { entry, events, view: entryResult(entry, events) };
      }),
    [entries, log],
  );

  const last = items.length > 0 ? items[items.length - 1] : null;
  const message = last ? announcement(last.entry, last.view) : "";
  const scrollKey = last ? `${items.length}:${last.entry.key}:${last.entry.phase}:${last.view ? "result" : ""}` : "";

  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    inputRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    if (!scrollKey) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [scrollKey]);

  function submit(command: string) {
    const text = command.trim();
    if (!text || busy) return;
    refocus.current = document.activeElement === inputRef.current;
    send(text);
    setDraft("");
  }

  function edit(command: string) {
    setDraft(command);
    inputRef.current?.focus();
  }

  return (
    <>
      <div className="mx-auto w-full max-w-3xl px-page pt-6 pb-command sm:px-6 lg:px-10 lg:pt-10">
        <h1 className="sr-only">Command</h1>
        <StreamNotice className="mb-6" />

        {items.length === 0 ? (
          <EmptyCommandState onPick={edit} />
        ) : (
          <>
            <div className="mb-6 flex items-baseline justify-between gap-4 border-b border-line pb-3">
              <h2 className="legend">This session</h2>
              <p className="legend tabular-nums">{items.length === 1 ? "1 command" : `${items.length} commands`}</p>
            </div>
            <ol aria-label="Commands this session" className="space-y-9">
              {items.map(({ entry, events, view }) => (
                <FeedItem
                  key={entry.key}
                  entry={entry}
                  events={events}
                  view={view}
                  busy={busy}
                  onEdit={edit}
                  onRetry={submit}
                />
              ))}
            </ol>
          </>
        )}

        <div
          ref={endRef}
          aria-hidden="true"
          className="scroll-mb-[calc(var(--bottom-chrome)+var(--commandbar-height)+1rem)]"
        />
        <p role="status" aria-live="polite" className="sr-only">
          {message}
        </p>
      </div>

      <CommandBar value={draft} onChange={setDraft} onSubmit={submit} busy={busy} inputRef={inputRef} />
    </>
  );
}

const TIER_NOTES: readonly { tier: string; text: string }[] = [
  { tier: "read", text: "Looks something up on the Mac. Runs right away." },
  { tier: "act", text: "Opens apps or changes something. Runs right away." },
  { tier: "destructive", text: "Sends, deletes, or quits. Waits for your confirmation." },
];

function EmptyCommandState({ onPick }: { onPick: (command: string) => void }) {
  return (
    <section aria-labelledby="command-empty-title" className="pt-4 sm:pt-10">
      <p className="legend">Ready</p>
      <h2
        id="command-empty-title"
        className="mt-3 text-[28px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance text-fg sm:text-[36px]"
      >
        Tell your Mac what to do.
      </h2>
      <p className="mt-3 max-w-prose text-[15px] leading-6 text-fg-muted">
        Commands run on your Mac one at a time, and you can watch each step as it happens. Anything destructive waits
        for you to confirm it.
      </p>

      <h3 className="legend mt-10">Try</h3>
      <ul className="mt-3 flex flex-wrap gap-2">
        {EXAMPLE_COMMANDS.map((example) => (
          <li key={example} className="max-w-full">
            <button
              type="button"
              onClick={() => onPick(example)}
              className={chip(false, "max-w-full font-mono text-[13px]")}
            >
              <span className="truncate">{example}</span>
            </button>
          </li>
        ))}
      </ul>

      <dl className="mt-12 grid gap-5 border-t border-line pt-6 sm:grid-cols-3 sm:gap-6">
        {TIER_NOTES.map((note) => (
          <div key={note.tier}>
            <dt>
              <TierBadge tier={note.tier} />
            </dt>
            <dd className="mt-2 text-[13px] leading-5 text-fg-muted">{note.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
