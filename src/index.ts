export {
  checkTrace,
  contractHash,
  generateContract,
  parseContract,
  renderCheckMarkdown,
  renderCheckTerminal,
} from "./contract.js";
export type { CheckResult, Contract, ContractRules, Violation } from "./contract.js";
export { diffTraces } from "./diff.js";
export { detectFormat, importTrace } from "./import.js";
export type { ImportFormat, ImportOptions, ImportResult } from "./import.js";
export { diffTracesSampled, hasSamples } from "./samples.js";
export { loadTrace, parseTrace } from "./parse.js";
export { startProxy } from "./proxy.js";
export { Recorder } from "./record.js";
export { renderMarkdown, renderTerminal } from "./report.js";
export { renderOnce, startWatch } from "./watch.js";
export type { WatchOptions } from "./watch.js";
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
