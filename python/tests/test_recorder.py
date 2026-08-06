import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from whatbroke import Recorder


def read_events(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def test_basic_trace(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="refund-flow", meta={"model": "gpt-4o"})
    rec.llm_call(model="gpt-4o", latency_ms=900, input_tokens=512, output_tokens=128, cost_usd=0.004)
    rec.tool_call("lookup_order", {"order_id": "A-1042"})
    rec.output("Refund issued.")
    rec.end("ok")

    events = read_events(trace)
    assert [e["type"] for e in events] == ["run_start", "llm_call", "tool_call", "output", "run_end"]
    assert all(e["run"] == "refund-flow" for e in events)
    assert events[0]["meta"] == {"model": "gpt-4o"}
    assert events[1]["tokens"] == {"input": 512, "output": 128}
    assert events[1]["cost_usd"] == 0.004
    assert events[2]["name"] == "lookup_order"
    assert events[2]["args"] == {"order_id": "A-1042"}
    assert events[3]["content"] == "Refund issued."
    assert events[4]["status"] == "ok"
    assert all("ts" in e for e in events)


def test_none_fields_are_omitted(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")
    rec.llm_call(model="gpt-4o")
    rec.tool_call("lookup_order")
    rec.end()

    events = read_events(trace)
    assert "meta" not in events[0]
    assert "tokens" not in events[1]
    assert "cost_usd" not in events[1]
    assert "error" not in events[1]
    assert "args" not in events[2]
    assert "error" not in events[3]


def test_creates_parent_directory(tmp_path):
    trace = tmp_path / "nested" / "dir" / "trace.jsonl"
    Recorder(str(trace), run="flow")
    assert trace.exists()


def test_error_end(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")
    rec.end("error", error="agent crashed")
    events = read_events(trace)
    assert events[-1]["status"] == "error"
    assert events[-1]["error"] == "agent crashed"


def fake_openai_response():
    return SimpleNamespace(
        model="gpt-4o-2024-08-06",
        usage=SimpleNamespace(prompt_tokens=100, completion_tokens=20),
        choices=[
            SimpleNamespace(
                finish_reason="tool_calls",
                message=SimpleNamespace(
                    tool_calls=[
                        SimpleNamespace(
                            function=SimpleNamespace(
                                name="lookup_order", arguments='{"order_id": "A-1042"}'
                            )
                        )
                    ]
                ),
            )
        ],
    )


def fake_openai_client(create):
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def test_wrap_openai_records_call_and_tools(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")

    client = fake_openai_client(lambda **kwargs: fake_openai_response())
    rec.wrap_openai(client)
    client.chat.completions.create(model="gpt-4o", messages=[])

    events = read_events(trace)
    llm = [e for e in events if e["type"] == "llm_call"]
    tools = [e for e in events if e["type"] == "tool_call"]
    assert llm[0]["model"] == "gpt-4o-2024-08-06"
    assert llm[0]["tokens"] == {"input": 100, "output": 20}
    assert llm[0]["stop_reason"] == "tool_calls"
    assert tools[0]["name"] == "lookup_order"
    assert tools[0]["args"] == {"order_id": "A-1042"}


def test_wrap_openai_records_errors_and_reraises(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")

    def boom(**kwargs):
        raise RuntimeError("rate limited")

    client = fake_openai_client(boom)
    rec.wrap_openai(client)
    with pytest.raises(RuntimeError):
        client.chat.completions.create(model="gpt-4o", messages=[])

    llm = [e for e in read_events(trace) if e["type"] == "llm_call"]
    assert llm[0]["model"] == "gpt-4o"
    assert llm[0]["error"] == "rate limited"


def test_wrap_openai_async(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")

    async def create(**kwargs):
        return fake_openai_response()

    client = fake_openai_client(create)
    rec.wrap_openai(client)
    asyncio.run(client.chat.completions.create(model="gpt-4o", messages=[]))

    llm = [e for e in read_events(trace) if e["type"] == "llm_call"]
    assert llm[0]["model"] == "gpt-4o-2024-08-06"


def test_wrap_openai_rejects_wrong_client(tmp_path):
    rec = Recorder(str(tmp_path / "t.jsonl"), run="flow")
    with pytest.raises(TypeError):
        rec.wrap_openai(object())


def fake_anthropic_response():
    return SimpleNamespace(
        model="claude-sonnet-4-6",
        usage=SimpleNamespace(input_tokens=200, output_tokens=50),
        stop_reason="tool_use",
        content=[
            SimpleNamespace(type="text", text="Let me look that up."),
            SimpleNamespace(type="tool_use", name="lookup_order", input={"order_id": "A-1042"}),
        ],
    )


def test_wrap_anthropic_records_call_and_tools(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")

    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kwargs: fake_anthropic_response()))
    rec.wrap_anthropic(client)
    client.messages.create(model="claude-sonnet-4-6", max_tokens=1024, messages=[])

    events = read_events(trace)
    llm = [e for e in events if e["type"] == "llm_call"]
    tools = [e for e in events if e["type"] == "tool_call"]
    assert llm[0]["model"] == "claude-sonnet-4-6"
    assert llm[0]["tokens"] == {"input": 200, "output": 50}
    assert llm[0]["stop_reason"] == "tool_use"
    assert tools[0]["name"] == "lookup_order"
    assert tools[0]["args"] == {"order_id": "A-1042"}


def test_wrap_anthropic_rejects_wrong_client(tmp_path):
    rec = Recorder(str(tmp_path / "t.jsonl"), run="flow")
    with pytest.raises(TypeError):
        rec.wrap_anthropic(object())


def test_malformed_tool_arguments_recorded_without_args(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")

    response = fake_openai_response()
    response.choices[0].message.tool_calls[0].function.arguments = "not json {"
    client = fake_openai_client(lambda **kwargs: response)
    rec.wrap_openai(client)
    client.chat.completions.create(model="gpt-4o", messages=[])

    tools = [e for e in read_events(trace) if e["type"] == "tool_call"]
    assert tools[0]["name"] == "lookup_order"
    assert "args" not in tools[0]


# The prompt has to reach the trace in exactly the shape the Node recorder writes, or a
# baseline recorded in one language and a rerun recorded in the other would report a prompt
# change that never happened. These strings are asserted verbatim in test/record.test.ts.
def test_records_the_prompt_from_openai_messages(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")

    client = fake_openai_client(lambda **kwargs: fake_openai_response())
    rec.wrap_openai(client)
    client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "Be terse."},
            {"role": "user", "content": "Where is order A-1?"},
        ],
    )

    llm = [e for e in read_events(trace) if e["type"] == "llm_call"]
    assert llm[0]["prompt"] == "system: Be terse.\nuser: Where is order A-1?"


def test_records_the_anthropic_system_prompt(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")

    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kwargs: fake_anthropic_response()))
    rec.wrap_anthropic(client)
    client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system="Be terse.",
        messages=[{"role": "user", "content": "Where is order A-1?"}],
    )

    llm = [e for e in read_events(trace) if e["type"] == "llm_call"]
    assert llm[0]["prompt"] == "system: Be terse.\nuser: Where is order A-1?"


def test_flattens_content_blocks(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")
    rec.llm_call(
        model="claude-sonnet-4-6",
        prompt=[{"role": "user", "content": [{"type": "text", "text": "Where is order A-1?"}]}],
    )

    llm = [e for e in read_events(trace) if e["type"] == "llm_call"]
    assert llm[0]["prompt"] == "user: Where is order A-1?"


def test_blank_prompt_is_recorded_as_no_prompt(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")
    for blank in ["", "   ", [], {}, None]:
        rec.llm_call(model="gpt-4o", prompt=blank)

    llm = [e for e in read_events(trace) if e["type"] == "llm_call"]
    assert all("prompt" not in e for e in llm)


def test_prompt_keeps_unicode(tmp_path):
    trace = tmp_path / "trace.jsonl"
    rec = Recorder(str(trace), run="flow")
    rec.llm_call(model="gpt-4o", prompt=[{"role": "user", "content": "Répondez en français. 🙂"}])

    llm = [e for e in read_events(trace) if e["type"] == "llm_call"]
    assert llm[0]["prompt"] == "user: Répondez en français. 🙂"


def test_matches_the_node_normalisation_fixture():
    """The Node recorder runs this same fixture in test/import.test.ts."""
    from whatbroke import _prompt_text

    path = os.path.join(os.path.dirname(__file__), "..", "..", "test", "fixtures", "prompt-normalisation.json")
    with open(path, encoding="utf-8") as f:
        fixture = json.load(f)
    assert fixture["cases"], "fixture is empty, which would make this test pass for nothing"
    for case in fixture["cases"]:
        assert _prompt_text(case["input"]) == case["expected"], case["name"]
