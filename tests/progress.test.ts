import { describe, expect, test } from "bun:test";
import { formatProgress } from "../src/progress";

describe("progress rendering", () => {
  test("shows a stable bar, percentage, count, elapsed time, and ETA", () => {
    const output = formatProgress({ label: "翻译", current: 25, total: 100, elapsedMs: 10_000, barWidth: 12 });
    expect(output).toContain("25%");
    expect(output).toContain("25/100");
    expect(output).toContain("0:10");
    expect(output).toContain("余 0:30");
    expect(output).toContain("━━━");
  });

  test("marks completed and failed work without ANSI in plain output", () => {
    expect(formatProgress({ label: "语音", current: 2, total: 2, elapsedMs: 1000, done: true })).toStartWith("✓");
    expect(formatProgress({ label: "合并", current: 1, total: 2, elapsedMs: 1000, failed: true })).toStartWith("✗");
  });
});
