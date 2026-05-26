# Running the aloud server (`@aloud/server`)

The hosted backend — a stateless Hono proxy with Google auth, a credit
ledger, and metered LLM billing. Lives at `ts/server/`, a workspace package
of `ts/` (`@aloud/core`). Full design rationale is in `ts/server/README.md`;
this file is the operational quick-reference.

## TL;DR — does it run?

Yes. It boots, self-checks pricing solvency, and serves. What it is **not**
yet is *production-durable* or *feature-complete for the web demo* — see
[Gaps](#gaps-before-a-real-deploy).

```bash
cd ts            # the workspace root
npm install      # installs server deps too (hoisted; server is a workspace)

cd ts/server
npm run dev      # tsx watch — boots on :8787 with an in-memory store, no secrets
npm test         # vitest — 46 tests
npm run typecheck
```

Smoke-test a running instance:

```bash
curl localhost:8787/health          # {"ok":true,"providers":[...],"billing":bool}
curl localhost:8787/v1/me/models    # public: models, per-token cost, usdPerCredit, packMarkup
curl localhost:8787/v1/me/estimates # public: credit-use bands per model/STT/voice
curl localhost:8787/v1/me/packs     # public: credit packs for sale
```

`npm run dev` (watch) vs `npm start` (one-shot) — both run via `tsx`, which
resolves the `@aloud/core` path alias at runtime so the proxy reuses core's
provider classes (`AnthropicProvider`, etc.) for request-building and
token-usage parsing. Billing rides on that shared usage split — that's the
whole reason the server lives in this monorepo.

## Dev mode vs production mode

The boundary is the `ALOUD_ENV` env var (`loadConfig` in `config.ts`):

| | Dev (default) | Production (`ALOUD_ENV=production`) |
|---|---|---|
| Missing secrets | boots with stubs (`dev-insecure-secret`, in-memory store) | **refuses to start** unless session secret + ≥1 Google client id + ≥1 provider key are set |
| Content-check in logger | throws on a stray content field (catches mistakes loudly) | downgrades to drop-the-field (a logging slip can't crash a paying request) |
| Stripe unset | billing routes report "not configured"; runs on free-grant only | same, but you'll want it configured |

Solvency is enforced in **both** modes: `assertSolvent(CREDIT_PACKS)` in
`index.ts` refuses to boot if any credit pack's markup can't clear the worst
channel's commission (incl. the 15% IAP floor). See `pricing/commission.ts`.

## Configuration

Copy `ts/server/.env.example` → `.env` (gitignored) and fill in, or set these
as host secrets (Fly/Render). Full annotated list is in `.env.example`; the
load logic is `loadConfig` in `config.ts`.

| Var | Needed for | Notes |
|---|---|---|
| `ALOUD_ENV` | toggle prod checks | `production` or unset |
| `PORT` | — | default 8787 |
| `ALOUD_CORS_ORIGINS` | browser client | comma-sep; the `ui/dist` host origin(s) |
| `ALOUD_SESSION_SECRET` | signing session JWTs | `openssl rand -hex 32`; required in prod |
| `GOOGLE_CLIENT_IDS` | sign-in | comma-sep web/iOS/android client ids; required in prod |
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | LLM forwarding | ≥1 required in prod; server-held, never sent to client |
| `ALOUD_FREE_SIGNUP_CREDITS` | free tier | default 20 (≈ $1 provider cost) |
| `ALOUD_FREE_GRANT_BUDGET_PER_HOUR` | abuse brake | default 2000 (≈ 100 signups/hr) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | buying credits | optional; without them, free-grant only |
| `ALOUD_ADMIN_TOKEN` | `/v1/admin/metrics` | unset = endpoint 404s (disabled, not open) |

### Minimal "actually forward an LLM turn" setup

```bash
cd ts/server
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY=sk-ant-...   (or GROQ / OPENROUTER)
npm run dev
# /health now shows that provider under "providers"
```

`/v1/llm/complete` still requires a valid session (a Bearer token from
`POST /v1/auth/google`), so end-to-end forwarding needs a real Google ID
token. The route-level logic is unit-tested against the in-memory store in
`tests/app.test.ts` without network.

## Running the full loop locally (UI ↔ server)

The browser UI can drive the metered proxy end-to-end. The `aloud (hosted)`
provider in Setup/Settings routes LLM turns through this server instead of
Flask or BYOK.

```bash
# Terminal 1 — the server (needs a real provider key to actually complete)
cd ts/server
cp .env.example .env        # set ANTHROPIC_API_KEY (or GROQ / OPENROUTER)
npm run dev                 # :8787

# Terminal 2 — the UI (Vite proxies /v1/* → :8787; override via ALOUD_SERVER_URL)
cd ts
npm run ui:dev              # :5173
```

In the UI: pick provider **aloud (hosted)**, choose a model (the picker is
populated live from `GET /v1/me/models`), start a session. On first LLM turn
the UI auto-signs-in via the dev route and caches the token.

**Auth — dev shortcut.** `/v1/llm/complete` is behind bearer auth. Until the
Google OAuth flow exists (`meditation-pal-rfb`), the UI's `server-auth.ts`
falls back to `POST /v1/auth/dev` — a **local-only** route that mints a session
for a fixed `dev@localhost` account (seeded with `ALOUD_FREE_SIGNUP_CREDITS`,
auto-refilled when it runs dry). It **404s in production** (strict mode), so
it's a dev convenience, not a backdoor. Client wiring: `ui/src/server-auth.ts`
(token) + `ui/src/adapters/server-llm.ts` (`complete` + SSE `completeStream`).

Quick handshake without the UI:

```bash
TOK=$(curl -s -X POST localhost:8787/v1/auth/dev | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s localhost:8787/v1/me -H "authorization: Bearer $TOK"          # account + balance
curl -s -X POST localhost:8787/v1/llm/complete -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"provider":"anthropic","model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'
```

> STT and TTS still go through Flask / browser-native — the server has no
> STT/TTS routes yet (`meditation-pal-age` / `2gz`). Only the LLM path is
> repointed at the server today.

## Routes

Wired in `app.ts`; the entire client↔server wire surface is `contract.ts`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | public | liveness + what's configured |
| `POST /v1/auth/google` | public | verify Google ID token, create account, grant free credits |
| `POST /v1/auth/dev` | public (dev only) | local dev sign-in; mints a session for `dev@localhost`. 404s in production |
| `GET /v1/me` | session | account + live balance |
| `GET /v1/me/models` `/estimates` `/packs` | public | published pricing |
| `POST /v1/llm/complete` | session | metered proxy: hold → forward → settle to actual cost (SSE or JSON) |
| `POST /v1/billing/checkout` | session | start Stripe Checkout for a pack |
| `POST /v1/billing/webhook` | Stripe sig | credit the ledger after signature verify |
| `GET /v1/admin/metrics` | admin token | ledger aggregates for spend monitoring |

## Gaps before a real deploy

In rough priority order. Tracked under epic `meditation-pal-bot`.

1. **Persistent credit store — the blocker for real money.** `buildDeps`
   wires `MemoryCreditsStore`: accounts, balances, and the ledger live in RAM
   and vanish on restart. A durable `CreditsStore` impl (Postgres/SQLite) is
   needed before charging anyone. The interface is `credits/store.ts`; swap it
   in `deps.ts`.
2. **STT endpoint for web** (`meditation-pal-age`) — the server proxies LLM
   only; there's no `/v1/stt` route yet. Web STT still hits Flask. Plan is
   Groq Whisper behind this server.
3. **TTS endpoint for web** (`meditation-pal-2gz`) — same story; no server TTS
   route yet.
4. **Repoint the UI adapters** — `ts/ui/src/adapters/{server-whisper-stt,
   server-tts,claude-proxy-http}` currently target the desktop Flask backend.
   The web demo needs them pointed at this server (`meditation-pal-vd3`).
5. **History-prefix caching** (`meditation-pal-cet`) — the cost estimates in
   `/v1/me/estimates` assume conversation-history prompt caching that isn't
   implemented, so LLM estimates are optimistic until it lands (needs a 1h
   cache TTL — meditation's silences exceed the 5-min default).
6. **Deploy infra** (`meditation-pal-a3u`) — pick Fly/Render, real TLS (mic
   needs a secure context; `cert.py` self-signed is LAN-only), host `ui/dist`
   static, point the proxy at it via CORS.

## Test/lint matrix (what "green" means here)

```bash
cd ts        && npm run typecheck && npm test   # core 134 + ui typecheck
cd ts/server && npm run typecheck && npm test   # server 46
cd ts        && npm run ui:build                # vite build of ui/dist
```
