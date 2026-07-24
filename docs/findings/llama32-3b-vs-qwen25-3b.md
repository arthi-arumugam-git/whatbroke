# Case study: a same-size vendor swap changed more than the 3x downgrade

The [first case study](llama32-3b-vs-1b.md) was the classic cheap-model move, llama3.2:3b down to llama3.2:1b. That diff came back 0 breaking, 3 changed, 12 info. This one holds the size constant and swaps the vendor instead: llama3.2:3b to qwen2.5:3b. Both are 3B-class models, about 2 GB each on disk, running through the same ollama endpoint. Same four scenarios, same prompts, same tools, 3 samples per scenario per side. One string changed.

The diff came back 0 breaking, 12 changed, 15 info. Four times as many changed findings as dropping to a model a third of the size. I expected the vendor swap to be the quiet one. It was the loud one, and the interesting part is that about half of what changed was qwen behaving better.

## The setup

Same harness as the first study: a customer-support agent for a fictional SaaS with four real tool schemas (`lookup_account`, `get_billing_history`, `cancel_subscription`, `issue_refund`) and four scenarios (cancel-and-refund, billing-question, duplicate-charge, cancel-only). The baseline is the same llama3.2:3b trace recorded for the first study, 12 runs, all clean. The qwen2.5:3b side is a fresh run of the identical script. Because both models are nondeterministic at temperature 0.2, whatbroke compares every baseline sample against every after sample, so each finding carries a rate out of 9 run pairs, and anything the baseline already flip-flopped on gets demoted to noise.

## The headline: it cancelled an account it invented

On cancel-only, qwen looks like the better-trained model at first glance. It called `lookup_account` before cancelling in 9/9 run pairs, a step the llama baseline skipped every time. Then read the arguments it sent to the cancel:

```
i cancel_subscription called with different args (email, account_id) (9/9 run pairs, also flaps in the baseline)
    - {"email":"maya.iyer@example.com","account_id":{}}
    + {"account_id":"acct_102Jg8BcEACfY63459QFvW7C"}
```

The only account id in this system is `AC-2214`. There is no `acct_` anything. The trace shows why: qwen emits `lookup_account` and `cancel_subscription` in the same turn, in parallel, so it has to pick the cancel arguments before the lookup result exists, and it fills the hole with a Stripe-shaped id it made up. All three samples did this, each with a different fabricated id (`acct_102Jg8BcEACfY63459QFvW7C`, `acct_102J85K9E3G64VWQ`, `acct_102J84GK63WgUvR9XxY7QcZD`). Against a real billing API that call is a 404 on a good day and someone else's subscription on a bad one. The reply to the customer, of course, says the account is cancelled.

whatbroke filed this as info rather than changed, because the baseline's account id was already garbage (llama once sent an empty object). Fair. Sending junk in that field predates the swap. But the shape of the junk changed in a way that matters: llama's empty object fails loudly at the first schema check, while qwen's well-formed plausible id sails through validation and fails wherever your billing system decides a missing account fails. The diff line is what made me open the trace and find that.

## The run that vanished

On duplicate-charge, sample 1, qwen made zero tool calls and returned an empty string. Status ok, 5.8 seconds, no text at all. The customer who reported being double-charged gets silence.

```
! run no longer produces an output (3/9 run pairs)
! tool call dropped: lookup_account (3/9 run pairs)
```

Samples 2 and 3 went the opposite way and were the best runs in the whole experiment: lookup, then `issue_refund` with `{"account_id":"AC-2214","amount":29}`, exactly right. The llama baseline never once called `issue_refund` on this scenario. It wrote prose about processing refunds, and in two samples it printed a fake JSON tool call inside the reply text. So on this scenario qwen is the only model that actually refunds the customer, and also the only model that sometimes does nothing at all. A single-run comparison would have shown me one of those two facts and I would have believed whichever one I drew.

## Where qwen was plainly better

On cancel-and-refund, qwen added the `cancel_subscription` call in 5/9 pairs and `issue_refund` in 2/9. The baseline flapped on making the cancel call at all, which was the demoted almost-headline of the first study. And where llama passed `{"account_id":null,"amount":null}` to `issue_refund`, qwen passed `AC-2214` and `29`. More of the advertised behavior actually happens on qwen. That is a real upgrade, and it sits in the same report as the fabricated ids.

## The bill for the diligence

qwen does more per request and pays for it. Latency went up in every scenario: 57% on billing-question (11.6s to 18.2s, 7/9 pairs), 90% on cancel-only (13.5s to 25.8s, 9/9 pairs), 246% on the worst cancel-and-refund pair (12.3s to 42.5s). Total tokens roughly doubled, 869 to 1748 on cancel-and-refund and 779 to 1632 on duplicate-charge. Same parameter count, same laptop, twice the tokens. "Same size class" told me nothing about cost.

## What I take from it

The 3x downgrade mostly degraded behavior the agent already had. The same-size vendor swap replaced the behavior: different tool sequencing, cancellations fired in parallel with the lookup that was supposed to feed them, refunds that actually execute, one run of pure silence. None of it is visible in the reply text, which stayed polite and confident on both sides in all 24 runs. If you are choosing between vendors by reading transcripts, you are choosing between two versions of the same paragraph.

## Run it yourself

```
ollama pull llama3.2:3b && ollama pull qwen2.5:3b
npm install -g whatbroke-cli
node agent.mjs llama3.2:3b traces/before.jsonl 3
node agent.mjs qwen2.5:3b traces/after.jsonl 3
whatbroke diff traces/before.jsonl traces/after.jsonl
```

The agent script is the same 190 lines of plain fetch calls from the first study. Everything runs offline and the traces never leave your machine.
