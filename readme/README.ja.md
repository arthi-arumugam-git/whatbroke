<div align="center">

# whatbroke

**AIエージェントの2回の実行間の振る舞いをdiffする。**

[![npm](https://img.shields.io/npm/v/whatbroke-cli)](https://www.npmjs.com/package/whatbroke-cli) [![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

モデルを差し替えて、プロンプトをいじって、フレームワークのバージョンを上げたら、`whatbroke` を実行。何が変わったのかが正確にわかります。どのツール呼び出しが消えたか、どの引数がずれたか、コストとレイテンシがどう動いたか、どの出力がひっくり返ったか。

テキストのdiffではこれは見えません。エージェントは「サブスクリプションを解約しました」と言いながら、裏で `cancel_subscription` の呼び出しをこっそりスキップできてしまう。文面は問題なし。振る舞いは壊れている。

![モデル差し替え後にツール呼び出しの消失と返金額の変化を検出したwhatbrokeの出力](../.github/demo.svg)

これは安いモデルに切り替えたときに実際に起きた failure mode です。エージェントは75%安くなり、雰囲気チェックは通り続け、そして実際の解約処理をやめました。ついでに返金額が $42.50 から $425 になりました。

## インストール

```
npm install -g whatbroke-cli
```

または直接実行:

```
npx whatbroke-cli diff before.jsonl after.jsonl
```

同梱のサンプルtraceで今すぐ試せます:

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## 仕組み

1. エージェントが仕事をしている様子をtraceに記録する（1行1イベントの素のJSONLファイル）。
2. 何かを変える。モデル、プロンプト、フレームワークのバージョン、ツールの説明、なんでも。
3. 新しいバージョンで同じ仕事のtraceを記録する。
4. `whatbroke diff old.jsonl new.jsonl`

whatbrokeはrunをidで揃え、run内のツール呼び出しを整列させて、以下を報告します:

| 検出内容 | 深刻度 |
|---|---|
| runが失敗し始めた、ツール呼び出しが消えた、ツールがエラーを返すようになった、出力が消えた、runが見つからない | breaking |
| ツール引数の変化、新しいツール呼び出し、ツールの順序変更、出力の変化、レイテンシやコストの悪化 | changed |
| モデルの変更、トークン量の大きな変動、runが成功するようになった | info |

breakingが出ると終了コードは1になるので、そのままCIに入れられます:

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke-cli diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

もっと厳しくしたいなら `--fail-on warning`、レポートだけ欲しいなら `--fail-on never`。

## 不安定なエージェント

エージェントは二度と同じことをしません。だから1回きりの前後比較では、エージェントがもともと出していたノイズまで変更のせいにされかねません。各シナリオを何回か記録して、run idにサフィックスを付けてください:

```
refund-flow#1, refund-flow#2, refund-flow#3
```

whatbrokeはサフィックスに気づき、変更前の各サンプルを変更後の各サンプルと総当たりで比較して、各検出に出現率を付けます:

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

*ベースライン*のサンプル同士の間でも揺れている検出は、flakyなinfoに降格されます。あなたのエージェントは変更前からそう振る舞っていたからです。出現率が半分未満のbreakingはwarningに緩和されます。残ったものがシグナルです。

## traceの記録

traceのフォーマットはわざと退屈にしてあります。どの言語からでも10分で書けるJSONLです。

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

いちばん速いのはプロキシです。コード変更ゼロ、言語は問いません:

```
whatbroke record --out traces/current.jsonl
```

あとはエージェントをプロキシに向けて、いつも通り実行するだけ:

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# または
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

すべてのLLM呼び出し、ツール呼び出し、最終回答がtraceに落ちます。ストリーミングも動きます。レスポンスはそのまま素通しです。複数シナリオを回すなら、リクエストごとに `x-whatbroke-run` ヘッダーを送ってrunに名前を付けてください。

Nodeなら、SDKが既存のクライアントをラップして全部自動で記録します:

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// openaiはこれまで通り使うだけ。llm呼び出しとツール呼び出しは記録される
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)` はAnthropic SDKに対して同じことをします。それ以外には `rec.llmCall()`、`rec.toolCall()`、`rec.output()`、`rec.end()` があるし、JSONLを自分で書いても構いません。

## オプション

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              機械可読な出力
  --md                markdown出力、PRコメントにそのまま貼れる
  --fail-on <level>   終了コード1にする条件: breaking (デフォルト), warning, never
  --latency <ratio>   この倍率を超えるレイテンシ悪化をフラグ (デフォルト 1.5)
  --cost <ratio>      この倍率を超えるコスト増加をフラグ (デフォルト 1.25)
  --no-outputs        最終出力の比較をスキップ

whatbroke record --out <trace.jsonl>

  --port <n>          リッスンするポート (デフォルト 4141)
  --run <name>        x-whatbroke-runヘッダーがないときのrun id
  --target <url>      すべてをこのオリジンに転送する
```

## evalsがあるのになぜ?

両方使ってください。evalsは各バージョンをルーブリックで採点するもの。whatbrokeが答えるのは別の質問です。この2つのバージョンの間で、ツール呼び出しレベルで、正確には何が変わったのか。ルーブリックを書く必要も、ジャッジに払うお金も要りません。新しいモデルが出た5分後に走らせて、evalスイートを回す必要があるかどうかを決めるためのツールです。

決定的、オフライン、APIキー不要、アカウント不要。traceがあなたのマシンから出ることはありません。

## ロードマップ

- [x] マルチサンプル実行。不安定な振る舞いをノイズではなく出現率として表示
- [x] プロキシ記録 (`whatbroke record`)。コードに触れずにtraceを取得
- [ ] LangSmithとLangfuseのtraceエクスポートのインポーター
- [ ] Python版レコーダー
- [ ] `whatbroke watch`。イテレーション中にベースラインと自動diff
- [ ] セマンティックな出力比較 (オプトイン、自分のキーを使用)

IssueもPRも歓迎です。whatbrokeがあなたのエージェントの静かな故障を捕まえたなら、ぜひ聞かせてください。

## ライセンス

MIT
