import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import pc from "picocolors";
import { diffTraces } from "./diff.js";
import { loadTrace } from "./parse.js";
import { diffTracesSampled, hasSamples } from "./samples.js";
import { renderTerminal } from "./report.js";
import type { DiffOptions } from "./types.js";

/**
 * Load both traces, diff them, and return the terminal report.
 * Returns null when either file is unreadable or mid-write (truncated JSONL),
 * so the caller can keep the last good render instead of crashing.
 */
export function renderOnce(
  beforePath: string,
  afterPath: string,
  options: DiffOptions,
): string | null {
  try {
    const before = loadTrace(beforePath);
    const after = loadTrace(afterPath);
    const result =
      hasSamples(before) || hasSamples(after)
        ? diffTracesSampled(before, after, options)
        : diffTraces(before, after, options);
    return renderTerminal(result);
  } catch {
    return null;
  }
}

export interface WatchOptions {
  beforePath: string;
  afterPath: string;
  diffOptions: DiffOptions;
  clearScreen: boolean;
  debounceMs?: number;
  retryMs?: number;
  print?: (text: string) => void;
}

/** Watch both trace files and re-render the diff on every change. Returns a stop function. */
export function startWatch(opts: WatchOptions): () => void {
  const { beforePath, afterPath, diffOptions, clearScreen } = opts;
  const debounceMs = opts.debounceMs ?? 250;
  const retryMs = opts.retryMs ?? 200;
  const print = opts.print ?? ((text: string) => console.log(text));

  let lastGood: string | null = null;
  let lastChange = new Date();

  const header = () =>
    pc.dim(
      `watching ${afterPath} against ${beforePath}, last change ${lastChange.toTimeString().slice(0, 8)}, ctrl-c to stop`,
    );

  const paint = (body: string) => {
    lastGood = body;
    print((clearScreen ? "\x1b[2J\x1b[H" : "") + header() + "\n" + body);
  };

  let retryTimer: NodeJS.Timeout | null = null;

  const render = () => {
    const body = renderOnce(beforePath, afterPath, diffOptions);
    if (body !== null) {
      paint(body);
      return;
    }
    // the recorder may be mid-line, so retry once before touching the screen
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const again = renderOnce(beforePath, afterPath, diffOptions);
      if (again !== null) {
        paint(again);
      } else if (lastGood !== null) {
        print(pc.dim("  (current trace not parseable yet, keeping the last diff)"));
      }
      // no good render yet: stay quiet until the next write
    }, retryMs);
  };

  let debounceTimer: NodeJS.Timeout | null = null;
  const schedule = () => {
    lastChange = new Date();
    // recorders append JSONL line by line; wait for the writes to settle
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      render();
    }, debounceMs);
  };

  // watch each file's directory, not the file node: on Windows a watcher
  // pinned to a file goes silent when a recorder or editor replaces it
  const byDir = new Map<string, Set<string>>();
  for (const path of [beforePath, afterPath]) {
    const dir = resolve(dirname(path));
    let names = byDir.get(dir);
    if (!names) byDir.set(dir, (names = new Set()));
    names.add(basename(path).toLowerCase());
  }

  const watchers: FSWatcher[] = [];
  for (const [dir, names] of byDir) {
    watchers.push(
      watch(dir, (_event, filename) => {
        if (filename && !names.has(filename.toLowerCase())) return;
        schedule();
      }),
    );
  }

  if (existsSync(afterPath)) {
    render();
  } else {
    print(pc.dim(`waiting for ${afterPath}...`));
  }

  return () => {
    for (const watcher of watchers) watcher.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
  };
}
