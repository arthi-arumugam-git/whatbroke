import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderOnce, startWatch } from "../src/watch.js";

function traceText(args: Record<string, unknown>): string {
  return (
    [
      JSON.stringify({ type: "run_start", run: "flow" }),
      JSON.stringify({ type: "tool_call", run: "flow", name: "lookup_order", args }),
      JSON.stringify({ type: "run_end", run: "flow", status: "ok" }),
    ].join("\n") + "\n"
  );
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "whatbroke-watch-"));
}

describe("renderOnce", () => {
  it("renders a diff for two valid traces", () => {
    const dir = tempDir();
    const before = join(dir, "before.jsonl");
    const after = join(dir, "after.jsonl");
    writeFileSync(before, traceText({ order_id: "A-1042" }));
    writeFileSync(after, traceText({ order_id: "A-2077" }));

    const out = renderOnce(before, after, {});
    expect(out).not.toBeNull();
    expect(out).toContain("lookup_order");
  });

  it("renders a clean report when nothing changed", () => {
    const dir = tempDir();
    const before = join(dir, "before.jsonl");
    writeFileSync(before, traceText({ order_id: "A-1042" }));

    const out = renderOnce(before, before, {});
    expect(out).not.toBeNull();
    expect(out).toContain("nothing broke");
  });

  it("returns null when the current file does not exist", () => {
    const dir = tempDir();
    const before = join(dir, "before.jsonl");
    writeFileSync(before, traceText({ order_id: "A-1042" }));

    expect(renderOnce(before, join(dir, "missing.jsonl"), {})).toBeNull();
  });

  it("returns null instead of throwing on a truncated trailing line", () => {
    const dir = tempDir();
    const before = join(dir, "before.jsonl");
    const after = join(dir, "after.jsonl");
    writeFileSync(before, traceText({ order_id: "A-1042" }));
    writeFileSync(
      after,
      traceText({ order_id: "A-1042" }) + '{"type":"tool_call","run":"flow","na',
    );

    expect(renderOnce(before, after, {})).toBeNull();
  });
});

describe("startWatch", () => {
  it("renders immediately when the current file exists, then re-renders on change", async () => {
    const dir = tempDir();
    const before = join(dir, "before.jsonl");
    const after = join(dir, "after.jsonl");
    writeFileSync(before, traceText({ order_id: "A-1042" }));
    writeFileSync(after, traceText({ order_id: "A-1042" }));

    const prints: string[] = [];
    const stop = startWatch({
      beforePath: before,
      afterPath: after,
      diffOptions: {},
      clearScreen: false,
      debounceMs: 50,
      retryMs: 50,
      print: (text) => prints.push(text),
    });

    try {
      expect(prints.length).toBe(1);
      expect(prints[0]).toContain("watching");
      expect(prints[0]).toContain("nothing broke");

      writeFileSync(after, traceText({ order_id: "A-2077" }));
      // generous margin over the 50ms debounce so slow Windows fs events pass
      await waitFor(() => prints.length >= 2, 5000);
      expect(prints[prints.length - 1]).toContain("called with different args");
    } finally {
      stop();
    }
  });

  it("waits for a missing current file and renders when it appears", async () => {
    const dir = tempDir();
    const before = join(dir, "before.jsonl");
    const after = join(dir, "after.jsonl");
    writeFileSync(before, traceText({ order_id: "A-1042" }));

    const prints: string[] = [];
    const stop = startWatch({
      beforePath: before,
      afterPath: after,
      diffOptions: {},
      clearScreen: false,
      debounceMs: 50,
      retryMs: 50,
      print: (text) => prints.push(text),
    });

    try {
      expect(prints.length).toBe(1);
      expect(prints[0]).toContain("waiting for");

      writeFileSync(after, traceText({ order_id: "A-1042" }));
      await waitFor(() => prints.some((p) => p.includes("nothing broke")), 5000);
    } finally {
      stop();
    }
  });

  it("keeps the last good render across a truncated write", async () => {
    const dir = tempDir();
    const before = join(dir, "before.jsonl");
    const after = join(dir, "after.jsonl");
    writeFileSync(before, traceText({ order_id: "A-1042" }));
    writeFileSync(after, traceText({ order_id: "A-1042" }));

    const prints: string[] = [];
    const stop = startWatch({
      beforePath: before,
      afterPath: after,
      diffOptions: {},
      clearScreen: false,
      debounceMs: 50,
      retryMs: 50,
      print: (text) => prints.push(text),
    });

    try {
      expect(prints[0]).toContain("nothing broke");

      appendFileSync(after, '{"type":"tool_call","run":"flow","na');
      await waitFor(() => prints.length >= 2, 5000);
      // parse failed twice, so the only new line is the dim keep-alive note
      expect(prints[prints.length - 1]).toContain("keeping the last diff");
    } finally {
      stop();
    }
  });
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
