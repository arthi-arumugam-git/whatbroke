# whatbroke-recorder

Record AI agent traces from Python as [whatbroke](https://github.com/arthi-arumugam-git/whatbroke) JSONL. Swap a model, tweak a prompt, record again, then diff the two runs and see exactly what changed: which tool calls disappeared, which arguments drifted, where cost and latency moved.

```
pip install whatbroke-recorder
```

Zero dependencies. The trace format is identical to the Node SDK and the `whatbroke record` proxy, so traces from any of them diff against each other.

## Usage

Wrap your existing client, run your agent exactly as before:

```python
from whatbroke import Recorder
from openai import OpenAI

rec = Recorder("traces/current.jsonl", run="refund-flow")
client = rec.wrap_openai(OpenAI())

run_my_agent(client)  # llm calls and tool calls are captured

rec.output(final_answer)
rec.end("ok")
```

`rec.wrap_anthropic(client)` does the same for the Anthropic SDK. Sync and async clients both work.

For everything else, write events directly:

```python
rec = Recorder("traces/current.jsonl", run="refund-flow")
rec.llm_call(
    model="gpt-4o",
    prompt=[{"role": "system", "content": "You are a refund agent."}],
    latency_ms=900,
    input_tokens=512,
    output_tokens=128,
    cost_usd=0.004,
)
rec.tool_call("lookup_order", {"order_id": "A-1042"})
rec.output("Refund issued.")
rec.end("ok")
```

`prompt` takes whatever your SDK takes: a string, a message list, or content blocks. It is
normalised to `role: text` lines, exactly as the Node recorder normalises it, so a baseline
recorded from Python diffs cleanly against a rerun recorded from Node. The wrappers fill it in
for you, including Anthropic's `system`, which lives outside `messages`.

## Diffing

The diff CLI ships on npm:

```
npx whatbroke-cli diff traces/baseline.jsonl traces/current.jsonl
```

Exit code 1 when something breaking shows up (a dropped tool call, a run that started failing), so it slots straight into CI. Full docs, flaky-agent sampling, behavior contracts, and importers for OTel/Langfuse/LangSmith: [github.com/arthi-arumugam-git/whatbroke](https://github.com/arthi-arumugam-git/whatbroke).

## License

MIT
