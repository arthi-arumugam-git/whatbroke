import { createHash } from "node:crypto";
import pc from "picocolors";
import type { Run } from "./types.js";

export interface ContractRules {
  /** tools that must be called at least once */
  must_call?: string[];
  /** tools that must never be called */
  must_not_call?: string[];
  /** [a, b] pairs: b may only run after a has run at least once */
  call_order?: [string, string][];
  max_cost_usd?: number;
  max_latency_ms?: number;
  max_llm_calls?: number;
  max_tool_calls?: number;
  /** substrings the final output must contain (case-insensitive) */
  output_includes?: string[];
  /** substrings the final output must not contain (case-insensitive) */
  output_excludes?: string[];
  require_status?: "ok" | "error";
  no_tool_errors?: boolean;
}

export interface Contract {
  name?: string;
  /** rules applied to every run */
  rules?: ContractRules;
  /** per-run rules, merged over the shared rules; runs listed here must exist */
  runs?: Record<string, ContractRules>;
}

export interface Violation {
  run: string;
  rule: keyof ContractRules | "run_missing";
  message: string;
  /** samples that violated, e.g. "2/3" (omitted for single-sample runs) */
  rate?: string;
}

export interface CheckResult {
  contract: { name?: string; hash: string };
  runs: string[];
  rulesChecked: number;
  violations: Violation[];
  passed: boolean;
}

const RULE_KEYS: (keyof ContractRules)[] = [
  "must_call",
  "must_not_call",
  "call_order",
  "max_cost_usd",
  "max_latency_ms",
  "max_llm_calls",
  "max_tool_calls",
  "output_includes",
  "output_excludes",
  "require_status",
  "no_tool_errors",
];

export function contractHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function parseContract(text: string): Contract {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("contract is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("contract must be a JSON object");
  }
  const contract = raw as Contract;
  if (contract.rules) validateRules(contract.rules, "rules");
  for (const [run, rules] of Object.entries(contract.runs ?? {})) {
    validateRules(rules, `runs.${run}`);
  }
  if (!hasAnyRules(contract)) {
    throw new Error('contract has no rules (add "rules" or "runs")');
  }
  return contract;
}

function hasAnyRules(contract: Contract): boolean {
  const count = (rules?: ContractRules) =>
    rules ? RULE_KEYS.filter((k) => rules[k] !== undefined).length : 0;
  return (
    count(contract.rules) > 0 ||
    Object.values(contract.runs ?? {}).some((r) => count(r) > 0)
  );
}

function validateRules(rules: ContractRules, where: string): void {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    throw new Error(`${where} must be an object of rules`);
  }
  for (const key of Object.keys(rules)) {
    if (!RULE_KEYS.includes(key as keyof ContractRules)) {
      throw new Error(`${where}.${key} is not a known rule (known: ${RULE_KEYS.join(", ")})`);
    }
  }
  for (const key of ["must_call", "must_not_call", "output_includes", "output_excludes"] as const) {
    const value = rules[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
      throw new Error(`${where}.${key} must be an array of strings`);
    }
  }
  if (rules.call_order !== undefined) {
    const ok =
      Array.isArray(rules.call_order) &&
      rules.call_order.every(
        (p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "string"),
      );
    if (!ok) throw new Error(`${where}.call_order must be an array of [before, after] pairs`);
  }
  for (const key of ["max_cost_usd", "max_latency_ms", "max_llm_calls", "max_tool_calls"] as const) {
    const value = rules[key];
    if (value !== undefined && (typeof value !== "number" || !(value >= 0))) {
      throw new Error(`${where}.${key} must be a non-negative number`);
    }
  }
  if (rules.require_status !== undefined && rules.require_status !== "ok" && rules.require_status !== "error") {
    throw new Error(`${where}.require_status must be "ok" or "error"`);
  }
  if (rules.no_tool_errors !== undefined && typeof rules.no_tool_errors !== "boolean") {
    throw new Error(`${where}.no_tool_errors must be true or false`);
  }
}

const SAMPLE_RE = /^(.+)#(\d+)$/;

function groupSamples(runs: Map<string, Run>): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const [id, run] of runs) {
    const match = SAMPLE_RE.exec(id);
    const base = match ? match[1] : id;
    const list = groups.get(base) ?? [];
    list.push(run);
    groups.set(base, list);
  }
  return groups;
}

interface SampleFailure {
  rule: Violation["rule"];
  message: string;
}

