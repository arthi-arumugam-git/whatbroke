import { describe, expect, it } from "vitest";
import { diffTraces } from "../src/diff.js";
import { parseTrace } from "../src/parse.js";

function trace(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const baseRun = (run: string, model: string) => [
  { type: "run_start", run, meta: { model } },
  { type: "llm_call", run, model, latency_ms: 800, tokens: { input: 500, output: 100 }, cost_usd: 0.01 },
  { type: "tool_call", run, name: "lookup_order", args: { order_id: "A-1042" } },
  { type: "tool_call", run, name: "issue_refund", args: { order_id: "A-1042", amount: 42 } },
  { type: "output", run, content: "Refund issued." },
  { type: "run_end", run, status: "ok" },
];

describe("parseTrace", () => {
  it("groups events into runs", () => {
    const runs = parseTrace(trace(baseRun("refund", "gpt-4o")));
    expect(runs.size).toBe(1);
    const run = runs.get("refund")!;
    expect(run.toolCalls).toHaveLength(2);
    expect(run.llmCalls).toHaveLength(1);
    expect(run.status).toBe("ok");
  });

  it("rejects invalid JSON with a line number", () => {
    expect(() => parseTrace('{"type":"run_start","run":"a"}\nnot json')).toThrow("line 2");
  });

  it("treats runs without run_end as ok", () => {
    const runs = parseTrace(trace([{ type: "output", run: "a", content: "hi" }]));
    expect(runs.get("a")!.status).toBe("ok");
  });

  it("skips unknown event types", () => {
    const runs = parseTrace(trace([{ type: "future_thing", run: "a" }, { type: "output", run: "a", content: "x" }]));
    expect(runs.get("a")!.outputs).toHaveLength(1);
  });
});

describe("diffTraces", () => {
  it("reports nothing when identical", () => {
    const a = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const b = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const result = diffTraces(a, b);
    expect(result.breaking).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it("flags a dropped tool call as breaking", () => {
    const a = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const after = baseRun("refund", "gpt-4o").filter(
      (e: any) => !(e.type === "tool_call" && e.name === "issue_refund"),
    );
    const b = parseTrace(trace(after));
    const result = diffTraces(a, b);
    expect(result.breaking).toBe(1);
    expect(result.findings.some((f) => f.kind === "tool_removed")).toBe(true);
  });

  it("flags changed tool args as warning with before/after detail", () => {
    const after = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "tool_call" && e.name === "issue_refund"
        ? { ...e, args: { order_id: "A-1042", amount: 4200 } }
        : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(after)),
    );
    const finding = result.findings.find((f) => f.kind === "tool_args_changed");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.detail?.before).toEqual({ amount: 42 });
    expect(finding!.detail?.after).toEqual({ amount: 4200 });
  });

  it("flags ok -> error as breaking", () => {
    const after = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "run_end" ? { ...e, status: "error", error: "boom" } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(after)),
    );
    expect(result.findings.some((f) => f.kind === "status_changed" && f.severity === "breaking")).toBe(true);
  });

  it("flags a missing run as breaking", () => {
    const a = parseTrace(trace([...baseRun("refund", "gpt-4o"), ...baseRun("cancel", "gpt-4o")]));
    const b = parseTrace(trace(baseRun("refund", "gpt-4o")));
    const result = diffTraces(a, b);
    expect(result.findings.some((f) => f.kind === "run_missing" && f.run === "cancel")).toBe(true);
  });

  it("flags tool reordering", () => {
    const reordered = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "issue_refund", args: {} },
      { type: "tool_call", run: "r", name: "lookup_order", args: {} },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const original = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "lookup_order", args: {} },
      { type: "tool_call", run: "r", name: "issue_refund", args: {} },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const result = diffTraces(parseTrace(trace(original)), parseTrace(trace(reordered)), {
      compareOutputs: false,
    });
    expect(result.findings.some((f) => f.kind === "tool_reordered")).toBe(true);
  });

  it("flags latency regressions above the threshold", () => {
    const slow = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "llm_call" ? { ...e, latency_ms: 3000 } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(slow)),
    );
    expect(result.findings.some((f) => f.kind === "latency_regression")).toBe(true);
  });

  it("stays quiet on latency below the threshold", () => {
    const slightlySlow = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "llm_call" ? { ...e, latency_ms: 1000 } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(slightlySlow)),
    );
    expect(result.findings.some((f) => f.kind === "latency_regression")).toBe(false);
  });

  it("flags output changes as warning", () => {
    const changed = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "output" ? { ...e, content: "I cannot help with refunds." } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(changed)),
    );
    expect(result.findings.some((f) => f.kind === "output_changed")).toBe(true);
  });

  it("flags changed tool results as one warning with before/after detail", () => {
    const withResult = (result: string) => [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "get_weather", args: { city: "Paris" }, result },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(
      parseTrace(trace(withResult("14C, rain"))),
      parseTrace(trace(withResult("9C, clear"))),
      { compareOutputs: false },
    );
    const findings = diff.findings.filter((f) => f.kind === "tool_result_changed");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].subject).toBe("tool_result:get_weather");
    expect(findings[0].message).toBe("get_weather returned a different result");
    expect(findings[0].detail?.before).toBe("14C, rain");
    expect(findings[0].detail?.after).toBe("9C, clear");
  });

  it("stays quiet on identical tool results", () => {
    const events = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "get_weather", args: {}, result: "14C, rain" },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(parseTrace(trace(events)), parseTrace(trace(events)), {
      compareOutputs: false,
    });
    expect(diff.findings.some((f) => f.kind === "tool_result_changed")).toBe(false);
  });

  it("stays quiet when only one side recorded a tool result", () => {
    const withResult = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "get_weather", args: {}, result: "14C, rain" },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const withoutResult = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "get_weather", args: {} },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(parseTrace(trace(withResult)), parseTrace(trace(withoutResult)), {
      compareOutputs: false,
    });
    expect(diff.findings.some((f) => f.kind === "tool_result_changed")).toBe(false);
  });

  it("flags new tool errors as breaking", () => {
    const erroring = baseRun("refund", "gpt-4o").map((e: any) =>
      e.type === "tool_call" && e.name === "issue_refund" ? { ...e, error: "422 unprocessable" } : e,
    );
    const result = diffTraces(
      parseTrace(trace(baseRun("refund", "gpt-4o"))),
      parseTrace(trace(erroring)),
    );
    expect(result.findings.some((f) => f.kind === "tool_error" && f.severity === "breaking")).toBe(true);
  });
});

