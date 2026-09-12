import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { saveToken } from "@/lib/token";
import { auditRow } from "@/test/fixtures";
import { AuthProvider } from "../providers/AuthProvider";
import { AuditDetail } from "./AuditDetail";

const TOKEN = "Wd4x-8Qm3nS7pT2vY6bH1kL0jR9cA5eZ";

const noFetch = (() => {
  throw new Error("this test must not reach the network");
}) as typeof fetch;

/** A row button that opens the sheet, as the audit list does. */
function Screen() {
  const [open, setOpen] = useState(false);
  return (
    <AuthProvider fetchImpl={noFetch}>
      <button type="button" onClick={() => setOpen(true)}>
        Audit row 1
      </button>
      {open && (
        <AuditDetail
          id={1}
          row={auditRow()}
          hrefFor={(id) => `/audit/?id=${id}`}
          commandHref={(commandId) => `/audit/?command_id=${commandId}`}
          onClose={() => setOpen(false)}
        />
      )}
    </AuthProvider>
  );
}

describe("AuditDetail", () => {
  it("returns focus to the row that opened it, so the keyboard does not start over", async () => {
    saveToken(TOKEN);
    render(<Screen />);
    const opener = screen.getByRole("button", { name: "Audit row 1" });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    const close = await screen.findByRole("button", { name: /close/i });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
