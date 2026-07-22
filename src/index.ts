export { diffTraces } from "./diff.js";
export { loadTrace, parseTrace } from "./parse.js";
export { Recorder } from "./record.js";
export { renderMarkdown, renderTerminal } from "./report.js";
export type {
  DiffOptions,
  DiffResult,
  Finding,
  Run,
  RunDiff,
  RunStats,
  Severity,
  TraceEvent,
} from "./types.js";