// The prompt is the first thing anyone checks when an agent's behavior moves, so a diff that
// stays silent about it makes the user go and find it by hand. These cover the capture, the
// attribution, and the cases where claiming a cause would be a guess.
describe("prompt diffing", () => {
  const withPrompt = (run: string, prompt: string, output: string) => [
    { type: "run_start", run },
    { type: "llm_call", run, model: "gpt-4o", prompt, tokens: { input: 500, output: 100 } },
    { type: "tool_call", run, name: "lookup_order", args: { order_id: "A-1042" } },
    { type: "output", run, content: output },
    { type: "run_end", run, status: "ok" },
  ];

  it("flags a changed prompt and shows both sides", () => {
    const diff = diffTraces(
      parseTrace(trace(withPrompt("r", "You are terse.", "ok"))),
      parseTrace(trace(withPrompt("r", "You are verbose.", "ok"))),
    );
    const f = diff.findings.find((x) => x.kind === "prompt_changed");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.subject).toBe("prompt");
    expect(f!.detail?.before).toBe("You are terse.");
    expect(f!.detail?.after).toBe("You are verbose.");
  });

  it("stays quiet when the prompt is unchanged", () => {
    const events = withPrompt("r", "You are terse.", "ok");
    const diff = diffTraces(parseTrace(trace(events)), parseTrace(trace(events)));
    expect(diff.findings.some((f) => f.kind === "prompt_changed")).toBe(false);
  });

  // The point Caleb made: users already suspect the prompt. The value is saying which
  // downstream changes it plausibly explains, so the finding reads as a cause not a checkbox.
  it("names what the prompt change plausibly explains", () => {
    const diff = diffTraces(
      parseTrace(trace(withPrompt("r", "You are terse.", "Refund issued."))),
      parseTrace(trace(withPrompt("r", "You are verbose.", "I have issued your refund."))),
    );
    const f = diff.findings.find((x) => x.kind === "prompt_changed")!;
    expect(f.detail?.explains).toEqual(["output"]);
    expect(f.message).toContain("output");
  });

  it("reports the prompt change before the effects it explains", () => {
    const diff = diffTraces(
      parseTrace(trace(withPrompt("r", "You are terse.", "Refund issued."))),
      parseTrace(trace(withPrompt("r", "You are verbose.", "I have issued your refund."))),
    );
    const kinds = diff.runs[0].findings.map((f) => f.kind);
    expect(kinds.indexOf("prompt_changed")).toBeLessThan(kinds.indexOf("output_changed"));
  });

  // Claiming causation with nothing downstream to explain would be overreach.
  it("does not claim to explain anything when nothing else changed", () => {
    const diff = diffTraces(
      parseTrace(trace(withPrompt("r", "You are terse.", "ok"))),
      parseTrace(trace(withPrompt("r", "You are verbose.", "ok"))),
    );
    const f = diff.findings.find((x) => x.kind === "prompt_changed")!;
    expect(f.detail?.explains).toBeUndefined();
    expect(f.message).toBe("prompt changed");
  });

  // A trace that never captured prompts must not read as "the prompt did not change".
  it("stays quiet when only one side captured a prompt", () => {
    const diff = diffTraces(
      parseTrace(trace(withPrompt("r", "You are terse.", "ok"))),
      parseTrace(
        trace([
          { type: "run_start", run: "r" },
          { type: "llm_call", run: "r", model: "gpt-4o", tokens: { input: 500, output: 100 } },
          { type: "tool_call", run: "r", name: "lookup_order", args: { order_id: "A-1042" } },
          { type: "output", run: "r", content: "ok" },
          { type: "run_end", run: "r", status: "ok" },
        ]),
      ),
    );
    expect(diff.findings.some((f) => f.kind === "prompt_changed")).toBe(false);
  });

  it("attributes per llm call when a run has several", () => {
    const two = (a: string, b: string) => [
      { type: "run_start", run: "r" },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: a },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: b },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(
      parseTrace(trace(two("plan step", "write step"))),
      parseTrace(trace(two("plan step", "write it differently"))),
    );
    const found = diff.findings.filter((f) => f.kind === "prompt_changed");
    expect(found).toHaveLength(1);
    expect(found[0].detail?.call).toBe(2);
  });

  it("reports a prompt that became empty", () => {
    const diff = diffTraces(
      parseTrace(trace(withPrompt("r", "You are terse.", "ok"))),
      parseTrace(trace(withPrompt("r", "", "ok"))),
    );
    const f = diff.findings.find((x) => x.kind === "prompt_changed");
    expect(f).toBeDefined();
    expect(f!.detail?.before).toBe("You are terse.");
    expect(f!.detail?.after).toBe("");
  });
});

