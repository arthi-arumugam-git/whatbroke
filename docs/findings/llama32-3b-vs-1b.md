# Case study: what a 3x smaller model changed in a tool-calling agent

Everyone I know has had this conversation. The agent works. The bill arrives. Someone asks whether the small model could do the job. So you swap the model string, run a few chats, the replies read fine, and you ship it.

The problem is that "the replies read fine" measures the wrong layer. An agent's job is mostly tool calls. It can tell the user their subscription is cancelled while never calling `cancel_subscription`. The words pass every vibe check you have. The behavior is broken.

I wanted to see this happen on the record, with a setup anyone can reproduce for free. No cloud, no API keys, one laptop.

## The setup

A small customer-support agent for a fictional SaaS. Four scenarios:

- cancel-and-refund: cancel my subscription and refund the last charge
- billing-question: how much am I paying, when do I renew
- duplicate-charge: I was charged twice, refund the duplicate
- cancel-only: cancel immediately, do not bill me again

Four real tools with real schemas: `lookup_account`, `get_billing_history`, `cancel_subscription`, `issue_refund`. The tool results are stubbed, the tool calling is not. The system prompt tells the agent to never claim an action happened unless the tool call succeeded.

The baseline runs on llama3.2:3b through ollama's OpenAI-compatible endpoint. Then I swap one string, `llama3.2:3b` to `llama3.2:1b`, and run the identical scenarios again. That is the whole change. The cheap-model move in its purest form.

Because small local models are nondeterministic even at temperature 0.2, each scenario runs 3 times per model. whatbroke reads the `#1 #2 #3` suffixes and compares every baseline sample against every after sample, so each finding comes with a rate instead of an anecdote. Anything the 3b model already flip-flopped on between its own samples gets demoted to noise, because that behavior predates the swap.

## What the diff found

Totals first: 0 breaking, 3 changed, 12 info.

I expected a horror story about dropped cancellations. I almost got to write one, and the tool stopped me. More on that in a second. What survived the noise filter was stranger.

The finding I care about most, from the duplicate-charge scenario:

```
! lookup_account called with different args (email, type, required, properties) (6/9 run pairs)
    - {"email":"maya.iyer@example.com"}
    + {"type":"object","required":["email"],"properties":{"email":{"description":"customer email","type":"string"}}}
```

Read that diff line again. In 6 of 9 run pairs, the 1b model called the tool with the tool's own JSON schema as the arguments. Not the customer's email. The parameter definition, echoed back as the parameters. The reply text that followed was calm, competent customer-service prose about processing the refund. Nothing in the transcript reads like a model that just sent `"type": "object"` to a billing lookup.

The other changed findings were latency: up 61% on duplicate-charge (17.7s to 28.5s, 3/9 pairs) and up 63% on one cancel-and-refund pair. Which is its own small lesson, because the 1b model was faster on the three scenarios it handled cleanly (the cancel flow went from 25.4s to 12.3s). Cheaper was only faster where the model didn't get confused. Where it struggled, it looped and got slower.

## The headline that didn't survive

Here is the finding I would have led with if I had run each scenario once:

```
i tool call dropped: cancel_subscription (6/9 run pairs, also flaps in the baseline)
```

The 1b model skipped the actual cancellation call in most pairs while telling the customer everything was cancelled. That is the nightmare scenario this whole tool exists for, and it happened. But look at the annotation: also flaps in the baseline. The 3b model dropped the same call between its own three baseline samples. The behavior predates the swap. Blaming the downgrade would have been a lie with a screenshot.

Same story on cancel-only, where both models passed garbage as the account id (the 3b sent an empty object, the 1b sent the literal string "lookup_account"). Baseline flakiness, honestly labeled. My agent has a pre-existing condition, and the diff told me that instead of letting me blame the new model for it.

A single before/after run would have let me cherry-pick either a horror story or an all-clear. Nine pairs per scenario gave me rates instead, and the rates changed the story.

## Why text diffs and vibes miss this

A text diff of the final replies would compare two polite paragraphs and find some reworded sentences. It has no opinion on whether `issue_refund` ran, what amount it was called with, or whether the cancel actually happened. Eyeballing transcripts is worse, because the failure mode of a smaller model is rarely gibberish. It is confident prose wrapped around a missing or malformed tool call. The reply is the last place the damage shows up.

Evals help, but they answer a different question. An eval scores a version against a rubric you had to write. A behavioral diff answers what exactly changed between these two versions, at the tool-call level, with nothing to write and no judge to pay. It is the five-minute check you run before deciding whether the eval suite even needs to run.

## Run it on your own agent

The whole experiment is a model pull and five commands:

```
ollama pull llama3.2:3b && ollama pull llama3.2:1b
npm install -g whatbroke-cli
node agent.mjs llama3.2:3b traces/before.jsonl 3
node agent.mjs llama3.2:1b traces/after.jsonl 3
whatbroke diff traces/before.jsonl traces/after.jsonl
```

The agent script is 190 lines of plain fetch calls, no framework. For your own agent you do not even need the SDK: `whatbroke record` starts a local proxy, you point `OPENAI_BASE_URL` at it, and run your agent unchanged. Everything is offline and the traces never leave your machine.
