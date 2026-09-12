"use client";

import type { FormEvent, KeyboardEvent, Ref } from "react";
import { cx } from "@/lib/cx";
import { SendIcon } from "../icons";

interface CommandBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (command: string) => void;
  /** A command from this device is running; sending waits until it finishes. */
  busy: boolean;
  inputRef: Ref<HTMLInputElement>;
}

/** The command input, pinned above the tab bar on phones and to the bottom of the column on wide screens. */
export function CommandBar({ value, onChange, onSubmit, busy, inputRef }: CommandBarProps) {
  const empty = value.trim() === "";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || empty) return;
    onSubmit(value);
  }

  // Enter sends without relying on implicit form submission, and never while
  // an input method is still composing text (Enter then picks a candidate).
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (busy || empty) return;
    onSubmit(value);
  }

  return (
    <div className="fixed inset-x-0 bottom-chrome z-20 border-t border-line bg-ground/90 backdrop-blur-md lg:left-60 lg:border-t-0 lg:bg-transparent lg:backdrop-blur-none">
      <form onSubmit={submit} className="mx-auto w-full max-w-3xl px-page py-3 sm:px-6 lg:px-10 lg:pb-6">
        <div
          className={cx(
            "flex items-center gap-2 rounded-xl border border-line-strong bg-panel pr-1.5 pl-3.5 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)] transition-colors duration-150",
            "focus-within:border-fg-faint focus-within:ring-2 focus-within:ring-act/45",
          )}
        >
          <span aria-hidden="true" className="font-mono text-[16px] leading-none text-fg-faint">
            ›
          </span>
          <label htmlFor="command-input" className="sr-only">
            Command
          </label>
          <input
            id="command-input"
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={busy ? "Running on your Mac…" : "Tell your Mac what to do"}
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-faint disabled:cursor-not-allowed disabled:text-fg-muted"
          />
          <button
            type="submit"
            disabled={busy || empty}
            aria-label={busy ? "Running" : "Send command"}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-fg text-ground transition-colors duration-150 hover:bg-white disabled:cursor-not-allowed disabled:bg-control disabled:text-fg-faint"
          >
            {busy ? (
              <span aria-hidden="true" className="h-2 w-2 animate-breathe rounded-full bg-pending" />
            ) : (
              <SendIcon className="h-5 w-5" />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
