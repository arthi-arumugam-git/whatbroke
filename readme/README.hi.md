<div align="center">

# whatbroke

**अपने AI एजेंट के दो रन के बीच व्यवहार का diff देखें।**

[![npm](https://img.shields.io/npm/v/whatbroke-cli)](https://www.npmjs.com/package/whatbroke-cli) [![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

मॉडल बदलिए, प्रॉम्प्ट में फेरबदल कीजिए, फ्रेमवर्क का वर्ज़न बढ़ाइए, फिर `whatbroke` चलाइए और ठीक-ठीक देखिए कि क्या बदला: कौन से टूल कॉल गायब हो गए, कौन से आर्ग्युमेंट खिसक गए, लागत और लेटेंसी किधर गई, और कौन से आउटपुट पलट गए।

टेक्स्ट diff यह नहीं देख सकता। आपका एजेंट "आपकी सब्सक्रिप्शन रद्द हो गई है" कह सकता है और चुपचाप `cancel_subscription` कॉल छोड़ सकता है। शब्द ठीक लगते हैं। व्यवहार टूट चुका है।

![मॉडल बदलने के बाद गायब टूल कॉल और बदली हुई रिफ़ंड राशि दिखाता whatbroke का आउटपुट](../.github/demo.svg)

यह सस्ते मॉडल पर जाने का असली किस्सा है। एजेंट 75% सस्ता हो गया, देखने में सब ठीक लगता रहा, और उसने सच में सब्सक्रिप्शन रद्द करना बंद कर दिया। साथ ही $42.50 की जगह $425 रिफ़ंड करने लगा।

## इंस्टॉल

```
npm install -g whatbroke-cli
```

या सीधे चलाइए:

```
npx whatbroke-cli diff before.jsonl after.jsonl
```

साथ में दिए गए उदाहरण trace से अभी आज़माइए:

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## यह कैसे काम करता है

1. एजेंट को उसका काम करते हुए एक trace में रिकॉर्ड कीजिए (सादी JSONL फ़ाइल, हर लाइन पर एक इवेंट)।
2. कुछ बदलिए। मॉडल, प्रॉम्प्ट, फ्रेमवर्क वर्ज़न, टूल के विवरण, कुछ भी।
3. नए वर्ज़न से वही काम करवाकर दूसरा trace रिकॉर्ड कीजिए।
4. `whatbroke diff old.jsonl new.jsonl`

whatbroke रन को id से मिलाता है, हर रन के अंदर टूल कॉल को मिलाता है, और रिपोर्ट करता है:

| नतीजा | गंभीरता |
|---|---|
| रन फेल होने लगा, टूल कॉल गायब, टूल अब एरर देता है, आउटपुट गायब, रन ही गायब | breaking |
| टूल आर्ग्युमेंट बदले, नए टूल कॉल, टूल का क्रम बदला, आउटपुट बदला, लेटेंसी या लागत बिगड़ी | changed |
| मॉडल बदला, टोकन में बड़ा उतार-चढ़ाव, रन अब सफल है | info |

कुछ भी breaking मिलने पर exit code 1 होता है, इसलिए इसे सीधे CI में लगाया जा सकता है:

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke-cli diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

सख़्ती चाहिए तो `--fail-on warning`, सिर्फ़ रिपोर्ट चाहिए तो `--fail-on never`।

## अस्थिर एजेंट

एजेंट कभी एक ही काम दो बार एक जैसा नहीं करता, इसलिए एक बार का पहले/बाद का मुक़ाबला उस शोर का इल्ज़ाम भी आपके बदलाव पर डाल सकता है जो एजेंट पहले से कर रहा था। हर परिदृश्य को कुछ बार रिकॉर्ड कीजिए और run id में suffix जोड़िए:

```
refund-flow#1, refund-flow#2, refund-flow#3
```

whatbroke इन suffix को पहचानता है, पहले के हर नमूने की तुलना बाद के हर नमूने से करता है, और हर नतीजे पर एक दर लगाता है:

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

जो चीज़ दो *baseline* नमूनों के बीच भी बदलती रहती है, वह flaky info बनकर नीचे चली जाती है, क्योंकि आपका एजेंट बदलाव से पहले भी ऐसा ही करता था। आधे से कम जोड़ों में दिखने वाले breaking नतीजे warning बन जाते हैं। जो बचता है, वही असली संकेत है।

## trace रिकॉर्ड करना

trace का फ़ॉर्मैट जानबूझकर उबाऊ रखा गया है: ऐसी JSONL जो किसी भी भाषा से दस मिनट में लिखी जा सकती है।

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

सबसे तेज़ तरीका है proxy। कोड में शून्य बदलाव, कोई भी भाषा:

```
whatbroke record --out traces/current.jsonl
```

फिर अपने एजेंट को इसकी ओर मोड़िए और हमेशा की तरह चलाइए:

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# या
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

हर LLM कॉल, टूल कॉल और आख़िरी जवाब trace में दर्ज होता है। स्ट्रीमिंग चलती है, जवाब जस के तस गुज़र जाते हैं। कई परिदृश्य चला रहे हों तो हर अनुरोध में `x-whatbroke-run` हेडर भेजकर रन को नाम दीजिए।

Node में हों तो SDK आपके मौजूदा क्लाइंट को लपेटकर सब कुछ अपने आप रिकॉर्ड कर लेता है:

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// openai को पहले जैसे ही इस्तेमाल कीजिए; llm और टूल कॉल दर्ज होते रहेंगे
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)` Anthropic SDK के लिए वही करता है। बाक़ी सबके लिए `rec.llmCall()`, `rec.toolCall()`, `rec.output()`, `rec.end()` हैं, या JSONL ख़ुद ही लिख लीजिए।

## विकल्प

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              मशीन के पढ़ने लायक आउटपुट
  --md                markdown आउटपुट, सीधे PR कमेंट में चिपकाइए
  --fail-on <level>   exit 1 कब हो: breaking (डिफ़ॉल्ट), warning, never
  --latency <ratio>   इस अनुपात से ऊपर की लेटेंसी गिरावट को चिह्नित करे (डिफ़ॉल्ट 1.5)
  --cost <ratio>      इस अनुपात से ऊपर की लागत वृद्धि को चिह्नित करे (डिफ़ॉल्ट 1.25)
  --no-outputs        आख़िरी आउटपुट की तुलना छोड़ दे

whatbroke record --out <trace.jsonl>

  --port <n>          पोर्ट (डिफ़ॉल्ट 4141)
  --run <name>        जब x-whatbroke-run हेडर न आए तब का run id
  --target <url>      सब कुछ इस origin पर भेज दे
```

## सिर्फ़ evals क्यों नहीं?

दोनों इस्तेमाल कीजिए। evals हर वर्ज़न को एक rubric पर नंबर देते हैं। whatbroke एक अलग सवाल का जवाब देता है: इन दो वर्ज़न के बीच टूल-कॉल के स्तर पर ठीक-ठीक क्या बदला, बिना कोई rubric लिखे और बिना किसी judge को पैसे दिए। नया मॉडल आने के पाँच मिनट बाद यही चलाया जाता है, यह तय करने से पहले कि eval suite चलाने की ज़रूरत भी है या नहीं।

Deterministic, offline, न API key चाहिए, न कोई खाता। आपके trace कभी आपकी मशीन से बाहर नहीं जाते।

## आगे की योजना

- [x] मल्टी-सैंपल रन, ताकि अस्थिर व्यवहार शोर के बजाय दर के रूप में दिखे
- [x] proxy से रिकॉर्डिंग (`whatbroke record`), कोड छुए बिना trace
- [ ] LangSmith और Langfuse के trace export के लिए importer
- [ ] Python recorder
- [ ] `whatbroke watch`, काम करते-करते baseline से अपने आप diff
- [ ] semantic आउटपुट तुलना (opt-in, अपनी key के साथ)

Issue और PR का स्वागत है। अगर whatbroke ने आपके एजेंट में चुपचाप टूटी कोई चीज़ पकड़ी हो, तो मुझे सच में जानना अच्छा लगेगा।

## लाइसेंस

MIT