function checkSample(run: Run, rules: ContractRules): SampleFailure[] {
  const failures: SampleFailure[] = [];
  const called = run.toolCalls.map((t) => t.name);
  const calledSet = new Set(called);

  for (const tool of rules.must_call ?? []) {
    if (!calledSet.has(tool)) {
      failures.push({ rule: "must_call", message: `${tool} was never called` });
    }
  }
  for (const tool of rules.must_not_call ?? []) {
    if (calledSet.has(tool)) {
      const n = called.filter((t) => t === tool).length;
      failures.push({
        rule: "must_not_call",
        message: `${tool} was called${n > 1 ? ` ${n} times` : ""}`,
      });
    }
  }
  for (const [before, after] of rules.call_order ?? []) {
    const firstAfter = called.indexOf(after);
    if (firstAfter === -1) continue;
    const firstBefore = called.indexOf(before);
    if (firstBefore === -1 || firstBefore > firstAfter) {
      failures.push({
        rule: "call_order",
        message: `${after} ran before ${before}`,
      });
    }
  }

  const costUsd = run.llmCalls.reduce((t, c) => t + (c.cost_usd ?? 0), 0);
  if (rules.max_cost_usd !== undefined && costUsd > rules.max_cost_usd) {
    failures.push({
      rule: "max_cost_usd",
      message: `cost $${costUsd.toFixed(4)} is over the $${rules.max_cost_usd} budget`,
    });
  }
  const latencyMs =
    run.llmCalls.reduce((t, c) => t + (c.latency_ms ?? 0), 0) +
    run.toolCalls.reduce((t, c) => t + (c.latency_ms ?? 0), 0);
  if (rules.max_latency_ms !== undefined && latencyMs > rules.max_latency_ms) {
    failures.push({
      rule: "max_latency_ms",
      message: `latency ${Math.round(latencyMs)}ms is over the ${rules.max_latency_ms}ms budget`,
    });
  }
  if (rules.max_llm_calls !== undefined && run.llmCalls.length > rules.max_llm_calls) {
    failures.push({
      rule: "max_llm_calls",
      message: `${run.llmCalls.length} llm calls, budget is ${rules.max_llm_calls}`,
    });
  }
  if (rules.max_tool_calls !== undefined && run.toolCalls.length > rules.max_tool_calls) {
    failures.push({
      rule: "max_tool_calls",
      message: `${run.toolCalls.length} tool calls, budget is ${rules.max_tool_calls}`,
    });
  }

  const output = run.outputs.map((o) => o.content).join("\n").toLowerCase();
  for (const needle of rules.output_includes ?? []) {
    if (!output.includes(needle.toLowerCase())) {
      failures.push({ rule: "output_includes", message: `output does not mention "${needle}"` });
    }
  }
  for (const needle of rules.output_excludes ?? []) {
    if (output.includes(needle.toLowerCase())) {
      failures.push({ rule: "output_excludes", message: `output mentions "${needle}"` });
    }
  }

  if (rules.require_status !== undefined && run.status !== rules.require_status) {
    failures.push({
      rule: "require_status",
      message: `run ended with status ${run.status}, expected ${rules.require_status}`,
    });
  }
  if (rules.no_tool_errors) {
    const errored = run.toolCalls.filter((t) => t.error);
    if (errored.length) {
      failures.push({
        rule: "no_tool_errors",
        message: `${errored[0].name} errored: ${errored[0].error}`,
      });
    }
  }

  return failures;
}

function countRules(rules: ContractRules): number {
  let n = 0;
  n += (rules.must_call ?? []).length;
  n += (rules.must_not_call ?? []).length;
  n += (rules.call_order ?? []).length;
  n += (rules.output_includes ?? []).length;
  n += (rules.output_excludes ?? []).length;
  for (const key of ["max_cost_usd", "max_latency_ms", "max_llm_calls", "max_tool_calls", "require_status"] as const) {
    if (rules[key] !== undefined) n++;
  }
  if (rules.no_tool_errors) n++;
  return n;
}

export function checkTrace(
  runs: Map<string, Run>,
  contract: Contract,
  hash: string,
): CheckResult {
  const groups = groupSamples(runs);
  const violations: Violation[] = [];
  let rulesChecked = 0;

  const targets = new Map<string, ContractRules>();
  if (contract.runs && Object.keys(contract.runs).length) {
    for (const [name, rules] of Object.entries(contract.runs)) {
      targets.set(name, { ...contract.rules, ...rules });
    }
    // shared rules still apply to runs the contract does not name
    if (contract.rules && countRules(contract.rules)) {
      for (const name of groups.keys()) {
        if (!targets.has(name)) targets.set(name, contract.rules);
      }
    }
  } else {
    for (const name of groups.keys()) targets.set(name, contract.rules ?? {});
  }

  for (const [name, rules] of targets) {
    const samples = groups.get(name);
    rulesChecked += countRules(rules);
    if (!samples) {
      violations.push({
        run: name,
        rule: "run_missing",
        message: "run is in the contract but not in the trace",
      });
      continue;
    }
    const counts = new Map<string, { failure: SampleFailure; count: number }>();
    for (const sample of samples) {
      for (const failure of checkSample(sample, rules)) {
        const key = `${failure.rule}:${failure.message}`;
        const entry = counts.get(key) ?? { failure, count: 0 };
        entry.count++;
        counts.set(key, entry);
      }
    }
    for (const { failure, count } of counts.values()) {
      violations.push({
        run: name,
        rule: failure.rule,
        message: failure.message,
        rate: samples.length > 1 ? `${count}/${samples.length}` : undefined,
      });
    }
  }

  return {
    contract: { name: contract.name, hash },
    runs: [...targets.keys()],
    rulesChecked,
    violations,
    passed: violations.length === 0,
  };
}

