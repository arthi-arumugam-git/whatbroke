<div align="center">

# whatbroke

**Vergleiche das Verhalten deines KI-Agenten zwischen zwei Läufen.**

[![npm](https://img.shields.io/npm/v/whatbroke-cli)](https://www.npmjs.com/package/whatbroke-cli) [![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

Modell tauschen, Prompt anpassen, Framework-Version anheben, dann `whatbroke` laufen lassen und genau sehen, was sich geändert hat: welche Tool-Aufrufe verschwunden sind, welche Argumente abgedriftet sind, wohin Kosten und Latenz gewandert sind und welche Ausgaben gekippt sind.

Text-Diffs sehen das nicht. Dein Agent kann sagen „dein Abo ist gekündigt" und dabei den `cancel_subscription`-Aufruf stillschweigend überspringen. Die Worte sehen gut aus. Das Verhalten ist kaputt.

![whatbroke-Ausgabe mit einem weggefallenen Tool-Aufruf und geändertem Erstattungsbetrag nach einem Modellwechsel](../.github/demo.svg)

Das ist ein echter Ausfall nach dem Wechsel auf ein günstigeres Modell. Der Agent wurde 75 % billiger, bestand weiter den Gefühlstest und hörte auf, Abos tatsächlich zu kündigen. Außerdem erstattete er plötzlich 425 $ statt 42,50 $.

## Installation

```
npm install -g whatbroke-cli
```

Oder direkt ausführen:

```
npx whatbroke-cli diff before.jsonl after.jsonl
```

Probier es sofort mit den mitgelieferten Beispiel-Traces:

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## So funktioniert es

1. Zeichne einen Trace deines Agenten bei der Arbeit auf (eine schlichte JSONL-Datei, ein Event pro Zeile).
2. Ändere etwas. Modell, Prompt, Framework-Version, Tool-Beschreibungen, egal was.
3. Zeichne einen Trace der neuen Version bei derselben Aufgabe auf.
4. `whatbroke diff old.jsonl new.jsonl`

whatbroke richtet Läufe per id aus, richtet Tool-Aufrufe innerhalb jedes Laufs aus und meldet:

| Befund | Schweregrad |
|---|---|
| Lauf schlägt neuerdings fehl, Tool-Aufruf weggefallen, Tool wirft jetzt Fehler, Ausgabe weg, Lauf fehlt | breaking |
| Tool-Argumente geändert, neue Tool-Aufrufe, Tools umsortiert, Ausgabe geändert, Latenz- oder Kostenregression | changed |
| Modell geändert, große Token-Schwankungen, Lauf gelingt jetzt | info |

Der Exit-Code ist 1, sobald etwas Breaking auftaucht, also passt es direkt in die CI:

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke-cli diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

`--fail-on warning` für strengere Gates, `--fail-on never`, wenn du nur den Bericht willst.

## Launische Agenten

Agenten machen nie zweimal dasselbe. Ein einzelner Vorher/Nachher-Vergleich kann deiner Änderung also Rauschen anlasten, das der Agent ohnehin produziert hat. Zeichne jedes Szenario ein paarmal auf und hänge Suffixe an die ids:

```
refund-flow#1, refund-flow#2, refund-flow#3
```

whatbroke erkennt die Suffixe, vergleicht jede Vorher-Probe mit jeder Nachher-Probe und versieht jeden Befund mit einer Rate:

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

Alles, was auch zwischen zwei *Baseline*-Proben hin und her springt, wird zu flaky info herabgestuft, denn so hat sich dein Agent schon vor der Änderung verhalten. Breaking-Befunde mit einer Rate unter der Hälfte werden zu Warnings abgemildert. Was übrig bleibt, ist Signal.

## Traces aufzeichnen

Das Trace-Format ist absichtlich langweilig: JSONL, das du aus jeder Sprache in zehn Minuten schreiben kannst.

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

Der schnellste Weg zu einem Trace ist der Proxy. Null Codeänderungen, jede Sprache:

```
whatbroke record --out traces/current.jsonl
```

Dann richte deinen Agenten darauf und starte ihn genau wie immer:

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# oder
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

Jeder LLM-Aufruf, jeder Tool-Aufruf und die finale Antwort landen im Trace. Streaming funktioniert, Antworten werden unverändert durchgereicht. Wenn du mehrere Szenarien fährst, schick pro Request einen `x-whatbroke-run`-Header, um die Läufe zu benennen.

Unter Node wickelt das SDK deinen bestehenden Client ein und zeichnet alles automatisch auf:

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// benutze openai genau wie vorher; llm- und tool-aufrufe werden erfasst
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)` macht dasselbe für das Anthropic-SDK. Für alles andere gibt es `rec.llmCall()`, `rec.toolCall()`, `rec.output()`, `rec.end()`, oder du schreibst das JSONL einfach selbst.

## Optionen

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              maschinenlesbare Ausgabe
  --md                Markdown-Ausgabe, direkt in einen PR-Kommentar
  --fail-on <level>   Exit 1 bei: breaking (Standard), warning, never
  --latency <ratio>   markiert Latenzregressionen oberhalb dieses Verhältnisses (Standard 1.5)
  --cost <ratio>      markiert Kostensteigerungen oberhalb dieses Verhältnisses (Standard 1.25)
  --no-outputs        finale Ausgaben nicht vergleichen

whatbroke record --out <trace.jsonl>

  --port <n>          Port zum Lauschen (Standard 4141)
  --run <name>        Lauf-id, wenn kein x-whatbroke-run-Header gesendet wird
  --target <url>      leitet alles an diesen Origin weiter
```

## Warum nicht einfach Evals?

Nimm beides. Evals benoten jede Version gegen eine Rubrik. whatbroke beantwortet eine andere Frage: Was genau hat sich zwischen diesen beiden Versionen geändert, auf Tool-Aufruf-Ebene, ohne Rubrik zum Schreiben und ohne Richter, den man bezahlen muss. Es ist das Werkzeug, das man fünf Minuten nach einem neuen Modell-Release laufen lässt, bevor man entscheidet, ob die Eval-Suite überhaupt laufen muss.

Deterministisch, offline, keine API-Keys, keine Konten. Deine Traces verlassen nie deinen Rechner.

## Roadmap

- [x] Multi-Sample-Läufe, damit launisches Verhalten als Rate statt als Rauschen erscheint
- [x] Proxy-Aufzeichnung (`whatbroke record`), Traces ohne deinen Code anzufassen
- [ ] Importer für LangSmith- und Langfuse-Trace-Exporte
- [ ] Python-Recorder
- [ ] `whatbroke watch` zum automatischen Diffen gegen eine Baseline beim Iterieren
- [ ] Semantischer Ausgabenvergleich (Opt-in, eigener Key)

Issues und PRs willkommen. Wenn whatbroke etwas erwischt hat, das in deinem Agenten still kaputtging, würde ich das wirklich gern hören.

## Lizenz

MIT
