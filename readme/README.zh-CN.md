<div align="center">

# whatbroke

**对比你的 AI Agent 在两次运行之间的行为差异。**

[![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

换个模型、改句提示词、升级一下框架版本，然后跑一下 `whatbroke`，就能看到到底哪里变了：哪些工具调用消失了、哪些参数悄悄漂移了、成本和延迟往哪边走了、哪些输出翻了车。

文本 diff 看不出这些。你的 Agent 可以一边说"您的订阅已取消"，一边悄悄跳过 `cancel_subscription` 调用。文字看着没问题，行为已经坏了。

![换模型后 whatbroke 检测出丢失的工具调用和退款金额变化](../.github/demo.svg)

这是换用便宜模型后的真实翻车现场。Agent 便宜了 75%，气氛上一切正常，但它不再真正取消订阅了，退款金额也从 $42.50 变成了 $425。

## 安装

```
npm install -g whatbroke
```

或者直接运行：

```
npx whatbroke diff before.jsonl after.jsonl
```

现在就可以用仓库自带的示例 trace 试一下：

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## 工作原理

1. 录制一份 Agent 正常干活的 trace（纯 JSONL 文件，一行一个事件）。
2. 改点什么。模型、提示词、框架版本、工具描述，都行。
3. 用新版本再录一份同样任务的 trace。
4. `whatbroke diff old.jsonl new.jsonl`

whatbroke 按 id 对齐每次运行，在运行内部对齐工具调用，然后报告：

| 发现 | 严重级别 |
|---|---|
| 运行开始失败、工具调用被丢弃、工具开始报错、输出消失、运行缺失 | breaking |
| 工具参数变化、新增工具调用、工具顺序变化、输出变化、延迟或成本回归 | changed |
| 模型变化、token 用量大幅波动、运行恢复成功 | info |

出现 breaking 时退出码为 1，可以直接放进 CI：

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

想更严格就用 `--fail-on warning`，只想看报告就用 `--fail-on never`。

## 不稳定的 Agent

Agent 从来不会两次做完全一样的事，所以单次前后对比可能把 Agent 本来就有的噪声算在你的改动头上。把每个场景多录几次，给 run id 加个后缀：

```
refund-flow#1, refund-flow#2, refund-flow#3
```

whatbroke 会识别这些后缀，把每个改动前样本和每个改动后样本两两对比，给每条发现标上出现率：

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

凡是在两个*基线*样本之间也会变来变去的发现，都会降级为 flaky info，因为你的 Agent 在改动之前就是这么干的。出现率不到一半的 breaking 会软化为 warning。剩下的就是真正的信号。

## 录制 trace

trace 格式故意做得很无聊：任何语言十分钟就能写出来的 JSONL。

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

最快的方式是用代理。零代码改动，任何语言都行：

```
whatbroke record --out traces/current.jsonl
```

然后把 Agent 指向它，照常运行：

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# 或者
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

每次 LLM 调用、工具调用和最终回答都会落进 trace。支持流式，响应原样透传。如果要跑多个场景，给每个请求带上 `x-whatbroke-run` 头来命名运行。

如果你在 Node 里，SDK 可以包住现有客户端，自动录制一切：

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// 照常使用 openai；llm 调用和工具调用都会被记录
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)` 对 Anthropic SDK 同理。其他情况可以用 `rec.llmCall()`、`rec.toolCall()`、`rec.output()`、`rec.end()`，或者干脆自己写 JSONL。

## 选项

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              机器可读的输出
  --md                markdown 输出，可以直接贴进 PR 评论
  --fail-on <level>   在哪一级退出 1：breaking（默认）、warning、never
  --latency <ratio>   超过此比例的延迟回归会被标记（默认 1.5）
  --cost <ratio>      超过此比例的成本上涨会被标记（默认 1.25）
  --no-outputs        跳过最终输出对比

whatbroke record --out <trace.jsonl>

  --port <n>          监听端口（默认 4141）
  --run <name>        没有 x-whatbroke-run 头时使用的 run id
  --target <url>      把所有请求转发到这个地址
```

## 为什么不直接用评测（evals）？

两个都用。评测是拿一套评分标准给每个版本打分。whatbroke 回答的是另一个问题：这两个版本之间到底发生了什么变化，精确到工具调用层面，不用写评分标准，也不用花钱请裁判。新模型发布五分钟后，你先跑它，再决定评测套件有没有必要跑。

确定性、完全离线、不需要 API key、不需要注册。你的 trace 永远不会离开你的机器。

## 路线图

- [x] 多样本运行，把不稳定行为呈现为出现率而不是噪声
- [x] 代理录制（`whatbroke record`），不碰代码就能拿到 trace
- [ ] LangSmith 和 Langfuse trace 导出的导入器
- [ ] Python 录制器
- [ ] `whatbroke watch`，迭代时自动对比基线
- [ ] 语义输出对比（可选启用，自带 key）

欢迎 issue 和 PR。如果 whatbroke 帮你抓到了 Agent 里悄悄坏掉的东西，我真的很想听听。

## 许可证

MIT
