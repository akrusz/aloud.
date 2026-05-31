Measured. The system prompt for this config (emotions + parts + compassionate +
  high verbosity) is ~1,560 tokens, and your config uses full context (no
  context_strategy set → code default; window_size: 100 wouldn't bind anyway at 33
   turns). That "full history re-sent every turn" is the dominant cost driver.
  Here's the estimate.
  
  This session, by the numbers

  ~33 LLM facilitator turns (the "Take all the time you need" is a canned check-in
   — no LLM call; plus a tiny resume-intent check after the [HOLD] and one summary
   call at the end).
  
  ┌──────────────────┬─────────────────┬──────────────────────────────────────┐
  │                  │    Estimate     │                 Why                  │
  ├──────────────────┼─────────────────┼──────────────────────────────────────┤
  │ Output tokens    │ ~2,500–2,800    │ Sum of facilitator text (~10k chars  │
  │                  │                 │ ÷ 4)                                 │
  ├──────────────────┼─────────────────┼──────────────────────────────────────┤
  │ Input —          │                 │ Full transcript re-sent each turn →  │
  │ conversation     │ ~76,000         │ grows ~quadratically. ∑ of           │
  │ history          │                 │ cumulative history over 33 calls     │
  ├──────────────────┼─────────────────┼──────────────────────────────────────┤
  │ Input — system   │ ~51,000 raw     │ But cached, so effectively ~8k       │
  │ prompt           │ (~1.56k × 33)   │ billed                               │
  ├──────────────────┼─────────────────┼──────────────────────────────────────┤
  │ Total input      │ ~125,000        │                                      │
  │ (raw)            │                 │                                      │
  └──────────────────┴─────────────────┴──────────────────────────────────────┘

  So the ratio is roughly 45:1 input:output — input is ~98% of your token volume.
  That's the single most important fact for your cost model, and it's entirely the
   full-context re-send.
  
  What this one ~35-min session would cost, by model

  Using system-prompt caching (your current behavior — only the system prompt is
  cached, history is full-price each call):

  ┌───────────────────┬────────────────┬──────────────────────────┬──────────┐
  │       Model       │ In / Out ($/M) │ Est. cost (this session) │ Relative │
  ├───────────────────┼────────────────┼──────────────────────────┼──────────┤
  │ Opus 4.x          │ $15 / $75      │ ~$1.40                   │ 14×      │
  ├───────────────────┼────────────────┼──────────────────────────┼──────────┤
  │ Sonnet 4.x        │ $3 / $15       │ ~$0.30                   │ 3×       │
  ├───────────────────┼────────────────┼──────────────────────────┼──────────┤
  │ Haiku 4.5         │ $1 / $5        │ ~$0.10                   │ 1×       │
  ├───────────────────┼────────────────┼──────────────────────────┼──────────┤
  │ Gemini Flash-Lite │ ~$0.10 / $0.40 │ ~$0.01                   │ 0.1×     │
  └───────────────────┴────────────────┴──────────────────────────┴──────────┘

  (Order-of-magnitude, ±~35%.) At ~20 exploration sessions/month that's roughly
  Opus $28/mo · Sonnet $6 · Haiku $2 in raw COGS per user.

  What this tells your decision

  1. Opus for exploration is ~$1–1.50/session. Real money — at a 2× margin that's
  ~$3/session retail. Defensible for a premium "deepest practice" tier, but it's
  the thing that makes the credit math tight, exactly as a2j feared. It's also
  where Opus's emotional intelligence earns its keep most (this transcript is a
  good example — parts work, holding ambivalence).
  2. Noting mode is essentially free on anything. Tiny context, 1–3 word outputs,
  no history accumulation. Haiku or Gemini Flash-Lite is a no-brainer there —
  don't spend a thought on it.
  3. The biggest lever isn't the model — it's caching the history, not just the 
  system prompt. Right now anthropic.py only puts cache_control on the system
  prompt, so your ~76k tokens of re-sent conversation history are billed at full
  input price every turn. If you also cache the conversation prefix, most of that
  76k becomes cache-reads at ~10%, which would roughly halve-to-third the Opus 
  cost (~$1.40 → ~$0.40–0.50). That single change could make Opus-for-exploration
  viable where it otherwise isn't. Worth a ticket against the hosted-proxy work
  (vd3/8sj) — it changes the model-selection calculus materially.

  My read, matching your instinct: Opus (or Sonnet as the value option) for 
  exploration, cheapest-tier for noting — and prioritize prefix caching before
  concluding Opus is too expensive, because un-cached history is inflating that
  $1.40 by ~2–3×.

  Want me to file that history-caching optimization as a bead (it's a concrete,
  high-leverage change to the proxy)? And I'm still holding the commit on the
  usage-tracking + doc changes — commit now?