/** build a starter contract from an observed trace */
export function generateContract(runs: Map<string, Run>, source: string): Contract {
  const groups = groupSamples(runs);
  const perRun: Record<string, ContractRules> = {};

  for (const [name, samples] of groups) {
    const rules: ContractRules = {};

    // tools that appear in every sample are treated as required
    let common: Set<string> | undefined;
    for (const sample of samples) {
      const tools = new Set(sample.toolCalls.map((t) => t.name));
      common = common ? new Set([...common].filter((t) => tools.has(t))) : tools;
    }
    if (common?.size) rules.must_call = [...common].sort();

    const costs = samples.map((s) => s.llmCalls.reduce((t, c) => t + (c.cost_usd ?? 0), 0));
    const maxCost = Math.max(...costs);
    if (maxCost > 0) rules.max_cost_usd = Number((maxCost * 1.5).toFixed(4));

    const latencies = samples.map(
      (s) =>
        s.llmCalls.reduce((t, c) => t + (c.latency_ms ?? 0), 0) +
        s.toolCalls.reduce((t, c) => t + (c.latency_ms ?? 0), 0),
    );
    const maxLatency = Math.max(...latencies);
    if (maxLatency > 0) rules.max_latency_ms = Math.ceil(maxLatency * 1.5);

    const maxTools = Math.max(...samples.map((s) => s.toolCalls.length));
    if (maxTools > 0) rules.max_tool_calls = Math.ceil(maxTools * 1.5);

    if (samples.every((s) => s.status === "ok")) rules.require_status = "ok";
    if (samples.every((s) => s.toolCalls.every((t) => !t.error))) rules.no_tool_errors = true;

    perRun[name] = rules;
  }

  return {
    name: `generated from ${source}`,
    runs: perRun,
  };
}

export function renderCheckTerminal(result: CheckResult): string {
  const lines: string[] = [];
  lines.push("");
  const label = result.contract.name ? `${result.contract.name} ` : "";
  lines.push(pc.dim(`contract ${label}(${result.contract.hash})`));
  lines.push("");

  const byRun = new Map<string, Violation[]>();
  for (const v of result.violations) {
    const list = byRun.get(v.run) ?? [];
    list.push(v);
    byRun.set(v.run, list);
  }

  for (const run of result.runs) {
    const violations = byRun.get(run) ?? [];
    const badge = violations.length
      ? pc.bgRed(pc.white(" VIOLATED "))
      : pc.bgGreen(pc.black(" HOLDS "));
    lines.push(`${badge} ${pc.bold(run)}`);
    for (const v of violations) {
      const rate = v.rate ? pc.dim(` (${v.rate} samples)`) : "";
      lines.push(pc.red(`  x ${v.rule}: ${v.message}`) + rate);
    }
    lines.push("");
  }

  lines.push(
    result.passed
      ? pc.green(`contract holds. ${result.rulesChecked} rules over ${result.runs.length} run${result.runs.length === 1 ? "" : "s"}.`)
      : pc.red(`${result.violations.length} violation${result.violations.length === 1 ? "" : "s"}.`),
  );
  lines.push("");
  return lines.join("\n");
}

export function renderCheckMarkdown(result: CheckResult): string {
  const lines: string[] = [];
  lines.push("## whatbroke contract check");
  lines.push("");
  const label = result.contract.name ? `\`${result.contract.name}\` ` : "";
  lines.push(`Contract ${label}(hash \`${result.contract.hash}\`)`);
  lines.push("");
  if (result.passed) {
    lines.push(`Contract holds: ${result.rulesChecked} rules over ${result.runs.length} run${result.runs.length === 1 ? "" : "s"}.`);
    lines.push("");
    return lines.join("\n");
  }
  for (const run of result.runs) {
    const violations = result.violations.filter((v) => v.run === run);
    if (!violations.length) continue;
    lines.push(`### ${run}`);
    lines.push("");
    for (const v of violations) {
      const rate = v.rate ? ` (${v.rate} samples)` : "";
      lines.push(`- **VIOLATED** ${v.rule}: ${v.message}${rate}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
