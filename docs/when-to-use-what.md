# When to use what

"How do I know what my agent change broke?" is one question with at least five different tool categories claiming to answer it: eval harnesses, testing frameworks, observability platforms, combined eval-plus-observability platforms, and behavioral diff tools. Most of them are answering a different question than the one you asked. This page says plainly what each one is actually for, and when you should use it instead of whatbroke. All of these are good tools. Several of them belong in your stack alongside this one.

## promptfoo

An eval and red-teaming harness. You define test cases and assertions in YAML, and it runs them across prompts and models, producing a matrix view for side by side comparison. Since March 2026 it is part of OpenAI, with a stated commitment to keep the open source project going; its center of gravity is security testing and red-teaming.

Use promptfoo instead of whatbroke when you want to assert that outputs meet criteria you can write down, or when you need adversarial testing (jailbreaks, prompt injection). whatbroke has no assertions and no security scanning. promptfoo's comparison view is prompt-and-output focused; it does not diff tool-call sequences between recorded agent runs.

## LangSmith

The observability, eval, and deployment platform from the LangChain team. Deep tracing for agent frameworks and OpenTelemetry, online LLM-as-judge evals, pairwise comparison of two agent versions against a dataset, and hosted agent deployment. Consumption pricing with a free dev tier; it is a hosted product, and traces live on their servers.

Use LangSmith instead of whatbroke when you need production monitoring, when you are already on LangChain or LangGraph, or when you want judged A/B comparisons with human review queues. Its comparisons score versions against each other; whatbroke instead reports the mechanical delta (calls dropped, args changed, order changed) with no judging involved.

## Langfuse

Open source LLM engineering platform: tracing, prompt management with versioning, and evals with datasets and experiments. Self-hosting is free (MIT core), cloud starts free and goes from $29/month up. Experiments let you compare latency, cost, and eval metrics across prompt versions.

Use Langfuse instead of whatbroke when you want a long-lived home for traces, prompt version control, and team collaboration, especially if you self-host. It compares aggregate metrics between versions; it does not produce a per-run behavioral diff of tool calls. A Langfuse trace importer is on the whatbroke roadmap, since the two compose well.

## DeepEval

A pytest-native testing framework with 50+ LLM-as-judge metrics (faithfulness, hallucination, task completion, and so on), backed by the Confident AI platform for teams. Open source, runs in CI.

Use DeepEval instead of whatbroke when you can articulate what "good" looks like as a metric and want scored, explainable pass/fail tests. It tells you whether the new version is worse by some rubric. whatbroke tells you what the new version did differently, which is often the thing you need before you know which metric to even look at.

## AgentOps

Agent observability: session replay with step by step timelines, cost and token tracking across 400+ frameworks, error and prompt-injection trails. Free tier, then $40/month.

Use AgentOps instead of whatbroke when you want to watch individual production sessions unfold and debug them one at a time. It replays one run beautifully; it does not compare two.

## Braintrust

A hosted eval and observability platform: versioned datasets, experiments with side by side comparison of prompts and models, online scoring, quality gates, and trace-to-dataset conversion for building regression suites from real failures. Strong choice for teams that want evals and production monitoring in one place with a UI.

Use Braintrust instead of whatbroke when you want a managed experiment workflow with scorers and a web UI for the whole team. Its comparisons are score-driven; the raw tool-call-level diff is something you eyeball in the trace viewer rather than get as a report.

## AgentDelta

The closest neighbor. Also open source (MIT, Python), also local, also CI-friendly. It embeds each agent step with a local model, aligns steps semantically, and finds the fork point where two runs diverged. LangChain and LangGraph integrations.

Use AgentDelta instead of whatbroke if you are in Python on LangChain and want semantic fork-point detection on reasoning content. whatbroke is deterministic (no embeddings, no similarity thresholds), diffs args, cost, latency, and outcomes structurally, and handles flaky agents with multi-sample rates.

## What whatbroke does that the others do not

One job: diff two recorded versions of the same agent at the behavior level. Tool calls added, dropped, reordered; argument diffs; cost and latency deltas; outcome flips. Multi-sample runs turn findings into rates ("6/9 run pairs"), and behavior that already flaps in the baseline gets demoted to noise instead of blamed on your change. It runs offline on plain JSONL, traces never leave your machine, there is no account, no rubric to write, no judge to pay for, and setup is about five minutes via the proxy recorder.

whatbroke is complementary to everything above: diff first to see what actually changed, then run your eval suite to judge whether it matters.
