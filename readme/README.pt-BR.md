<div align="center">

# whatbroke

**Compare o comportamento do seu agente de IA entre duas execuções.**

[![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

Troque de modelo, ajuste um prompt, suba a versão do framework, e depois rode `whatbroke` para ver exatamente o que mudou: quais chamadas de ferramenta sumiram, quais argumentos derivaram, para onde foram custo e latência, e quais saídas viraram do avesso.

Diff de texto não enxerga isso. Seu agente pode dizer "sua assinatura foi cancelada" enquanto pula silenciosamente a chamada `cancel_subscription`. As palavras parecem certas. O comportamento quebrou.

![saída do whatbroke mostrando uma chamada de ferramenta perdida e valor de reembolso alterado após troca de modelo](../.github/demo.svg)

Esse é um caso real de troca para um modelo mais barato. O agente ficou 75% mais barato, continuou passando no teste do cheiro, e parou de cancelar assinaturas de verdade. Também começou a reembolsar $425 em vez de $42.50.

## Instalação

```
npm install -g whatbroke
```

Ou rode direto:

```
npx whatbroke diff before.jsonl after.jsonl
```

Experimente agora com os traces de exemplo que vêm no pacote:

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## Como funciona

1. Grave um trace do seu agente fazendo o trabalho dele (um arquivo JSONL simples, um evento por linha).
2. Mude alguma coisa. Modelo, prompt, versão do framework, descrição de ferramentas, qualquer coisa.
3. Grave um trace da versão nova fazendo o mesmo trabalho.
4. `whatbroke diff old.jsonl new.jsonl`

O whatbroke alinha execuções por id, alinha as chamadas de ferramenta dentro de cada execução, e reporta:

| Achado | Severidade |
|---|---|
| Execução passou a falhar, chamada de ferramenta perdida, ferramenta agora dá erro, saída sumiu, execução ausente | breaking |
| Argumentos de ferramenta mudaram, novas chamadas, ferramentas reordenadas, saída mudou, regressão de latência ou custo | changed |
| Modelo mudou, grandes oscilações de tokens, execução agora dá certo | info |

O código de saída é 1 quando aparece algo breaking, então dá para colocar direto no CI:

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

`--fail-on warning` se você quer portões mais rígidos, `--fail-on never` se só quer o relatório.

## Agentes instáveis

Agente nunca faz a mesma coisa duas vezes, então uma comparação única antes/depois pode culpar sua mudança pelo ruído que o agente já fazia. Grave cada cenário algumas vezes e coloque um sufixo nos ids:

```
refund-flow#1, refund-flow#2, refund-flow#3
```

O whatbroke percebe os sufixos, compara cada amostra de antes com cada amostra de depois, e coloca uma taxa em cada achado:

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

Tudo que também oscila entre duas amostras da *linha de base* é rebaixado para info flaky, porque seu agente já se comportava assim antes da mudança. Achados breaking que aparecem em menos da metade dos pares amolecem para warning. O que sobra é sinal.

## Gravando traces

O formato do trace é deliberadamente sem graça: JSONL que dá para escrever em qualquer linguagem em dez minutos.

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

O jeito mais rápido de conseguir um é o proxy. Zero mudança de código, qualquer linguagem:

```
whatbroke record --out traces/current.jsonl
```

Depois aponte seu agente para ele e rode exatamente como sempre:

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# ou
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

Cada chamada de LLM, chamada de ferramenta e resposta final cai no trace. Streaming funciona, as respostas passam intactas. Se você roda vários cenários, mande um header `x-whatbroke-run` por requisição para nomear as execuções.

Se você está em Node, o SDK embrulha seu cliente existente e grava tudo automaticamente:

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// use openai exatamente como antes; chamadas de llm e de ferramenta são capturadas
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)` faz o mesmo para o SDK da Anthropic. Para todo o resto existem `rec.llmCall()`, `rec.toolCall()`, `rec.output()`, `rec.end()`, ou simplesmente escreva o JSONL você mesmo.

## Opções

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              saída legível por máquina
  --md                saída em markdown, cole num comentário de PR
  --fail-on <level>   sai com 1 em: breaking (padrão), warning, never
  --latency <ratio>   marca regressões de latência acima dessa razão (padrão 1.5)
  --cost <ratio>      marca aumentos de custo acima dessa razão (padrão 1.25)
  --no-outputs        pula a comparação das saídas finais

whatbroke record --out <trace.jsonl>

  --port <n>          porta de escuta (padrão 4141)
  --run <name>        id da execução quando não vem header x-whatbroke-run
  --target <url>      encaminha tudo para essa origem
```

## Por que não usar só evals?

Use os dois. Evals dão nota para cada versão contra uma rubrica. O whatbroke responde outra pergunta: o que exatamente mudou entre essas duas versões, no nível da chamada de ferramenta, sem rubrica para escrever e sem juiz para pagar. É o que você roda cinco minutos depois que um modelo novo sai, antes de decidir se sua suíte de evals precisa mesmo rodar.

Determinístico, offline, sem chave de API, sem conta. Seus traces nunca saem da sua máquina.

## Roadmap

- [x] Execuções multi-amostra, para comportamento instável aparecer como taxa em vez de ruído
- [x] Captura por proxy (`whatbroke record`), traces sem tocar no seu código
- [ ] Importadores para exports de trace do LangSmith e do Langfuse
- [ ] Gravador em Python
- [ ] `whatbroke watch` para comparar com uma linha de base enquanto você itera
- [ ] Comparação semântica de saídas (opt-in, com sua própria chave)

Issues e PRs são bem-vindos. Se o whatbroke pegou algo quebrando em silêncio no seu agente, eu adoraria saber.

## Licença

MIT
