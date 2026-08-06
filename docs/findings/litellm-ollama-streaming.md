# The proxy that silently turned an agent into a chatbot

The three earlier studies all changed the model and measured what moved. This one holds the model completely still and changes only the path the request takes to reach it.

That turns out to be the more uncomfortable experiment. A model swap is a decision someone made on purpose. A proxy upgrade is a line in a config file.

## What was measured

Same machine, same model file, same prompts, same tool schemas, temperature 0, seed 42, 3 samples per side. With 3 samples on each side whatbroke compares every baseline run against every after run, so each finding carries a rate out of 9 pairs.

- **A**: agent talks to ollama directly, `http://localhost:11434/v1`
- **B**: agent talks to LiteLLM `ollama_chat/qwen2.5:3b`, which forwards to that same ollama
- **C**: agent talks to LiteLLM `ollama/qwen2.5:3b`, which forwards to that same ollama

Every arm was recorded twice, once non-streaming and once with `--stream`. Versions: litellm 1.93.0, qwen2.5:3b at Q4_K_M.

## The noise floor comes first

Small local models are not deterministic even at temperature 0 with a fixed seed. Any finding is worthless until you know what the baseline does against itself, so direct ollama was recorded a second time at identical settings and diffed against its own first run.

| Noise floor | Result |
|---|---|
| direct vs direct, non-streaming | 1 changed. Final output wording differs at 3/9, in one scenario. No tool call was ever dropped. |
| direct vs direct, streaming | `No behavioral changes detected.` |

On the streaming side the floor is zero. Anything that appears there belongs to the path.

## Result

| Path | Non-streaming | Streaming |
|---|---|---|
| `ollama_chat/` | clean. Only the model relabel at 9/9. Every behavioural change sat at 3/9, the same rate the baseline flaps at on its own. | `No behavioral changes detected.` |
| `ollama/` | 3 breaking, 6 changed | **7 breaking** |

The raw event counts say it before any analysis runs: 90, 90, 90, 90, then 78 for `ollama/` non-streaming and 48 for `ollama/` streaming.

### `ollama/` with streaming on: the agent stops being an agent

Every tool call dropped, in all four scenarios, at 9/9. The agent makes one model call instead of four and stops. Runtime falls from 40.5s to 5.0s because nothing happens.

The customer sees this:

```
{"name": "lookup_account", "arguments":{"email": "maya.iyer@example.com"}}
```

instead of this:

```
We have processed your refund. You will receive $29 USD to cover this month's
subscription cost.
```

Nothing errors. HTTP 200, `finish_reason: "stop"`. To the calling code the model simply replied in prose and the turn is over. A cancel-and-refund request produces no cancellation, no refund, and a JSON blob in the chat window.

### `ollama/` without streaming: degraded rather than dead

`get_billing_history` dropped at 9/9. `cancel_subscription` and `issue_refund` dropped at 6/9. Final output changed at 9/9 across all four scenarios, again leaking raw JSON such as `{"account_id": "AC-2214", "function_name": "get_billing_history", "arguments": {...}}`.

## Root cause

`litellm/llms/ollama/completion/transformation.py`.

**Non-streaming** (`transform_response`) buffers the whole response, `json.loads` it, and when the object carries both `name` and `arguments` it builds a proper `tool_calls` message and sets `finish_reason = "tool_calls"`.

**Streaming** (`OllamaTextCompletionResponseIterator.chunk_parser`) has no equivalent. It parses chunk by chunk and never holds the complete text, so the JSON is never recognised and passes straight through as `content`.

The asymmetry is structural. The streaming iterator cannot do what the buffered path does, because the detection depends on having the whole string in hand.

A smaller second point: `tools` is absent from `get_supported_openai_params` for this route. The config set `drop_params: false`, which should mean an unsupported parameter raises. It did not raise. It accepted `tools` and produced a broken agent quietly.

## Is this just picking the wrong prefix

That was the first objection worth checking, and the answer is no.

LiteLLM's docs recommend `ollama_chat` "for better responses", which is a statement about response quality rather than a claim that `ollama/` cannot call tools. The same page documents tool calling for Ollama and notes that litellm "defaults to json mode tool calls if native tool calling not supported". JSON-mode tool calls is exactly the mechanism the `ollama/` path implements, and the non-streaming code that parses `name`/`arguments` into `tool_calls` exists deliberately. It is an intended feature that works on one path and is missing on the other.

## Prior art

- **#33678** (open) covers `ollama_chat` streaming emitting `index=0` for every tool call, so clients that merge deltas on `index` collapse parallel calls into one. That issue is already filed and is not a finding of this study. It was confirmed live in 1.93.0 with a forced two-call probe: direct ollama returns indexes `[0,1]`, LiteLLM returns `[0,0]`. It never fired in the four scenarios here because they drive tools sequentially, one per turn.
- **#19742** reports the same raw-JSON symptom against OpenWebUI. It was closed by the stale bot as `not_planned` with no fix. Three separate users confirmed it, and the original reporter posted that it was resolved, then struck the comment through and wrote "Still reproducible with native tool calling". Nobody isolated the route or the streaming variable, which is likely why it read as unreproducible.

The contribution here is the isolation: which prefix, which mode, and the exact function that differs.

## Honest limitations

- One model, one size, on CPU. Not shown to generalise across models.
- `--stream` traces carry no token counts, because ollama omits usage from streaming chunks unless `stream_options.include_usage` is set. This affects the direct baseline equally, so it is a gap in the measurement rather than a difference between paths.
- 3 samples per side. The 3/9 signals on `ollama_chat` non-streaming are not separable from baseline flakiness at this sample count, and are reported as noise rather than findings.
- The `ollama_chat` route, the one LiteLLM recommends, came out clean on both modes. The finding is narrow, and the narrowness is the point.

## Run it yourself

```
git clone https://github.com/arthi-arumugam-git/whatbroke && cd whatbroke
ollama pull qwen2.5:3b
npm install -g whatbroke-cli
pip install "litellm[proxy]"

# baseline: straight to ollama
node examples/agent.mjs --model qwen2.5:3b --base http://localhost:11434/v1 \
  --out traces/direct.jsonl --samples 3 --temperature 0 --seed 42 --stream

# start the proxy in a second terminal, it stays in the foreground
litellm --config examples/litellm-ollama.yaml --port 4000

# same model, through the proxy
node examples/agent.mjs --model via-ollama --base http://localhost:4000/v1 \
  --out traces/proxied.jsonl --samples 3 --temperature 0 --seed 42 --stream

whatbroke diff traces/direct.jsonl traces/proxied.jsonl
```

Set `OPENAI_API_KEY` to the proxy's `master_key` for the second run. Everything runs offline and the traces never leave your machine.

On Windows the proxy will not start under the default console codepage, because the startup banner is box-drawing characters and it dies with `UnicodeEncodeError` before serving anything. `PYTHONIOENCODING=utf-8` clears it.

## Why this one matters more than the model swaps

Nobody swaps a model without knowing they did it. Gateways, proxies and routing layers get upgraded quietly, and they sit directly on the path every tool call travels. This failure produced no error, no non-200, and no log line. The only thing that changed was that the agent stopped doing its job, and the reply still looked like a reply.

That is the class of change a behavioural diff is for.
