<div align="center">

# whatbroke

**Comparez le comportement de votre agent IA entre deux exécutions.**

[![npm](https://img.shields.io/npm/v/whatbroke-cli)](https://www.npmjs.com/package/whatbroke-cli) [![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

Changez de modèle, retouchez un prompt, montez de version de framework, puis lancez `whatbroke` pour voir exactement ce qui a changé : quels appels d'outils ont disparu, quels arguments ont dérivé, où sont partis le coût et la latence, et quelles sorties se sont retournées.

Un diff de texte ne voit pas ça. Votre agent peut dire « votre abonnement est annulé » tout en sautant silencieusement l'appel `cancel_subscription`. Les mots ont l'air corrects. Le comportement est cassé.

![sortie de whatbroke montrant un appel d'outil disparu et un montant de remboursement modifié après un changement de modèle](../.github/demo.svg)

C'est un vrai cas de casse après passage à un modèle moins cher. L'agent est devenu 75 % moins cher, continuait de passer le test de l'intuition, et a arrêté d'annuler réellement les abonnements. Il s'est aussi mis à rembourser 425 $ au lieu de 42,50 $.

## Installation

```
npm install -g whatbroke-cli
```

Ou directement :

```
npx whatbroke-cli diff before.jsonl after.jsonl
```

Essayez tout de suite avec les traces d'exemple incluses :

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## Comment ça marche

1. Enregistrez une trace de votre agent en train de faire son travail (un simple fichier JSONL, un événement par ligne).
2. Changez quelque chose. Modèle, prompt, version de framework, descriptions d'outils, n'importe quoi.
3. Enregistrez une trace de la nouvelle version sur le même travail.
4. `whatbroke diff old.jsonl new.jsonl`

whatbroke aligne les exécutions par id, aligne les appels d'outils au sein de chaque exécution, et rapporte :

| Constat | Sévérité |
|---|---|
| L'exécution se met à échouer, appel d'outil disparu, l'outil renvoie désormais une erreur, sortie disparue, exécution manquante | breaking |
| Arguments d'outil modifiés, nouveaux appels, outils réordonnés, sortie modifiée, régression de latence ou de coût | changed |
| Changement de modèle, fortes variations de tokens, l'exécution réussit désormais | info |

Le code de sortie vaut 1 dès qu'un breaking apparaît, donc ça se branche directement dans la CI :

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke-cli diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

`--fail-on warning` pour des garde-fous plus stricts, `--fail-on never` si vous voulez juste le rapport.

## Agents instables

Un agent ne fait jamais deux fois la même chose, donc une comparaison unique avant/après peut imputer à votre changement du bruit que l'agent produisait déjà. Enregistrez chaque scénario plusieurs fois et suffixez les ids :

```
refund-flow#1, refund-flow#2, refund-flow#3
```

whatbroke repère les suffixes, compare chaque échantillon d'avant à chaque échantillon d'après, et attache un taux à chaque constat :

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

Tout ce qui varie aussi entre deux échantillons de *référence* est rétrogradé en info flaky, parce que votre agent se comportait déjà comme ça avant le changement. Les constats breaking présents dans moins de la moitié des paires s'adoucissent en warning. Ce qui reste, c'est du signal.

## Enregistrer des traces

Le format de trace est volontairement ennuyeux : du JSONL que vous pouvez écrire depuis n'importe quel langage en dix minutes.

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

Le moyen le plus rapide d'en obtenir une, c'est le proxy. Zéro changement de code, n'importe quel langage :

```
whatbroke record --out traces/current.jsonl
```

Puis pointez votre agent dessus et lancez-le exactement comme d'habitude :

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# ou
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

Chaque appel LLM, chaque appel d'outil et la réponse finale atterrissent dans la trace. Le streaming fonctionne, les réponses passent intactes. Si vous enchaînez plusieurs scénarios, envoyez un en-tête `x-whatbroke-run` par requête pour nommer les exécutions.

Si vous êtes sous Node, le SDK enveloppe votre client existant et enregistre tout automatiquement :

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// utilisez openai exactement comme avant ; les appels llm et outils sont capturés
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)` fait pareil pour le SDK Anthropic. Pour tout le reste, il y a `rec.llmCall()`, `rec.toolCall()`, `rec.output()`, `rec.end()`, ou écrivez le JSONL vous-même.

## Options

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              sortie lisible par machine
  --md                sortie markdown, à coller dans un commentaire de PR
  --fail-on <level>   sortir avec 1 sur : breaking (défaut), warning, never
  --latency <ratio>   signale les régressions de latence au-delà de ce ratio (défaut 1.5)
  --cost <ratio>      signale les hausses de coût au-delà de ce ratio (défaut 1.25)
  --no-outputs        ne pas comparer les sorties finales

whatbroke record --out <trace.jsonl>

  --port <n>          port d'écoute (défaut 4141)
  --run <name>        id d'exécution quand aucun en-tête x-whatbroke-run n'arrive
  --target <url>      transfère tout vers cette origine
```

## Pourquoi pas juste des evals ?

Utilisez les deux. Les evals notent chaque version contre une grille. whatbroke répond à une autre question : qu'est-ce qui a exactement changé entre ces deux versions, au niveau des appels d'outils, sans grille à écrire et sans juge à payer. C'est l'outil qu'on lance cinq minutes après la sortie d'un nouveau modèle, avant de décider si la suite d'evals a même besoin de tourner.

Déterministe, hors ligne, pas de clé API, pas de compte. Vos traces ne quittent jamais votre machine.

## Feuille de route

- [x] Exécutions multi-échantillons, pour que l'instabilité apparaisse comme un taux et non du bruit
- [x] Capture par proxy (`whatbroke record`), des traces sans toucher à votre code
- [ ] Importeurs pour les exports de traces LangSmith et Langfuse
- [ ] Enregistreur Python
- [ ] `whatbroke watch` pour comparer automatiquement à une référence pendant que vous itérez
- [ ] Comparaison sémantique des sorties (opt-in, avec votre propre clé)

Issues et PR bienvenues. Si whatbroke a attrapé quelque chose qui cassait en silence dans votre agent, j'aimerais sincèrement le savoir.

## Licence

MIT
