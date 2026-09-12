"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocationOrigin } from "@/hooks/useLocationOrigin";
import { useResource } from "@/hooks/useResource";
import { ApiError, describeError } from "@/lib/api";
import { cx } from "@/lib/cx";
import { EMPTY_VALUE, formatClock, formatCount, formatDuration } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { CopyButton } from "../CopyButton";
import { AlertIcon, RetryIcon } from "../icons";
import { PageBody, PageHeader } from "../PageHeader";
import { useAuth } from "../providers/AuthProvider";
import { useEventStream, useStreamState } from "../providers/EventStreamProvider";
import { STREAM_STATUS } from "../StreamStatus";
import { button, TONE } from "../ui";

export function SettingsScreen() {
  return (
    <PageBody>
      <PageHeader title="Settings" description="The Mac this device talks to, its live connection, and this device’s pairing." />
      <ServerPanel />
      <StreamPanel />
      <PairingPanel />
    </PageBody>
  );
}

function Panel({
  id,
  title,
  description,
  children,
  footer,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="legend">
        {title}
      </h2>
      {description && <p className="mt-1.5 text-[14px] leading-6 text-fg-muted">{description}</p>}
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
        {children}
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-[13px] leading-5 text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-[14px] leading-5 text-fg">{children}</dd>
    </div>
  );
}

function StatusText({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-2", TONE[tone].text)}>
      <span aria-hidden="true" className={cx("h-2 w-2 shrink-0 rounded-full", TONE[tone].dot)} />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

function ServerPanel() {
  const { api } = useAuth();
  const origin = useLocationOrigin();
  const [checks, setChecks] = useState(0);
  const health = useResource(`health:${checks}`, async (signal) => {
    const started = performance.now();
    const response = await api.health({ signal });
    return { status: response.status, ms: Math.round(performance.now() - started) };
  });

  let status: ReactNode;
  if (health.loading) {
    status = <StatusText tone="pending">Checking…</StatusText>;
  } else if (health.error !== null) {
    const unreachable = health.error instanceof ApiError && health.error.status === 0;
    status = <StatusText tone="danger">{unreachable ? "Unreachable" : describeError(health.error)}</StatusText>;
  } else if (health.data) {
    status = (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusText tone="ok">{health.data.status || "Reachable"}</StatusText>
        <span className="font-mono text-[12px] text-fg-faint tabular-nums">{formatDuration(health.data.ms)}</span>
      </span>
    );
  }

  return (
    <Panel
      id="settings-server"
      title="Server"
      description="The app is served by the Mac and calls its API on the same origin."
      footer={
        <button
          type="button"
          onClick={() => setChecks((count) => count + 1)}
          disabled={health.loading}
          className={button("secondary", "sm")}
        >
          <RetryIcon className="h-4 w-4" />
          Check again
        </button>
      }
    >
      <dl className="divide-y divide-line">
        <Row label="Origin">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <code className="min-w-0 font-mono text-[13px] break-all text-fg">{origin || EMPTY_VALUE}</code>
            {origin && <CopyButton text={origin} />}
          </span>
        </Row>
        <Row label="Health">
          <span aria-live="polite">{status}</span>
        </Row>
        {health.error !== null && (
          <div className="flex gap-2 px-4 py-3 text-[13px] leading-5 text-fg-muted">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <p className="min-w-0">{describeError(health.error)}</p>
          </div>
        )}
      </dl>
    </Panel>
  );
}

function StreamPanel() {
  const { client } = useEventStream();
  const state = useStreamState();
  const view = STREAM_STATUS[state.status];
  const canReconnect = state.status !== "idle" && state.status !== "unauthorized";

  return (
    <Panel
      id="settings-stream"
      title="Event stream"
      description="One live connection carries every screen’s updates. It reconnects on its own when the network drops."
      footer={
        <button
          type="button"
          onClick={() => client.reconnect()}
          disabled={!canReconnect}
          className={button("secondary", "sm")}
        >
          <RetryIcon className="h-4 w-4" />
          Reconnect
        </button>
      }
    >
      <dl className="divide-y divide-line">
        <Row label="Status">
          <span className="flex flex-col gap-0.5">
            <StatusText tone={view.tone}>{view.label}</StatusText>
            <span className="text-[13px] leading-5 text-fg-muted">{view.description}</span>
          </span>
        </Row>
        <Row label="Connected at">
          <span className="font-mono text-[13px] tabular-nums">
            {state.connectedAt === null ? EMPTY_VALUE : formatClock(state.connectedAt / 1000)}
          </span>
        </Row>
        <Row label="Server boot">
          <code className="font-mono text-[13px] break-all">{state.bootId ?? EMPTY_VALUE}</code>
        </Row>
        <Row label="Failed attempts">
          <span className="font-mono text-[13px] tabular-nums">{formatCount(state.failures)}</span>
        </Row>
      </dl>
    </Panel>
  );
}

function PairingPanel() {
  const { unpair } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const unpairRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);

  useEffect(() => {
    if (confirming) {
      opened.current = true;
      keepRef.current?.focus();
    } else if (opened.current) {
      opened.current = false;
      unpairRef.current?.focus();
    }
  }, [confirming]);

  return (
    <Panel
      id="settings-pairing"
      title="Pairing"
      description="The pairing token is stored in this browser only. It is sent as an Authorization header and never shown, logged, or put in a URL."
    >
      <div className="px-4 py-4">
        <StatusText tone="ok">This device is paired</StatusText>
        {confirming ? (
          <div
            role="group"
            aria-labelledby="unpair-title"
            className="mt-4 rounded-lg border border-danger/35 bg-danger/5 p-4"
          >
            <p id="unpair-title" className="text-[15px] leading-6 font-semibold text-fg">
              Unpair this device?
            </p>
            <p className="mt-1 text-[14px] leading-6 text-fg-muted">
              This browser forgets the pairing token. To send commands again, scan the QR code the Mac prints or paste
              its pairing link.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={unpair} className={button("danger")}>
                Unpair
              </button>
              <button ref={keepRef} type="button" onClick={() => setConfirming(false)} className={button("secondary")}>
                Keep paired
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <button
              ref={unpairRef}
              type="button"
              onClick={() => setConfirming(true)}
              className={button("secondary", "md", "text-danger")}
            >
              Unpair this device…
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
