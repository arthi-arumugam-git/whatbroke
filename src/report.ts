import pc from "picocolors";
import { fmtMs } from "./diff.js";
import type { DiffResult, Finding, RunDiff, Severity } from "./types.js";

const ICONS: Record<Severity, string> = {
  breaking: "x",
  warning: "!",
  info: "i",
};

function color(severity: Severity, text: string): string {
  if (severity === "breaking") return pc.red(text);
  if (severity === "warning") return pc.yellow(text);
  return pc.dim(text);
}

function statLine(diff: RunDiff): string | null {
  const b = diff.before;
  const a = diff.after;
  if (!b || !a) return null;
  const parts: string[] = [];
  parts.push(`${b.toolCalls} -> ${a.toolCalls} tool calls`);
  parts.push(`${b.llmCalls} -> ${a.llmCalls} llm calls`);
  if (b.latencyMs || a.latencyMs) parts.push(`${fmtMs(b.latencyMs)} -> ${fmtMs(a.latencyMs)}`);
  if (b.costUsd || a.costUsd)
    parts.push(`$${b.costUsd.toFixed(4)} -> $${a.costUsd.toFixed(4)}`);
  return parts.join("  ·  ");
}

export function renderTerminal(result: DiffResult): string {
  const lines: string[] = [];
  lines.push("");

  for (const run of result.runs) {
    const worst = worstSeverity(run.findings);
    const badge =
      worst === "breaking"
        ? pc.bgRed(pc.white(" BROKE "))
        : worst === "warning"
          ? pc.bgYellow(pc.black(" CHANGED "))
          : run.findings.length
            ? pc.bgBlue(pc.white(" INFO "))
            : pc.bgGreen(pc.black(" OK "));
    lines.push(`${badge} ${pc.bold(run.run)}`);

    const stat = statLine(run);
    if (stat) lines.push(pc.dim(`  ${stat}`));

    for (const f of run.findings) {
      lines.push(color(f.severity, `  ${ICONS[f.severity]} ${f.message}${annotation(f)}`));
      if (f.detail?.before !== undefined || f.detail?.after !== undefined) {
        if (f.detail.before !== undefined)
          lines.push(pc.red(`      - ${compact(f.detail.before)}`));
        if (f.detail.after !== undefined)
          lines.push(pc.green(`      + ${compact(f.detail.after)}`));
      }
    }
    lines.push("");
  }

  lines.push(summaryLine(result));
  lines.push("");
  return lines.join("\n");
}

export function renderMarkdown(result: DiffResult): string {
  const lines: string[] = [];
  lines.push("## whatbroke report");
  lines.push("");
  lines.push(summaryPlain(result));
  lines.push("");
  for (const run of result.runs) {
    if (!run.findings.length) continue;
    lines.push(`### ${run.run}`);
    lines.push("");
    for (const f of run.findings) {
      const tag = f.severity === "breaking" ? "**BROKE**" : f.severity === "warning" ? "changed" : "info";
      lines.push(`- ${tag}: ${f.message}${annotationPlain(f)}`);
      if (f.detail?.before !== undefined) lines.push(`  - before: \`${compact(f.detail.before)}\``);
      if (f.detail?.after !== undefined) lines.push(`  - after: \`${compact(f.detail.after)}\``);
    }
    lines.push("");
  }
  if (result.runs.every((r) => !r.findings.length)) {
    lines.push("No behavioral changes detected.");
    lines.push("");
  }
  return lines.join("\n");
}

function annotationPlain(f: Finding): string {
  if (!f.rate) return "";
  return f.flaky
    ? ` (${f.rate} run pairs, also flaps in the baseline)`
    : ` (${f.rate} run pairs)`;
}

function annotation(f: Finding): string {
  const plain = annotationPlain(f);
  return plain ? pc.dim(plain) : "";
}

function worstSeverity(findings: Finding[]): Severity | null {
  if (findings.some((f) => f.severity === "breaking")) return "breaking";
  if (findings.some((f) => f.severity === "warning")) return "warning";
  if (findings.length) return "info";
  return null;
}

function compact(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

function summaryPlain(result: DiffResult): string {
  if (!result.breaking && !result.warnings && !result.info) {
    return "No behavioral changes detected.";
  }
  const parts: string[] = [];
  if (result.breaking) parts.push(`${result.breaking} breaking`);
  if (result.warnings) parts.push(`${result.warnings} changed`);
  if (result.info) parts.push(`${result.info} info`);
  return parts.join(", ");
}

function summaryLine(result: DiffResult): string {
  if (!result.breaking && !result.warnings && !result.info) {
    return pc.green("nothing broke.");
  }
  const parts: string[] = [];
  if (result.breaking) parts.push(pc.red(`${result.breaking} breaking`));
  if (result.warnings) parts.push(pc.yellow(`${result.warnings} changed`));
  if (result.info) parts.push(pc.dim(`${result.info} info`));
  return parts.join(pc.dim("  ·  "));
}