// The failure mode these guard is the report claiming "prompt changed" while printing two
// lines that look the same, which reads as a bug in the tool rather than a change in the
// prompt. Either the two sides shown must differ, or the message must say why they cannot.
describe("prompt diffs a reader can act on", () => {
  const promptRun = (prompt: string) => [
    { type: "run_start", run: "r" },
    { type: "llm_call", run: "r", model: "gpt-4o", prompt },
    { type: "run_end", run: "r", status: "ok" },
  ];

  const promptFinding = (before: string, after: string) => {
    const diff = diffTraces(parseTrace(trace(promptRun(before))), parseTrace(trace(promptRun(after))));
    return diff.findings.find((f) => f.kind === "prompt_changed");
  };

  it("names a whitespace-only difference", () => {
    const f = promptFinding("You are terse.", "You are terse. ")!;
    expect(f).toBeDefined();
    expect(f.message).toContain("whitespace only");
  });

  it("counts a moved line break as whitespace only", () => {
    const f = promptFinding("Be terse.\nAnswer in English.", "Be terse. Answer in English.")!;
    expect(f.message).toContain("whitespace only");
  });

  // prompts are nearly always multi-line, and a raw newline in the excerpt would print the
  // rest of the prompt with no - or + in front of it
  it("keeps each side of a multi-line prompt on one line", () => {
    const f = promptFinding("Be terse.\nAnswer in English.", "Be terse.\nAnswer in French.")!;
    expect(String(f.detail?.before)).not.toContain("\n");
    expect(String(f.detail?.before)).toContain("\\n");
    expect(String(f.detail?.after)).toContain("Answer in French.");
  });

  // A call that appeared upstream shifts every prompt after it. The pairing has to survive
  // that, and when a prompt still moved position the finding has to say which baseline call
  // it came from rather than let the reader assume the step is the same one.
  it("names the baseline call when a prompt moved position", () => {
    const one = [
      { type: "run_start", run: "r" },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: "plan the refund for A-1042" },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const two = [
      { type: "run_start", run: "r" },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: "check the returns policy" },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: "plan the refund for A-2077" },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(parseTrace(trace(one)), parseTrace(trace(two)));
    const f = diff.findings.find((x) => x.kind === "prompt_changed")!;
    expect(f.message).toContain("baseline call 1 is now call 2");
    expect(f.detail?.call).toBe(2);
    expect(f.detail?.baselineCall).toBe(1);
  });

  it("stays quiet about the count when both runs made the same number of calls", () => {
    const f = promptFinding("Be terse.", "Be verbose.")!;
    expect(f.message).toBe("prompt changed");
  });

  it("names a unicode normalisation difference", () => {
    // the same word in NFC and NFD: identical on screen, different bytes
    const f = promptFinding("Répondez en café.".normalize("NFC"), "Répondez en café.".normalize("NFD"))!;
    expect(f).toBeDefined();
    expect(f.message).toContain("unicode normalisation only");
  });

  it("treats genuinely different unicode text as an ordinary prompt change", () => {
    const f = promptFinding("Answer in English.", "Répondez en français. 🙂")!;
    expect(f.message).toBe("prompt changed");
    expect(f.detail?.after).toContain("🙂");
  });

  it("does not call a real edit whitespace only", () => {
    const f = promptFinding("Refund without asking.", "Always confirm before refunding.")!;
    expect(f.message).toBe("prompt changed");
  });

  // A system prompt is usually thousands of characters and the edit is rarely at the top, so
  // showing the head of each side would print two identical lines.
  it("shows the part that differs in a long prompt, not the head", () => {
    const head = "You are a refund agent. ".repeat(40);
    const f = promptFinding(`${head}Refund without asking.`, `${head}Always confirm first.`)!;
    expect(f.detail?.before).not.toBe(f.detail?.after);
    expect(String(f.detail?.before)).toContain("Refund without asking.");
    expect(String(f.detail?.after)).toContain("Always confirm first.");
  });

  it("keeps the excerpt short enough to read", () => {
    const head = "You are a refund agent. ".repeat(40);
    const tail = " Then thank the customer.".repeat(40);
    const f = promptFinding(`${head}Refund without asking.${tail}`, `${head}Always confirm first.${tail}`)!;
    expect(String(f.detail?.before).length).toBeLessThanOrEqual(200);
    expect(String(f.detail?.after).length).toBeLessThanOrEqual(200);
  });
});

