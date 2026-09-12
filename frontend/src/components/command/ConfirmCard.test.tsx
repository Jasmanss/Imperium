import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { parked } from "@/test/fixtures";
import type { FeedEntry } from "../providers/CommandSessionProvider";
import { ConfirmCard } from "./ConfirmCard";

const PARKED_AT = 1_800_000_000_000;

function entryFor(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    key: "c-1",
    command: "text 555-0100 saying on my way",
    clientId: "c-1",
    commandId: "a1b2c3d4e5f6",
    submittedAt: PARKED_AT,
    phase: "parked",
    parked: parked(),
    parkedAt: PARKED_AT,
    attempt: 0,
    result: null,
    metrics: null,
    error: null,
    closed: false,
    resolvedAs: null,
    restored: false,
    ...overrides,
  };
}

function renderCard(entry = entryFor()) {
  const handlers = { onConfirm: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onDismiss: vi.fn() };
  render(<ConfirmCard entry={entry} parked={entry.parked!} {...handlers} retryDisabled={false} />);
  return handlers;
}

function countdown(): string {
  return screen.getByRole("timer").textContent ?? "";
}

function findButton(name: RegExp | string): HTMLButtonElement | null {
  return screen.queryByRole("button", { name }) as HTMLButtonElement | null;
}

/** Run the card's clock forward; each tick is a real interval the card scheduled. */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("ConfirmCard", () => {
  it("counts down on the Mac's clock and offers Confirm and Cancel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PARKED_AT);
    renderCard();
    await advance(0);
    expect(countdown()).toBe("2:00");

    await advance(30_000);
    expect(countdown()).toBe("1:30");
    expect(findButton("Confirm")?.disabled).toBe(false);
    expect(findButton("Cancel")?.disabled).toBe(false);
  });

  it("stops the clock once the confirmation expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PARKED_AT);
    renderCard();
    await advance(125_000);

    expect(countdown()).toBe("Expired");
    expect(findButton("Confirm")).toBeNull();
    expect(findButton(/Send again/)).not.toBeNull();
    // An expired card sits on screen until it is dismissed: it must not keep
    // re-rendering itself once a second for the rest of the session.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs no clock at all for a card the Mac has closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PARKED_AT);
    renderCard(entryFor({ closed: true, error: "This confirmation is no longer waiting on the Mac." }));
    await advance(0);

    expect(screen.queryByText("Confirmation closed")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("no longer waiting on the Mac");
    expect(findButton("Confirm")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows what will happen before anything runs", () => {
    renderCard(
      entryFor({
        parked: parked({
          details: [
            { label: "To", value: "555-0100" },
            { label: "Message", value: "on my way" },
          ],
        }),
      }),
    );
    expect(screen.queryByText("To")).not.toBeNull();
    expect(screen.queryByText("555-0100")).not.toBeNull();
    expect(screen.queryByText("on my way")).not.toBeNull();
    expect(screen.queryByText(/Nothing runs until you confirm/)).not.toBeNull();
  });

  it("disables both buttons while a confirm is in flight", () => {
    renderCard(entryFor({ phase: "confirming" }));
    expect(findButton("Confirming…")?.disabled).toBe(true);
    expect(findButton("Cancel")?.disabled).toBe(true);
  });
});
