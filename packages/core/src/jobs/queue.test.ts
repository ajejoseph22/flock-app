import { describe, expect, it } from "vitest";
import { backoffMs } from "./queue";

describe("backoffMs", () => {
  it("grows exponentially and caps at one hour", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(5_000);
    expect(backoffMs(2, mid)).toBe(10_000);
    expect(backoffMs(5, mid)).toBe(80_000);
    expect(backoffMs(30, mid)).toBe(3_600_000);
  });
  it("applies ±20% jitter", () => {
    expect(backoffMs(1, () => 0)).toBe(4_000);
    expect(backoffMs(1, () => 1)).toBe(6_000);
  });
});