// The other half of the same problem. A node that appeared, vanished or swapped model used to
// show up only as a number moving in the stat line, which is the shape of defect nobody
// notices. These cover the finding itself and the pairing it decides: an inserted call shifts
// every prompt after it, and a diff that mispairs there invents a run of changes that never
// happened.
describe("structure diffing over llm calls", () => {
  const callRun = (prompts: Array<string | undefined>, extra: Record<string, unknown> = {}) => [
    { type: "run_start", run: "r" },
    ...prompts.map((prompt) =>
      prompt === undefined
        ? { type: "llm_call", run: "r", model: "gpt-4o", ...extra }
        : { type: "llm_call", run: "r", model: "gpt-4o", prompt, ...extra },
    ),
    { type: "run_end", run: "r", status: "ok" },
  ];

  const structureDiff = (
    beforePrompts: Array<string | undefined>,
    afterPrompts: Array<string | undefined>,
    extra: Record<string, unknown> = {},
  ) =>
    diffTraces(
      parseTrace(trace(callRun(beforePrompts, extra))),
      parseTrace(trace(callRun(afterPrompts, extra))),
      { compareOutputs: false },
    );

  const CLASSIFY = "system: classify the support ticket";
  const DRAFT = "system: draft a reply to the customer";
  const FRAUD = "system: check the account against the fraud rules";

  it("flags a new llm call instead of moving a count", () => {
    const diff = structureDiff([CLASSIFY, DRAFT], [CLASSIFY, FRAUD, DRAFT]);
    const f = diff.findings.find((x) => x.kind === "llm_call_added");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.message).toContain("position 2 of 3");
    expect(String(f!.detail?.after)).toContain("fraud rules");
  });

  it("flags a dropped llm call", () => {
    const diff = structureDiff([CLASSIFY, FRAUD, DRAFT], [CLASSIFY, DRAFT]);
    const f = diff.findings.find((x) => x.kind === "llm_call_removed");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.message).toContain("position 2 of 3");
    expect(String(f!.detail?.before)).toContain("fraud rules");
  });

  // The defect this feature could most easily have shipped: pair by index, gain a call at the
  // front, and every prompt after it reads as edited.
  it("does not invent prompt changes downstream of an inserted call", () => {
    const diff = structureDiff([CLASSIFY, DRAFT], [FRAUD, CLASSIFY, DRAFT]);
    expect(diff.findings.filter((f) => f.kind === "prompt_changed")).toHaveLength(0);
    const added = diff.findings.filter((f) => f.kind === "llm_call_added");
    expect(added).toHaveLength(1);
    expect(added[0].message).toContain("position 1 of 3");
  });

  it("does not invent prompt changes upstream of a dropped call", () => {
    const diff = structureDiff([CLASSIFY, FRAUD, DRAFT], [CLASSIFY, FRAUD]);
    expect(diff.findings.filter((f) => f.kind === "prompt_changed")).toHaveLength(0);
    expect(diff.findings.filter((f) => f.kind === "llm_call_removed")).toHaveLength(1);
  });

  // "of N" is the number of calls the run made, not the number of findings printed.
  it("counts every call in the run, not the ones it reported on", () => {
    const diff = structureDiff([CLASSIFY], [CLASSIFY, FRAUD, DRAFT]);
    const added = diff.findings.filter((f) => f.kind === "llm_call_added");
    expect(added).toHaveLength(2);
    expect(added.map((f) => f.detail?.of)).toEqual([3, 3]);
    for (const f of added) expect(f.message).toContain(" of 3");
  });

  // A rewrite at the same step is an edit, not a node swapped for another node.
  it("keeps a rewritten prompt as one changed call, not a drop and an add", () => {
    const diff = structureDiff([CLASSIFY, DRAFT], [CLASSIFY, "system: answer in one sentence"]);
    expect(diff.findings.filter((f) => f.kind === "prompt_changed")).toHaveLength(1);
    expect(diff.findings.some((f) => f.kind === "llm_call_added")).toBe(false);
    expect(diff.findings.some((f) => f.kind === "llm_call_removed")).toBe(false);
  });

  it("stays quiet when both runs made the same calls", () => {
    const diff = structureDiff([CLASSIFY, DRAFT], [CLASSIFY, DRAFT]);
    expect(diff.findings).toHaveLength(0);
  });

  // A trace with no llm calls in it has not told us the agent stopped calling the model, it
  // has told us nothing. Reporting every call as dropped would be the importer's gap read as
  // the agent's behavior.
  it("stays silent when one side captured no llm calls at all", () => {
    const withCalls = callRun([CLASSIFY, DRAFT]);
    const withoutCalls = [
      { type: "run_start", run: "r" },
      { type: "tool_call", run: "r", name: "lookup_order", args: {} },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const dropped = diffTraces(parseTrace(trace(withCalls)), parseTrace(trace(withoutCalls)), {
      compareOutputs: false,
    });
    expect(dropped.findings.some((f) => f.kind === "llm_call_removed")).toBe(false);
    const gained = diffTraces(parseTrace(trace(withoutCalls)), parseTrace(trace(withCalls)), {
      compareOutputs: false,
    });
    expect(gained.findings.some((f) => f.kind === "llm_call_added")).toBe(false);
  });

  // With no prompts on either side the aligner has only the model to go on, so the position
  // it prints is the order the calls arrived in. That is a weaker claim and says so.
  it("says the position is the arrival order when no prompts were captured", () => {
    const diff = structureDiff([undefined, undefined], [undefined, undefined, undefined]);
    const f = diff.findings.find((x) => x.kind === "llm_call_added")!;
    expect(f.message).toContain("position 3 of 3");
    expect(f.message).toContain("matched by position: the trace did not capture prompts");
    expect(f.detail?.after).toBeUndefined();
  });

  it("does not hedge the position when both sides captured prompts", () => {
    const diff = structureDiff([CLASSIFY], [CLASSIFY, DRAFT]);
    const f = diff.findings.find((x) => x.kind === "llm_call_added")!;
    expect(f.message).not.toContain("matched by position");
  });

  // A new call brings its own cost, latency and tokens with it, which a prompt edit does not.
  it("names the cost and latency a new call accounts for", () => {
    const meter = { latency_ms: 900, tokens: { input: 500, output: 100 }, cost_usd: 0.01 };
    const diff = structureDiff([CLASSIFY], [CLASSIFY, FRAUD, DRAFT], meter);
    const f = diff.findings.find((x) => x.kind === "llm_call_added")!;
    expect(f.detail?.explains).toContain("cost");
    expect(f.detail?.explains).toContain("latency");
    expect(f.message).toContain("plausibly explains");
  });

  // A new call on a model the run did not use before is why the model list moved.
  it("names the model change when the new call is the one that brought the model", () => {
    const one = [
      { type: "run_start", run: "r" },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: CLASSIFY },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const two = [
      { type: "run_start", run: "r" },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: CLASSIFY },
      { type: "llm_call", run: "r", model: "gpt-4o-mini", prompt: FRAUD },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(parseTrace(trace(one)), parseTrace(trace(two)), {
      compareOutputs: false,
    });
    const f = diff.findings.find((x) => x.kind === "llm_call_added")!;
    expect(f.detail?.explains).toContain("model");
  });

  // A run that swapped every call to a new model moved that list on its own. Blaming the
  // dropped call for it would be a cause the trace does not support.
  it("does not blame a dropped call for a model swap the whole run made", () => {
    const models = (model: string, prompts: string[]) => [
      { type: "run_start", run: "r" },
      ...prompts.map((prompt) => ({ type: "llm_call", run: "r", model, prompt })),
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(
      parseTrace(trace(models("gpt-4o", [CLASSIFY, FRAUD, DRAFT]))),
      parseTrace(trace(models("gpt-5-mini", [CLASSIFY, DRAFT]))),
      { compareOutputs: false },
    );
    const f = diff.findings.find((x) => x.kind === "llm_call_removed")!;
    expect(f.detail?.explains ?? []).not.toContain("model");
    expect(diff.findings.some((x) => x.kind === "model_changed")).toBe(true);
  });

  it("reports the new call above the cost and latency it explains", () => {
    const meter = { latency_ms: 900, tokens: { input: 500, output: 100 }, cost_usd: 0.01 };
    const diff = structureDiff([CLASSIFY], [CLASSIFY, FRAUD], meter);
    const kinds = diff.runs[0].findings.map((f) => f.kind);
    expect(kinds.indexOf("llm_call_added")).toBeLessThan(kinds.indexOf("cost_increase"));
    expect(kinds.indexOf("llm_call_added")).toBeLessThan(kinds.indexOf("latency_regression"));
  });

  it("reports the structural change above the prompt change it reframes", () => {
    const diff = structureDiff([CLASSIFY, DRAFT], [CLASSIFY, FRAUD, "system: draft a reply now"]);
    const kinds = diff.runs[0].findings.map((f) => f.kind);
    expect(kinds.indexOf("llm_call_added")).toBeLessThan(kinds.indexOf("prompt_changed"));
  });

  it("names the call that swapped model", () => {
    const two = (secondModel: string) => [
      { type: "run_start", run: "r" },
      { type: "llm_call", run: "r", model: "gpt-4o", prompt: CLASSIFY },
      { type: "llm_call", run: "r", model: secondModel, prompt: DRAFT },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(parseTrace(trace(two("gpt-4o"))), parseTrace(trace(two("gpt-4o-mini"))), {
      compareOutputs: false,
    });
    const f = diff.findings.find((x) => x.kind === "llm_call_changed");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.message).toContain("llm call 2 of 2");
    expect(f!.detail?.before).toBe("gpt-4o");
    expect(f!.detail?.after).toBe("gpt-4o-mini");
  });

  // A run that swapped model everywhere is already one finding. Repeating it per call would
  // turn one fact into several and say nothing more.
  it("does not repeat a run-wide model swap once per call", () => {
    const two = (model: string) => [
      { type: "run_start", run: "r" },
      { type: "llm_call", run: "r", model, prompt: CLASSIFY },
      { type: "llm_call", run: "r", model, prompt: DRAFT },
      { type: "run_end", run: "r", status: "ok" },
    ];
    const diff = diffTraces(parseTrace(trace(two("gpt-4o"))), parseTrace(trace(two("gpt-5-mini"))), {
      compareOutputs: false,
    });
    expect(diff.findings.some((f) => f.kind === "llm_call_changed")).toBe(false);
    expect(diff.findings.some((f) => f.kind === "model_changed")).toBe(true);
  });
});

