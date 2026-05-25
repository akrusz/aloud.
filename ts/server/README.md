# @aloud/server

The hosted **aloud** backend: a stateless proxy with accounts, a credit ledger,
and metered billing. It's what lets a stranger hit a URL, sign in with Google,
get a few free credits, and spend them on premium LLMs/voices — without an API
key or anything running locally. (The app-store and desktop builds keep the
on-device and bring-your-own-key paths; this server is just the "easy, hosted"
option.)

This is part of the public, **AGPL-3.0** aloud repo, on purpose. See
[Why it's open source](#why-its-open-source).

## What it does

| Route | Purpose |
|-------|---------|
| `POST /v1/auth/google` | Verify a Google ID token, create the account on first sign-in, grant free credits to **verified** emails. |
| `GET /v1/me` | Signed-in account + live credit balance. |
| `GET /v1/me/models` | Public: allowed models + per-token cost + the margin multiplier. The pricing is published. |
| `GET /v1/me/packs` | Public: credit packs for sale. |
| `POST /v1/llm/complete` | The metered proxy. Hold → forward → settle to actual cost. SSE or JSON. |
| `POST /v1/billing/checkout` | Start a Stripe Checkout for a credit pack. |
| `POST /v1/billing/webhook` | Stripe → credit the ledger, after signature verification. |
| `GET /health` | Liveness + what's configured (no secrets). |

## Architecture

Deliberately small and stateless. **Sessions live entirely on the client** — the
server never stores conversation history. The only moment meditation content
touches the server is when `/v1/llm/complete` forwards a turn to a provider, and
that path persists nothing.

```
src/
  contract.ts         the ENTIRE client↔server wire surface (keep it small)
  config.ts           env config; secrets never in the repo
  logger.ts           structured logs with a hard "never log content" invariant
  deps.ts             dependency container (inject a store, build the rest)
  app.ts / index.ts   Hono app + entrypoint
  auth/               Google ID-token verify (jose+JWKS), our session JWT, middleware
  credits/            CreditsStore interface, in-memory impl, append-only Ledger
  pricing/            provider cost tables, commission-by-(channel,jurisdiction), the meter
  providers/          forwarder — reuses @aloud/core provider classes at runtime
  billing/            Stripe checkout + webhook verify (fetch + node:crypto, no SDK)
  quota/              free-tier grant gating + a rate guard
```

### Reuse of `@aloud/core`

The forwarder constructs the **same** provider classes the client uses
(`AnthropicProvider`, `GroqProvider`, `OpenRouterProvider`) rather than
re-implementing request building and token-usage parsing. Billing rides on that
usage split, so a single shared implementation is the whole reason this lives in
the monorepo. It's wired via a tsconfig path alias resolved by `tsx` at runtime
(and a matching Vitest `resolve.alias`). When the coordinated `packages/`
workspace move happens, `@aloud/core` becomes a normal workspace dependency and
the alias goes away.

### Metered billing, in the open

Each turn is priced by its **actual** cost (token split × provider rates) ×
`MARGIN_MULTIPLIER`, debited from a credit balance via a pre-auth hold that
settles to the real cost. `assertSolvent()` runs at boot and **refuses to start**
if the margin can't clear the worst channel's commission — including the 15% IAP
floor (see `pricing/commission.ts` and ticket `meditation-pal-8sj`). The
commission rate is a `(channel, jurisdiction)` lookup, not a constant, because
web-Stripe / EU / IAP take very different cuts.

## Why it's open source

Putting the billing/credits server in the public AGPL repo isn't an oversight —
it's the point. For a privacy-and-ownership-minded meditation product:

- **AGPL works *for* us here.** Its network-use clause means anyone running this
  server owes their users the source. We want that.
- **The one arguably-sensitive number, the margin multiplier, is published**
  (`/v1/me/models`). It's trivially derivable from public provider pricing
  anyway, and anyone who cares had two cheaper escape hatches: local Ollama or
  their own API key. Transparency is a trust feature, not a leak.
- **Privacy comes from the architecture, not from hiding code:** stateless
  proxy, client-side sessions, and a logger that refuses to print message bodies
  (`meditation-pal-dn2`).

## Running it

```bash
cp .env.example .env   # fill in secrets, or set them as host secrets
npm run dev            # tsx watch
npm start              # tsx (prod; resolves the @aloud/core alias)
npm test               # vitest
npm run typecheck
```

In dev with no Stripe keys, billing routes report "not configured" and the
server runs on the free-tier grant alone. In production (`ALOUD_ENV=production`)
it refuses to start without a session secret, a Google client id, and at least
one provider key.

Deploy target: a small always-on VM (Fly/Render); the static `ui/dist` lives on
a CDN. See `meditation-pal-a3u`.
