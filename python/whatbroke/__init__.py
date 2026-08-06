"""Record AI agent traces as whatbroke JSONL.

Usage:
    from whatbroke import Recorder

    rec = Recorder("traces/current.jsonl", run="refund-flow")
    client = rec.wrap_openai(OpenAI())
    ... run your agent ...
    rec.output(final_answer)
    rec.end("ok")

Then: whatbroke diff traces/baseline.jsonl traces/current.jsonl
"""

from __future__ import annotations

import inspect
import json
import os
import time
from typing import Any, Optional

__all__ = ["Recorder"]
__version__ = "0.1.0"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean(obj: dict) -> dict:
    return {k: v for k, v in obj.items() if v is not None}


def _safe_parse(raw: Any) -> Optional[dict]:
    if not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _prompt_text(value: Any) -> Optional[str]:
    """Normalise a prompt into the same text the Node recorder writes.

    The two implementations have to agree character for character. A baseline recorded from
    Python and a rerun recorded from Node would otherwise diff as a prompt change that never
    happened, which is worse than no prompt diffing at all. See promptText in src/import.ts.
    """
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            return text  # not JSON, so the string is already the prompt
        if isinstance(parsed, str):
            return parsed.strip() or None
        nested = _prompt_text(parsed)
        return nested if nested is not None else text
    if isinstance(value, (list, tuple)):
        parts = [text for text in (_message_text(m) for m in value) if text is not None]
        return "\n".join(parts) if parts else None
    if isinstance(value, dict):
        for key in ("messages", "prompt", "input"):
            if key in value:
                nested = _prompt_text(value[key])
                if nested is not None:
                    return nested
        single = _message_text(value)
        if single is not None:
            return single
        # key-order independent, so an SDK reordering its JSON does not read as an edit
        dumped = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return None if dumped == "{}" else dumped
    return None


def _message_text(message: Any) -> Optional[str]:
    """One chat message to text. The role is kept: moving an instruction from system to user
    is a real change and has to read as one."""
    if isinstance(message, str):
        return message.strip() or None
    # LangChain's tuple form, ("user", "text"), which is what LangSmith stores for chat models
    if (
        isinstance(message, (list, tuple))
        and len(message) == 2
        and all(isinstance(part, str) for part in message)
    ):
        return f"{message[0]}: {message[1]}"
    if not isinstance(message, dict):
        return None
    # LangChain's serialised form nests the real message under kwargs
    if isinstance(message.get("kwargs"), dict):
        inner = _message_text(message["kwargs"])
        if inner is not None:
            return inner
    role = message.get("role") if isinstance(message.get("role"), str) else None
    content = message.get("content")
    body: Optional[str] = None
    if isinstance(content, str):
        body = content
    else:
        # content blocks (Anthropic, OpenAI vision) carry the text one level down
        blocks = content if isinstance(content, list) else None
        if blocks is not None:
            texts = []
            for block in blocks:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    texts.append(block["text"])
                elif isinstance(block, dict) and isinstance(block.get("content"), str):
                    texts.append(block["content"])
            body = "\n".join(texts) if texts else None
    if body is None:
        return None
    return f"{role}: {body}" if role else body


def _anthropic_prompt(params: dict) -> Any:
    """Anthropic keeps the system prompt out of `messages`, so reading `messages` alone would
    miss the part people edit most. Put it back at the front as the system turn it is."""
    messages = params.get("messages")
    messages = list(messages) if isinstance(messages, (list, tuple)) else []
    system = params.get("system")
    if system is None:
        return messages
    return [{"role": "system", "content": system}] + messages


