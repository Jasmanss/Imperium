import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventStreamClient } from "@/lib/events";
import { saveToken } from "@/lib/token";
import { executed, jsonResponse, parked } from "@/test/fixtures";
import { AuthProvider } from "./AuthProvider";
import { CommandSessionProvider, useCommandSession } from "./CommandSessionProvider";
import { EventStreamProvider } from "./EventStreamProvider";

const TOKEN = "Wd4x-8Qm3nS7pT2vY6bH1kL0jR9cA5eZ";

type Route = (body: unknown) => Response | Promise<Response>;

/** The provider tree with a stubbed API and an event stream that never opens. */
function mount(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = (async (input, init) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const route = routes[path];
    if (!route) return jsonResponse(404, { error: `no stub for ${path}` });
    return route(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
  }) as typeof fetch;

  // A client whose connection never settles: no stream, no reconnect timers.
  const client = new EventStreamClient({
    getToken: () => TOKEN,
    fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
  });

  function Probe() {
    const session = useCommandSession();
    const entry = session.entries[0];
    return (
      <div>
        <button type="button" onClick={() => session.send("text 555-0100 saying on my way")}>
          send
        </button>
        {entry && (
          <>
            <p data-testid="phase">{entry.phase}</p>
            <p data-testid="closed">{String(entry.closed)}</p>
            <p data-testid="error">{entry.error ?? ""}</p>
            <button type="button" onClick={() => session.confirm(entry.key, entry.parked?.pending_id ?? "")}>
              confirm
            </button>
          </>
        )}
      </div>
    );
  }

  saveToken(TOKEN);
  render(
    <AuthProvider fetchImpl={fetchImpl}>
      <EventStreamProvider client={client}>
        <CommandSessionProvider>
          <Probe />
        </CommandSessionProvider>
      </EventStreamProvider>
    </AuthProvider>,
  );
  return { calls };
}

const EMPTY_PENDING: Route = () => jsonResponse(200, { pending: [], server_time: 1_700_000_000 });

async function park(send = () => screen.getByText("send").click()) {
  await act(async () => {
    send();
  });
  await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("parked"));
}

async function tapConfirm() {
  await act(async () => {
    screen.getByText("confirm").click();
  });
}

describe("CommandSessionProvider", () => {
  it("parks a destructive command and runs it only once confirmed", async () => {
    mount({
      "/pending": EMPTY_PENDING,
      "/text-command": () => jsonResponse(200, { ...parked(), transcript: "…", action: "confirm to execute" }),
      "/confirm/pend-1": () => jsonResponse(200, executed()),
    });
    await park();
    await tapConfirm();
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("done"));
  });

  it("closes the card when the Mac says the confirmation is gone", async () => {
    mount({
      "/pending": EMPTY_PENDING,
      "/text-command": () => jsonResponse(200, { ...parked(), transcript: "…", action: "confirm to execute" }),
      "/confirm/pend-1": () => jsonResponse(200, { error: "Confirmation expired or already used — send the command again." }),
    });
    await park();
    await tapConfirm();
    await waitFor(() => expect(screen.getByTestId("closed").textContent).toBe("true"));
    expect(screen.getByTestId("error").textContent).toContain("expired or already used");
  });

  it("re-arms the card when the confirm never reached the Mac, since it may still be parked", async () => {
    mount({
      "/pending": EMPTY_PENDING,
      "/text-command": () => jsonResponse(200, { ...parked(), transcript: "…", action: "confirm to execute" }),
      "/confirm/pend-1": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await park();
    await tapConfirm();
    await waitFor(() => expect(screen.getByTestId("error").textContent).toContain("Could not reach the Mac"));
    expect(screen.getByTestId("phase").textContent).toBe("parked");
    // Confirmation ids are single use on the Mac, so retrying can never run it twice.
    expect(screen.getByTestId("closed").textContent).toBe("false");
  });

  it("closes the card when an HTTP error says the Mac refused the confirmation", async () => {
    mount({
      "/pending": EMPTY_PENDING,
      "/text-command": () => jsonResponse(200, { ...parked(), transcript: "…", action: "confirm to execute" }),
      "/confirm/pend-1": () => jsonResponse(500, { error: "Something went wrong on the Mac." }),
    });
    await park();
    await tapConfirm();
    await waitFor(() => expect(screen.getByTestId("closed").textContent).toBe("true"));
  });

  it("sends the token as a header and never puts it in a URL", async () => {
    const { calls } = mount({
      "/pending": EMPTY_PENDING,
      "/text-command": () => jsonResponse(200, executed()),
    });
    await act(async () => {
      screen.getByText("send").click();
    });
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("done"));
    expect(calls.some((call) => call.includes(TOKEN))).toBe(false);
  });
});
