import { describe, expect, it } from "vitest";
import { formatDiffLines } from "./format-diff";

describe("formatDiffLines", () => {
  it("formats a new file as additions", () => {
    const lines = formatDiffLines({
      path: "a.ts",
      oldText: null,
      newText: "one\ntwo\n",
    });
    expect(lines.some((l) => l.type === "add" && l.text.includes("one"))).toBe(
      true,
    );
    expect(lines.some((l) => l.type === "hunk")).toBe(true);
  });

  it("formats a deletion as removals", () => {
    const lines = formatDiffLines({
      path: "a.ts",
      oldText: "gone\n",
      newText: null,
    });
    expect(lines.some((l) => l.type === "del" && l.text.includes("gone"))).toBe(
      true,
    );
  });

  it("formats an edit with del and add lines", () => {
    const lines = formatDiffLines({
      path: "a.ts",
      oldText: "old\n",
      newText: "new\n",
    });
    expect(lines.some((l) => l.type === "del")).toBe(true);
    expect(lines.some((l) => l.type === "add")).toBe(true);
  });
});
