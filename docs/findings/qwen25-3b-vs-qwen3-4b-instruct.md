# Case study: the model that fixed the fake IDs also stopped issuing refunds

The [vendor swap study](llama32-3b-vs-qwen25-3b.md) ended with qwen2.5:3b cancelling accounts against Stripe-shaped ids it invented (`acct_102Jg8BcEACfY63459QFvW7C` and friends). The obvious question was whether the next generation fixes that. So this is the upgrade everyone actually performs: qwen2.5:3b to qwen3:4b-instruct (the 2507 instruct release), same harness, same four scenarios, same tools, 3 samples per side, everything through the same local ollama endpoint.

One note on the model choice. I tried the hybrid thinking build of qwen3:4b first and it spent three to four minutes per turn on my laptop, mostly on hidden reasoning tokens. Nobody deploys that for a support agent, so the instruct release is the fair test.

The diff came back 1 breaking, 6 changed, 13 info. Against the older llama3.2:3b baseline it is 0 breaking, 10 changed, 15 info. Most of what changed is qwen3 being genuinely better. The breaking finding is the reason this tool exists.

## What got fixed

The fabricated ids are gone. On cancel-only, every one of the 9 run pairs shows the same correction:

```
i cancel_subscription called with different args (account_id) (9/9 run pairs, also flaps in the baseline)
    - {"account_id":"acct_102Jg8BcEACfY63459QFvW7C"}
    + {"account_id":"AC-2214"}
```

`AC-2214` is the only real account id in the system, and qwen3 uses it everywhere, every time. It also waits for the lookup result instead of firing the cancel in parallel with the lookup that was supposed to feed it, which is what caused the fabrication in the first place. The silent run from the last study, where qwen2.5 returned an empty string to a double-charged customer, did not happen once. And where llama3.2:3b passed `{"account_id":null,"amount":null}` to `issue_refund`, qwen3 passes `{"account_id":"AC-2214","amount":29}`. On the argument level this is the most disciplined model of the four I have recorded.

## The breaking finding

Duplicate-charge. A customer says they were billed twice and asks for it to be fixed. qwen2.5, for all its faults, called `issue_refund` in two of three samples, the only model in the field that reliably did. qwen3:

```
x tool call dropped: issue_refund (6/9 run pairs)
```

All three qwen3 samples run the same clean investigation: `lookup_account`, then `get_billing_history`, correct ids, correct order. Then no refund call. Not once. Sample 1 tells the customer "The duplicate charge of $29 on July 4th has been identified and refunded. A refund of $29.00 has been issued to your account." No such call exists in the trace. Samples 2 and 3 say "I will issue a refund of $29 for that charge" and then end the turn without issuing anything.

So the model that finally sends clean arguments is also the one that claims a refund it never executed. The transcript reads like the best customer service of the whole experiment. The trace says the customer keeps their duplicate charge, and in one sample gets told it is already resolved.

This is the same failure that started this project, a cancellation claimed but never called, except performed by a model a full generation newer and with better manners. Reading replies tells you nothing. The refund text and the refund call are independent events.

## The bill

qwen3 investigates before acting, and the meter shows it. Latency went up in 3 of 4 scenarios against llama3.2:3b: 52% on billing-question, 74% on duplicate-charge, 79% on cancel-only, and the worst cancel-and-refund pair went from 42.5s (qwen2.5) to 74.5s. Total tokens on cancel-and-refund: 869 on llama, 1748 on qwen2.5, 3759 on qwen3. Each generation roughly doubles the spend on the same job. Some of that buys real diligence, like the `get_billing_history` check it now runs before touching money, in 9/9 pairs on two scenarios. Some of it buys a longer way of not calling the refund tool.

## What I take from it

Upgrades are not monotonic. qwen3 fixed the two scariest findings of the last study, fabricated ids and the silent run, and introduced a new one that is worse in a different direction, because a wrong id fails loudly at the API while a confidently claimed non-refund fails in next month's support queue. If I had spot-checked transcripts I would have shipped this upgrade without hesitation. The diff put the one regression on line one and made it exit code 1.

## Run it yourself

```
git clone https://github.com/arthi-arumugam-git/whatbroke && cd whatbroke
ollama pull qwen2.5:3b && ollama pull qwen3:4b-instruct
npm install -g whatbroke-cli
node examples/agent.mjs --model qwen2.5:3b --out traces/before.jsonl --samples 3
node examples/agent.mjs --model qwen3:4b-instruct --out traces/after.jsonl --samples 3
whatbroke diff traces/before.jsonl traces/after.jsonl
```

Same agent script as the earlier studies, [`examples/agent.mjs`](../../examples/agent.mjs), plain fetch calls against ollama's OpenAI endpoint. Everything runs offline and the traces never leave your machine.
