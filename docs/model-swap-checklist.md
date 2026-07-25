# Swapping your agent to a new model? Do this first.

Every time a new model ships, the same thing happens: change the model string, run the agent, read a few replies, they look good, ship it. The replies are the one part of an agent that almost never breaks visibly. What breaks is behavior. A tool call quietly disappears, an argument drifts, a refund amount loses its decimal point, and the agent keeps talking like everything is fine.

This is the checklist I use before any swap. It takes about 20 minutes and it produces a real diff instead of a vibe check.

## 1. Record a baseline before you touch anything

This is the step you cannot recover later. Once you swap, the old behavior is gone.

Start the recording proxy and point your agent at it, no code changes:

```
npx whatbroke-cli record --out baseline.jsonl
```

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1     # openai sdk
ANTHROPIC_BASE_URL=http://127.0.0.1:4141     # anthropic sdk
```

Run your agent through its real scenarios. Because agents are nondeterministic, run each scenario three times and name the runs `refund-flow#1`, `refund-flow#2`, `refund-flow#3` (send an `x-whatbroke-run` header, or use `--run`). Three samples per scenario is enough for the diff to tell flaps from real changes.

Pick scenarios where the agent has to *do* something: call tools, hit an API, write a record. Pure chat scenarios are where nothing ever visibly breaks, so they tell you the least.

## 2. Swap the model

Change the model string. Nothing else. If you also want to tweak the prompt for the new model, do that as a second swap with its own diff, otherwise you will never know which change caused what.

## 3. Record the same scenarios again

```
npx whatbroke-cli record --out swapped.jsonl
```

Same scenarios, same names, three runs each.

## 4. Diff

```
npx whatbroke-cli diff baseline.jsonl swapped.jsonl
```

Read the findings top down:

- **breaking** findings first: dropped tool calls, runs that now fail, outputs that vanished. Any of these means the swap is not a drop-in.
- **changed** findings next: argument drift is the sneaky one. The tool still gets called, but with different args. Check every one by hand.
- The **flap rate** on each finding tells you whether it is real. `3/3` means it happens every time. `1/3` on something your baseline also flapped on is just your agent being itself.
- Cost and latency move on every swap. The diff flags regressions past a ratio (defaults: 1.5x latency, 1.25x cost, tune with `--latency` and `--cost`).

## 5. Keep it running in CI

```
npx whatbroke-cli diff baseline.jsonl current.jsonl --fail-on breaking
```

Exit code 1 on breaking changes. `--md` gives you a markdown report you can drop straight into the PR comment.

## Already swapped without a baseline?

If your agent runs behind Langfuse, LangSmith, or anything emitting OTel GenAI spans, you already have the baseline, you just have not diffed it yet. Export last week's traces and this week's, then:

```
npx whatbroke-cli import last-week-export.json --run baseline
npx whatbroke-cli import this-week-export.json --run swapped
npx whatbroke-cli diff last-week-export.whatbroke.jsonl this-week-export.whatbroke.jsonl
```

For a real example of what a swap changes when the replies all look fine, see [what a 3x smaller model changed in a tool-calling agent](findings/llama32-3b-vs-1b.md).