class Recorder:
    """Writes trace events to a JSONL file, one recorder per scenario run.

    Mirrors the Node SDK: the file format is identical, so traces recorded
    from Python diff cleanly against traces recorded from Node or the proxy.
    """

    def __init__(self, file: str, run: str = "default", meta: Optional[dict] = None):
        self.file = file
        self.run = run
        directory = os.path.dirname(file)
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._write(_clean({"type": "run_start", "run": run, "ts": _now_ms(), "meta": meta}))

    def _write(self, event: dict) -> None:
        with open(self.file, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")

    def llm_call(
        self,
        model: str,
        latency_ms: Optional[float] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        cost_usd: Optional[float] = None,
        stop_reason: Optional[str] = None,
        error: Optional[str] = None,
        # last so existing positional calls keep working; normalised to text on the way out
        prompt: Any = None,
    ) -> None:
        tokens = _clean({"input": input_tokens, "output": output_tokens})
        self._write(
            _clean(
                {
                    "type": "llm_call",
                    "run": self.run,
                    "ts": _now_ms(),
                    "model": model,
                    "prompt": _prompt_text(prompt),
                    "latency_ms": latency_ms,
                    "tokens": tokens or None,
                    "cost_usd": cost_usd,
                    "stop_reason": stop_reason,
                    "error": error,
                }
            )
        )

    def tool_call(
        self,
        name: str,
        args: Optional[dict] = None,
        latency_ms: Optional[float] = None,
        error: Optional[str] = None,
    ) -> None:
        self._write(
            _clean(
                {
                    "type": "tool_call",
                    "run": self.run,
                    "ts": _now_ms(),
                    "name": name,
                    "args": args,
                    "latency_ms": latency_ms,
                    "error": error,
                }
            )
        )

    def output(self, content: str) -> None:
        self._write({"type": "output", "run": self.run, "ts": _now_ms(), "content": content})

    def end(self, status: str = "ok", error: Optional[str] = None) -> None:
        self._write(
            _clean({"type": "run_end", "run": self.run, "ts": _now_ms(), "status": status, "error": error})
        )

    def wrap_openai(self, client: Any) -> Any:
        """Wrap an OpenAI client (sync or async) so every
        chat.completions.create call is recorded, including tool calls the
        model requested. Returns the same client."""
        completions = getattr(getattr(client, "chat", None), "completions", None)
        original = getattr(completions, "create", None)
        if original is None:
            raise TypeError("wrap_openai expects an OpenAI client with chat.completions.create")

        def record_response(response: Any, params: dict, started: float) -> None:
            usage = getattr(response, "usage", None)
            choices = getattr(response, "choices", None) or []
            first = choices[0] if choices else None
            self.llm_call(
                model=getattr(response, "model", None) or params.get("model") or "unknown",
                latency_ms=round((time.time() - started) * 1000),
                input_tokens=getattr(usage, "prompt_tokens", None),
                output_tokens=getattr(usage, "completion_tokens", None),
                stop_reason=getattr(first, "finish_reason", None),
                prompt=params.get("messages"),
            )
            message = getattr(first, "message", None)
            for call in getattr(message, "tool_calls", None) or []:
                fn = getattr(call, "function", None)
                self.tool_call(
                    getattr(fn, "name", None) or "unknown",
                    _safe_parse(getattr(fn, "arguments", None)),
                )

        def record_error(err: Exception, params: dict, started: float) -> None:
            self.llm_call(
                model=params.get("model") or "unknown",
                latency_ms=round((time.time() - started) * 1000),
                error=str(err),
                prompt=params.get("messages"),
            )

        if inspect.iscoroutinefunction(original):

            async def async_create(*args: Any, **kwargs: Any) -> Any:
                started = time.time()
                try:
                    response = await original(*args, **kwargs)
                except Exception as err:
                    record_error(err, kwargs, started)
                    raise
                record_response(response, kwargs, started)
                return response

            completions.create = async_create
        else:

            def sync_create(*args: Any, **kwargs: Any) -> Any:
                started = time.time()
                try:
                    response = original(*args, **kwargs)
                except Exception as err:
                    record_error(err, kwargs, started)
                    raise
                record_response(response, kwargs, started)
                return response

            completions.create = sync_create

        return client

    def wrap_anthropic(self, client: Any) -> Any:
        """Wrap an Anthropic client (sync or async) so every messages.create
        call is recorded, including tool_use blocks. Returns the same client."""
        messages = getattr(client, "messages", None)
        original = getattr(messages, "create", None)
        if original is None:
            raise TypeError("wrap_anthropic expects an Anthropic client with messages.create")

        def record_response(response: Any, params: dict, started: float) -> None:
            usage = getattr(response, "usage", None)
            self.llm_call(
                model=getattr(response, "model", None) or params.get("model") or "unknown",
                latency_ms=round((time.time() - started) * 1000),
                input_tokens=getattr(usage, "input_tokens", None),
                output_tokens=getattr(usage, "output_tokens", None),
                stop_reason=getattr(response, "stop_reason", None),
                prompt=_anthropic_prompt(params),
            )
            content = getattr(response, "content", None)
            for block in content if isinstance(content, list) else []:
                if getattr(block, "type", None) == "tool_use":
                    block_input = getattr(block, "input", None)
                    self.tool_call(
                        getattr(block, "name", None) or "unknown",
                        block_input if isinstance(block_input, dict) else {},
                    )

        def record_error(err: Exception, params: dict, started: float) -> None:
            self.llm_call(
                model=params.get("model") or "unknown",
                latency_ms=round((time.time() - started) * 1000),
                error=str(err),
                prompt=_anthropic_prompt(params),
            )

        if inspect.iscoroutinefunction(original):

            async def async_create(*args: Any, **kwargs: Any) -> Any:
                started = time.time()
                try:
                    response = await original(*args, **kwargs)
                except Exception as err:
                    record_error(err, kwargs, started)
                    raise
                record_response(response, kwargs, started)
                return response

            messages.create = async_create
        else:

            def sync_create(*args: Any, **kwargs: Any) -> Any:
                started = time.time()
                try:
                    response = original(*args, **kwargs)
                except Exception as err:
                    record_error(err, kwargs, started)
                    raise
                record_response(response, kwargs, started)
                return response

            messages.create = sync_create

        return client
