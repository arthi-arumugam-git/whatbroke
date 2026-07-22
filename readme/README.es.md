<div align="center">

# whatbroke

**Compara el comportamiento de tu agente de IA entre dos ejecuciones.**

[![npm](https://img.shields.io/npm/v/whatbroke-cli)](https://www.npmjs.com/package/whatbroke-cli) [![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

Cambia de modelo, retoca un prompt, sube la versión del framework, y luego ejecuta `whatbroke` para ver exactamente qué cambió: qué llamadas a herramientas desaparecieron, qué argumentos se desviaron, hacia dónde se movieron el coste y la latencia, y qué salidas se dieron la vuelta.

Un diff de texto no puede ver esto. Tu agente puede decir "tu suscripción ha sido cancelada" mientras se salta en silencio la llamada a `cancel_subscription`. Las palabras se ven bien. El comportamiento se rompió.

![salida de whatbroke mostrando una llamada a herramienta perdida y un importe de reembolso cambiado tras un cambio de modelo](../.github/demo.svg)

Ese es un fallo real de cambiar a un modelo más barato. El agente salió un 75% más barato, seguía pasando la prueba del olfato, y dejó de cancelar suscripciones de verdad. También empezó a reembolsar $425 en vez de $42.50.

## Instalación

```
npm install -g whatbroke-cli
```

O ejecútalo directamente:

```
npx whatbroke-cli diff before.jsonl after.jsonl
```

Pruébalo ahora mismo con las trazas de ejemplo incluidas:

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## Cómo funciona

1. Graba una traza de tu agente haciendo su trabajo (un archivo JSONL plano, un evento por línea).
2. Cambia algo. Modelo, prompt, versión del framework, descripciones de herramientas, lo que sea.
3. Graba una traza de la nueva versión haciendo el mismo trabajo.
4. `whatbroke diff old.jsonl new.jsonl`

whatbroke alinea las ejecuciones por id, alinea las llamadas a herramientas dentro de cada ejecución, y reporta:

| Hallazgo | Severidad |
|---|---|
| La ejecución empezó a fallar, llamada a herramienta perdida, la herramienta ahora da error, salida desaparecida, ejecución ausente | breaking |
| Argumentos de herramienta cambiados, nuevas llamadas, herramientas reordenadas, salida cambiada, regresión de latencia o coste | changed |
| Cambio de modelo, oscilaciones grandes de tokens, la ejecución ahora tiene éxito | info |

El código de salida es 1 cuando aparece algo breaking, así que puedes meterlo directamente en CI:

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke-cli diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

`--fail-on warning` si quieres puertas más estrictas, `--fail-on never` si solo quieres el informe.

## Agentes inestables

Los agentes nunca hacen lo mismo dos veces, así que una comparación única antes/después puede culpar a tu cambio del ruido que el agente ya estaba haciendo. Graba cada escenario varias veces y añade un sufijo a los ids:

```
refund-flow#1, refund-flow#2, refund-flow#3
```

whatbroke detecta los sufijos, compara cada muestra de antes contra cada muestra de después, y pone una tasa a cada hallazgo:

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

Todo lo que también oscila entre dos muestras de *línea base* se degrada a info flaky, porque tu agente ya se comportaba así antes del cambio. Los hallazgos breaking que aparecen en menos de la mitad de los pares se suavizan a warning. Lo que queda es señal.

## Grabar trazas

El formato de traza es deliberadamente aburrido: JSONL que puedes escribir desde cualquier lenguaje en diez minutos.

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

La forma más rápida de conseguir una es el proxy. Cero cambios de código, cualquier lenguaje:

```
whatbroke record --out traces/current.jsonl
```

Luego apunta tu agente hacia él y ejecútalo exactamente como siempre:

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# o
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

Cada llamada al LLM, cada llamada a herramienta y la respuesta final acaban en la traza. El streaming funciona, las respuestas pasan intactas. Si ejecutas varios escenarios, envía una cabecera `x-whatbroke-run` por petición para nombrar las ejecuciones.

Si estás en Node, el SDK envuelve tu cliente existente y lo graba todo automáticamente:

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// usa openai exactamente como antes; las llamadas al llm y a herramientas quedan registradas
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)` hace lo mismo para el SDK de Anthropic. Para todo lo demás están `rec.llmCall()`, `rec.toolCall()`, `rec.output()`, `rec.end()`, o simplemente escribe el JSONL tú mismo.

## Opciones

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              salida legible por máquina
  --md                salida en markdown, pégala en un comentario de PR
  --fail-on <level>   sal con 1 en: breaking (por defecto), warning, never
  --latency <ratio>   marca regresiones de latencia por encima de este ratio (por defecto 1.5)
  --cost <ratio>      marca aumentos de coste por encima de este ratio (por defecto 1.25)
  --no-outputs        no compares las salidas finales

whatbroke record --out <trace.jsonl>

  --port <n>          puerto de escucha (por defecto 4141)
  --run <name>        id de ejecución cuando no llega cabecera x-whatbroke-run
  --target <url>      reenvía todo a este origen
```

## ¿Por qué no usar evals sin más?

Usa ambos. Los evals puntúan cada versión contra una rúbrica. whatbroke responde a una pregunta distinta: qué cambió exactamente entre estas dos versiones, a nivel de llamada a herramienta, sin rúbrica que escribir y sin juez al que pagar. Es lo que ejecutas cinco minutos después de que salga un modelo nuevo, antes de decidir si tu suite de evals siquiera necesita correr.

Determinista, offline, sin claves de API, sin cuentas. Tus trazas nunca salen de tu máquina.

## Hoja de ruta

- [x] Ejecuciones multi-muestra, para que el comportamiento inestable aparezca como una tasa y no como ruido
- [x] Captura por proxy (`whatbroke record`), trazas sin tocar tu código
- [ ] Importadores para exportaciones de trazas de LangSmith y Langfuse
- [ ] Grabador para Python
- [ ] `whatbroke watch` para comparar contra una línea base mientras iteras
- [ ] Comparación semántica de salidas (opcional, con tu propia clave)

Issues y PRs bienvenidos. Si whatbroke pilló algo rompiéndose en silencio en tu agente, me encantaría saberlo.

## Licencia

MIT
