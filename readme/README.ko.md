<div align="center">

# whatbroke

**AI 에이전트의 두 실행 사이 동작을 diff로 비교하세요.**

[![npm](https://img.shields.io/npm/v/whatbroke-cli)](https://www.npmjs.com/package/whatbroke-cli) [![license](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md)

</div>

모델을 바꾸고, 프롬프트를 수정하고, 프레임워크 버전을 올린 다음 `whatbroke`를 실행하면 정확히 무엇이 달라졌는지 보입니다. 어떤 도구 호출이 사라졌는지, 어떤 인자가 슬며시 바뀌었는지, 비용과 지연 시간이 어느 쪽으로 움직였는지, 어떤 출력이 뒤집혔는지.

텍스트 diff로는 이걸 볼 수 없습니다. 에이전트는 "구독이 취소되었습니다"라고 말하면서 `cancel_subscription` 호출을 조용히 건너뛸 수 있습니다. 문장은 멀쩡해 보이지만, 동작은 망가진 거죠.

![모델 교체 후 사라진 도구 호출과 달라진 환불 금액을 보여주는 whatbroke 출력](../.github/demo.svg)

더 싼 모델로 갈아탔을 때 실제로 벌어진 일입니다. 에이전트는 75% 저렴해졌고, 분위기 검사는 계속 통과했지만, 실제로 구독을 취소하는 일은 그만뒀습니다. 환불 금액도 $42.50에서 $425로 바뀌었고요.

## 설치

```
npm install -g whatbroke-cli
```

또는 바로 실행:

```
npx whatbroke-cli diff before.jsonl after.jsonl
```

번들된 예제 trace로 지금 바로 시험해 보세요:

```
git clone https://github.com/arthi-arumugam-git/whatbroke
cd whatbroke && npm install && npm run build
node dist/cli.js diff examples/support-agent-gpt4o.jsonl examples/support-agent-gpt5mini.jsonl
```

## 동작 방식

1. 에이전트가 일하는 모습을 trace로 기록합니다 (한 줄에 이벤트 하나인 평범한 JSONL 파일).
2. 무언가를 바꿉니다. 모델, 프롬프트, 프레임워크 버전, 도구 설명, 무엇이든.
3. 새 버전이 같은 일을 하는 trace를 기록합니다.
4. `whatbroke diff old.jsonl new.jsonl`

whatbroke는 run을 id로 맞추고, 각 run 안의 도구 호출을 정렬한 뒤 다음을 보고합니다:

| 발견 | 심각도 |
|---|---|
| run이 실패하기 시작, 도구 호출 누락, 도구가 에러를 내기 시작, 출력 사라짐, run 자체가 사라짐 | breaking |
| 도구 인자 변경, 새 도구 호출, 도구 순서 변경, 출력 변경, 지연 시간이나 비용 악화 | changed |
| 모델 변경, 토큰 사용량 급변, run이 성공하게 됨 | info |

breaking이 나오면 종료 코드가 1이라 CI에 바로 넣을 수 있습니다:

```yaml
- run: node run-agent-suite.js --out traces/current.jsonl
- run: npx whatbroke-cli diff traces/baseline.jsonl traces/current.jsonl --md >> "$GITHUB_STEP_SUMMARY"
```

더 엄격하게 하려면 `--fail-on warning`, 리포트만 보려면 `--fail-on never`.

## 변덕스러운 에이전트

에이전트는 같은 일을 두 번 똑같이 하지 않습니다. 그래서 한 번짜리 전후 비교는 에이전트가 원래 내던 노이즈를 당신의 변경 탓으로 돌릴 수 있습니다. 각 시나리오를 몇 번씩 기록하고 run id에 접미사를 붙이세요:

```
refund-flow#1, refund-flow#2, refund-flow#3
```

whatbroke는 접미사를 알아채고, 변경 전 샘플 각각을 변경 후 샘플 각각과 비교해서 발견마다 발생률을 붙입니다:

```
! issue_refund called with different args (amount) (6/9 run pairs)
```

*베이스라인* 샘플 사이에서도 왔다 갔다 하는 발견은 flaky info로 강등됩니다. 에이전트가 변경 전부터 그렇게 굴었다는 뜻이니까요. 발생률이 절반 미만인 breaking은 warning으로 완화됩니다. 남는 것이 진짜 신호입니다.

## trace 기록하기

trace 포맷은 일부러 지루하게 만들었습니다. 어떤 언어로든 10분이면 쓸 수 있는 JSONL입니다.

```jsonl
{"type":"run_start","run":"refund-flow","meta":{"model":"gpt-4o"}}
{"type":"llm_call","run":"refund-flow","model":"gpt-4o","latency_ms":900,"tokens":{"input":512,"output":128},"cost_usd":0.004}
{"type":"tool_call","run":"refund-flow","name":"lookup_order","args":{"order_id":"A-1042"}}
{"type":"output","run":"refund-flow","content":"Refund issued."}
{"type":"run_end","run":"refund-flow","status":"ok"}
```

가장 빠른 방법은 프록시입니다. 코드 수정 없이, 어떤 언어든:

```
whatbroke record --out traces/current.jsonl
```

그다음 에이전트를 프록시로 향하게 하고 평소처럼 실행하면 됩니다:

```
OPENAI_BASE_URL=http://127.0.0.1:4141/v1 node my-agent.js
# 또는
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 node my-agent.js
```

모든 LLM 호출, 도구 호출, 최종 답변이 trace에 기록됩니다. 스트리밍도 되고, 응답은 손대지 않고 그대로 통과합니다. 여러 시나리오를 돌린다면 요청마다 `x-whatbroke-run` 헤더를 보내 run에 이름을 붙이세요.

Node라면 SDK가 기존 클라이언트를 감싸서 전부 자동으로 기록합니다:

```ts
import { Recorder } from "whatbroke";
import OpenAI from "openai";

const rec = new Recorder({ file: "traces/current.jsonl", run: "refund-flow" });
const openai = rec.wrapOpenAI(new OpenAI());

// openai를 평소처럼 쓰면 됩니다. llm 호출과 도구 호출이 기록됩니다
await runMyAgent(openai);

rec.output(finalAnswer);
rec.end("ok");
```

`rec.wrapAnthropic(client)`는 Anthropic SDK에 같은 일을 합니다. 그 외에는 `rec.llmCall()`, `rec.toolCall()`, `rec.output()`, `rec.end()`가 있고, JSONL을 직접 써도 됩니다.

## 옵션

```
whatbroke diff <before.jsonl> <after.jsonl>

  --json              기계가 읽을 수 있는 출력
  --md                markdown 출력, PR 코멘트에 바로 붙여넣기
  --fail-on <level>   종료 코드 1의 기준: breaking (기본), warning, never
  --latency <ratio>   이 비율을 넘는 지연 악화를 표시 (기본 1.5)
  --cost <ratio>      이 비율을 넘는 비용 증가를 표시 (기본 1.25)
  --no-outputs        최종 출력 비교 생략

whatbroke record --out <trace.jsonl>

  --port <n>          수신 포트 (기본 4141)
  --run <name>        x-whatbroke-run 헤더가 없을 때의 run id
  --target <url>      모든 요청을 이 origin으로 전달
```

## 그냥 eval을 쓰면 안 되나요?

둘 다 쓰세요. eval은 각 버전을 루브릭에 대고 채점합니다. whatbroke는 다른 질문에 답합니다. 이 두 버전 사이에 도구 호출 수준에서 정확히 무엇이 달라졌는가. 루브릭을 쓸 필요도, 심판에게 돈을 낼 필요도 없습니다. 새 모델이 나오고 5분 뒤에 먼저 돌려보고, eval 스위트를 돌릴 필요가 있는지 판단하는 도구입니다.

결정적이고, 오프라인이고, API 키도 계정도 필요 없습니다. trace는 절대 당신의 머신을 떠나지 않습니다.

## 로드맵

- [x] 멀티 샘플 실행. 변덕스러운 동작을 노이즈 대신 발생률로 표시
- [x] 프록시 캡처 (`whatbroke record`). 코드를 건드리지 않고 trace 확보
- [ ] LangSmith와 Langfuse trace 내보내기용 임포터
- [ ] Python 레코더
- [ ] `whatbroke watch`. 반복 작업 중 베이스라인과 자동 diff
- [ ] 의미 기반 출력 비교 (옵트인, 본인 키 사용)

이슈와 PR 환영합니다. whatbroke가 당신의 에이전트에서 조용히 망가진 무언가를 잡아냈다면, 정말로 그 이야기를 듣고 싶습니다.

## 라이선스

MIT