// Real system prompts in one agent share most of their text: the same preamble, the same tool
// list, a different instruction at the end. An aligner that matched on similarity alone could
// pair the wrong ones and report the whole tail as edited, so identical text anchors first.
describe("aligning llm calls that look alike", () => {
  const PREAMBLE =
    "You are a support agent for an online store. Be brief, never invent order numbers, " +
    "and use the tools you are given rather than answering from memory. ";
  const step = (instruction: string) => `${PREAMBLE}${instruction}`;
  const STEPS = [
    "Classify the ticket.",
    "Look up the order.",
    "Decide whether the refund is allowed.",
    "Write the reply.",
  ];

  const run = (prompts: string[]) => [
    { type: "run_start", run: "r" },
    ...prompts.map((prompt) => ({ type: "llm_call", run: "r", model: "gpt-4o", prompt })),
    { type: "run_end", run: "r", status: "ok" },
  ];

  it("reports one new call, not a tail of edits, when a near-identical step is inserted", () => {
    const before = STEPS.map(step);
    const after = [
      ...before.slice(0, 2),
      step("Check the account against the fraud rules."),
      ...before.slice(2),
    ];
    const diff = diffTraces(parseTrace(trace(run(before))), parseTrace(trace(run(after))), {
      compareOutputs: false,
    });
    expect(diff.findings.filter((f) => f.kind === "prompt_changed")).toHaveLength(0);
    const added = diff.findings.filter((f) => f.kind === "llm_call_added");
    expect(added).toHaveLength(1);
    expect(added[0].message).toContain("position 3 of 5");
  });

  it("reports one edit and one new call when a step was both inserted and reworded", () => {
    const before = STEPS.map(step);
    const after = [
      ...before.slice(0, 2),
      step("Check the account against the fraud rules."),
      step("Decide whether the refund is allowed, and refuse if the order is over 30 days old."),
      ...before.slice(3),
    ];
    const diff = diffTraces(parseTrace(trace(run(before))), parseTrace(trace(run(after))), {
      compareOutputs: false,
    });
    const changed = diff.findings.filter((f) => f.kind === "prompt_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].detail?.baselineCall).toBe(3);
    expect(changed[0].detail?.call).toBe(4);
    expect(diff.findings.filter((f) => f.kind === "llm_call_added")).toHaveLength(1);
  });

  // An agent that loops makes the same call several times. One extra turn is one new call.
  it("reports one new call when a loop ran an extra turn", () => {
    const turn = step("Take the next step.");
    const diff = diffTraces(
      parseTrace(trace(run([turn, turn, turn]))),
      parseTrace(trace(run([turn, turn, turn, turn]))),
      { compareOutputs: false },
    );
    expect(diff.findings.filter((f) => f.kind === "prompt_changed")).toHaveLength(0);
    expect(diff.findings.filter((f) => f.kind === "llm_call_added")).toHaveLength(1);
  });
});
