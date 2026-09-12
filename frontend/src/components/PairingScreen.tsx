"use client";

import { useState, type FormEvent } from "react";
import { cx } from "@/lib/cx";
import { parsePairingInput } from "@/lib/token";
import { AlertIcon, ImperiumMark, QrIcon, RetryIcon } from "./icons";
import { button, INPUT } from "./ui";

export type RetryOutcome = "accepted" | "rejected" | "unreachable";

interface PairingScreenProps {
  mode: "unpaired" | "rejected";
  /** Store a token; false when the browser refused to save it. */
  onPair: (token: string) => boolean;
  onRetry?: () => Promise<RetryOutcome>;
  onForget?: () => void;
}

const RETRY_MESSAGES: Record<Exclude<RetryOutcome, "accepted">, string> = {
  rejected: "The Mac still rejects this device. Pair it again with the QR code the Mac shows now.",
  unreachable: "Could not reach the Mac. Check that the server is running and this device is on the same network.",
};

export function PairingScreen({ mode, onPair, onRetry, onForget }: PairingScreenProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [retryResult, setRetryResult] = useState<Exclude<RetryOutcome, "accepted"> | null>(null);
  const rejected = mode === "rejected";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parsePairingInput(value);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (!onPair(parsed.token)) {
      setError("This browser would not save the token. Allow site data for this page, then try again.");
      return;
    }
    setValue("");
    setError(null);
  }

  async function retry() {
    if (!onRetry || checking) return;
    setChecking(true);
    setRetryResult(null);
    const outcome = await onRetry();
    setChecking(false);
    if (outcome !== "accepted") setRetryResult(outcome);
  }

  return (
    <main className="px-page pt-safe pb-safe">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center py-12">
        <div className="flex items-center gap-2.5 text-fg">
          <ImperiumMark className="h-7 w-7" />
          <span className="wordmark">Imperium</span>
        </div>

        <p className={cx("legend mt-12", rejected && "text-danger")}>{rejected ? "Pairing rejected" : "Not paired"}</p>
        <h1 className="mt-2 text-[28px] leading-tight font-semibold tracking-[-0.02em] text-fg sm:text-[32px]">
          {rejected ? "Not paired, or pairing revoked" : "Pair this device with your Mac"}
        </h1>
        <p className="mt-3 text-[15px] leading-6 text-fg-muted">
          {rejected
            ? "The Mac did not accept this device’s pairing token. The token changes when its file on the Mac is deleted and the server restarts."
            : "Imperium runs commands on your Mac, so only paired devices can send them. Pairing takes one scan."}
        </p>

        {rejected && onRetry && (
          <div className="mt-6">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={retry} disabled={checking} className={button("primary")}>
                <RetryIcon className="h-4 w-4" />
                {checking ? "Checking…" : "Retry"}
              </button>
              {onForget && (
                <button type="button" onClick={onForget} className={button("ghost")}>
                  Forget this device
                </button>
              )}
            </div>
            {retryResult && (
              <p role="alert" className="mt-3 flex gap-2 text-[14px] leading-5 text-danger">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {RETRY_MESSAGES[retryResult]}
              </p>
            )}
          </div>
        )}

        <ol className="mt-10 space-y-5 border-t border-line pt-8">
          <li className="grid grid-cols-[2rem_1fr] gap-2">
            <span className="font-mono text-[13px] leading-6 text-fg-faint">01</span>
            <div>
              <p className="text-[15px] leading-6 font-medium text-fg">Start Imperium on the Mac</p>
              <p className="mt-1 text-[14px] leading-6 text-fg-muted">
                Run <code className="rounded bg-raised px-1.5 py-0.5 text-[13px] text-fg">python backend/main.py</code>.
                It prints a QR code in the terminal.
              </p>
            </div>
          </li>
          <li className="grid grid-cols-[2rem_1fr] gap-2">
            <span className="font-mono text-[13px] leading-6 text-fg-faint">02</span>
            <div>
              <p className="text-[15px] leading-6 font-medium text-fg">Scan the QR code with this device</p>
              <p className="mt-1 text-[14px] leading-6 text-fg-muted">
                The camera opens this app with a pairing link, and the device pairs on its own.
              </p>
            </div>
          </li>
        </ol>

        <form onSubmit={submit} noValidate className="mt-10 rounded-xl border border-line bg-panel p-4">
          <label htmlFor="pairing-input" className="flex items-center gap-2 text-[14px] font-medium text-fg">
            <QrIcon className="h-4 w-4 text-fg-faint" />
            Can’t scan? Paste the pairing link
          </label>
          <p id="pairing-hint" className="mt-1 text-[13px] leading-5 text-fg-muted">
            The link printed under the QR code, or just the token after <code className="text-fg">#token=</code>.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              id="pairing-input"
              type="password"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby={error ? "pairing-hint pairing-error" : "pairing-hint"}
              aria-invalid={error ? true : undefined}
              placeholder="Pairing link or token"
              className={cx(INPUT, "font-mono")}
            />
            <button type="submit" className={button("secondary")}>
              Pair
            </button>
          </div>
          {error && (
            <p id="pairing-error" role="alert" className="mt-2 text-[13px] leading-5 text-danger">
              {error}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
