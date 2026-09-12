import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureTokenFromLocation,
  clearToken,
  isValidToken,
  parsePairingInput,
  readToken,
  saveToken,
  stripTokenFragment,
  subscribeToken,
  tokenFromFragment,
  TOKEN_STORAGE_KEY,
} from "./token";

const TOKEN = "Wd4x-8Qm3nS7pT2vY6bH1kL0jR9cA5eZ";

/** Replace localStorage for one test; the suite's afterEach restores it. */
function withStorage(replacement: Partial<Storage>) {
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, value: replacement });
  return () => {
    if (real) Object.defineProperty(window, "localStorage", real);
  };
}

afterEach(() => {
  clearToken();
});

describe("isValidToken", () => {
  it("accepts visible ASCII only, so the token can go in a header", () => {
    expect(isValidToken(TOKEN)).toBe(true);
    expect(isValidToken("")).toBe(false);
    expect(isValidToken("has space")).toBe(false);
    expect(isValidToken("line\nbreak")).toBe(false);
    expect(isValidToken("café")).toBe(false);
    expect(isValidToken("x".repeat(512))).toBe(true);
    expect(isValidToken("x".repeat(513))).toBe(false);
  });
});

describe("parsePairingInput", () => {
  it("accepts the full pairing link", () => {
    expect(parsePairingInput(`  http://192.168.1.20:8000/app#token=${TOKEN}  `)).toEqual({ token: TOKEN });
  });

  it("accepts a bare fragment and a bare token", () => {
    expect(parsePairingInput(`#token=${TOKEN}`)).toEqual({ token: TOKEN });
    expect(parsePairingInput(TOKEN)).toEqual({ token: TOKEN });
  });

  it("explains a link with no token instead of storing nothing silently", () => {
    const result = parsePairingInput("http://192.168.1.20:8000/app");
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toContain("no pairing token");
  });

  it("rejects an empty input, an empty fragment, and a value with whitespace", () => {
    for (const input of ["", "   ", "#token=", `#token=${TOKEN} extra`, "two words"]) {
      expect(parsePairingInput(input)).toHaveProperty("error");
    }
  });
});

describe("tokenFromFragment", () => {
  it("reads only a #token= fragment", () => {
    expect(tokenFromFragment(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromFragment(`#other=${TOKEN}`)).toBeNull();
    expect(tokenFromFragment("")).toBeNull();
  });
});

describe("storage", () => {
  it("round-trips a token and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToken(listener);
    expect(saveToken(TOKEN)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readToken()).toBe(TOKEN);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);

    clearToken();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readToken()).toBeNull();
    unsubscribe();
  });

  it("refuses an invalid token without notifying", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToken(listener);
    expect(saveToken("not a token")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(readToken()).toBeNull();
    unsubscribe();
  });

  it("ignores a stored value that is no longer a usable token", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored with a space");
    expect(readToken()).toBeNull();
  });

  it("survives storage that throws", () => {
    const restore = withStorage({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(readToken()).toBeNull();
      expect(saveToken(TOKEN)).toBe(false);
      expect(() => clearToken()).not.toThrow();
    } finally {
      restore();
    }
  });
});

describe("captureTokenFromLocation", () => {
  it("stores the token a pairing link carried", () => {
    expect(captureTokenFromLocation({ hash: `#token=${TOKEN}` })).toBe(true);
    expect(readToken()).toBe(TOKEN);
  });

  it("stores nothing for a page opened without one", () => {
    expect(captureTokenFromLocation({ hash: "" })).toBe(false);
    expect(captureTokenFromLocation({ hash: "#token=not a token" })).toBe(false);
    expect(readToken()).toBeNull();
  });
});

describe("stripTokenFragment", () => {
  it("rewrites the URL to path and query, with no hash and null state", () => {
    const replaceState = vi.fn();
    const stripped = stripTokenFragment(
      { hash: `#token=${TOKEN}`, pathname: "/app/", search: "?from=qr" },
      { replaceState },
    );
    expect(stripped).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/app/?from=qr");
    expect(String(replaceState.mock.calls[0][2])).not.toContain(TOKEN);
  });

  it("leaves a URL without a token fragment alone", () => {
    const replaceState = vi.fn();
    expect(stripTokenFragment({ hash: "#section", pathname: "/app/", search: "" }, { replaceState })).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("reports failure when history refuses the rewrite", () => {
    const replaceState = vi.fn(() => {
      throw new Error("SecurityError");
    });
    expect(stripTokenFragment({ hash: `#token=${TOKEN}`, pathname: "/app/", search: "" }, { replaceState })).toBe(false);
  });
});
