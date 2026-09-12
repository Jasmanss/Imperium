import { describe, expect, it } from "vitest";
import { formatCountdown, fractionRemaining, isExpired, secondsRemaining } from "./countdown";

describe("secondsRemaining", () => {
  it("counts down from the Mac's clock, not the phone's", () => {
    // The phone's clock is 10 minutes fast; the countdown must not notice.
    const serverTime = 1_700_000_000;
    const expiresAt = serverTime + 120;
    const receivedAt = 9_999_600_000;
    expect(secondsRemaining(expiresAt, serverTime, receivedAt, receivedAt)).toBe(120);
    expect(secondsRemaining(expiresAt, serverTime, receivedAt, receivedAt + 30_000)).toBe(90);
  });

  it("clamps at zero and ignores a clock that runs backwards", () => {
    const serverTime = 1_700_000_000;
    const receivedAt = 5_000;
    expect(secondsRemaining(serverTime + 10, serverTime, receivedAt, receivedAt + 60_000)).toBe(0);
    expect(secondsRemaining(serverTime + 10, serverTime, receivedAt, receivedAt - 60_000)).toBe(10);
  });

  it("treats a confirmation already expired on the Mac as expired", () => {
    expect(secondsRemaining(1_700_000_000, 1_700_000_030, 0, 0)).toBe(0);
  });
});

describe("isExpired", () => {
  it("is true only at or below zero", () => {
    expect(isExpired(0.4)).toBe(false);
    expect(isExpired(0)).toBe(true);
    expect(isExpired(-1)).toBe(true);
  });
});

describe("formatCountdown", () => {
  it("rounds up so the display reaches 0:00 exactly at expiry", () => {
    expect(formatCountdown(120)).toBe("2:00");
    expect(formatCountdown(119.4)).toBe("2:00");
    expect(formatCountdown(59.2)).toBe("1:00");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("fractionRemaining", () => {
  it("stays within 0 and 1, whatever the ttl", () => {
    expect(fractionRemaining(60, 120)).toBe(0.5);
    expect(fractionRemaining(200, 120)).toBe(1);
    expect(fractionRemaining(-5, 120)).toBe(0);
    expect(fractionRemaining(60, 0)).toBe(0);
  });
});
