# Pre-release checklist

Run this before cutting a release — or any time, by asking Claude to "run the
pre-release check". The goal: catch documentation and copy that's drifted out of
sync with code changes, plus other downstream consequences of a change.

Claude: work through both parts below against the current diff / recent changes.
Report what's stale and propose fixes; don't assume — grep and read the actual files.

## Part A — surface inventory (everywhere the product is described)

When the product's features, providers, platforms, branding, or behavior change,
check each of these still reflects reality:

- **`docs/index.html`** — hero copy, the two-modes section, provider list, the
  hero tagline/pun, **OG/Twitter metadata** (title, description, image), and the
  "iOS and Android coming soon" platform lines.
- **`docs/privacy/index.html`** — data-flow descriptions, provider examples,
  on-device claims, "last updated" date.
- **`docs/assets/aloud-share.png`** + `assets/share-card.svg` — the share-card
  tagline if the positioning/tagline changed.
- **`README.md`** — product description, modes, provider list, platform notes,
  tips, install instructions, screenshot reference.
- **`dev-docs/store-listings.md`** — App Store / Play name, subtitle, description,
  keywords; especially the provider/feature claims and the mobile-provider caveat.
- **`dev-docs/style.md`** — visual identity (orb gradient, color tokens, fonts) if
  branding changed.
- **`dev-docs/dev-cheatsheet.md`, `building.md`, `README.nix.md`, `voice-barge-in.md`**
  — dev/build/feature docs.
- **`CLAUDE.md`** — the architecture section (commands, modules, data flow,
  pacing/check-in behavior) and any conventions.
- **App UI text** — settings labels and hints, the tour/onboarding wizard,
  check-in prompts, welcome/empty-state copy.
- **`config/default.yaml`** — comments describing defaults.
- **Icons / assets** — `src/web/static/favicon.svg`, `assets/app-icon*.svg`,
  `aloud.icns/.ico/.png` if the orb/branding changed.

## Part B — change → consequence matrix

- **Added/removed/renamed an LLM provider** → settings dropdown + provider routes,
  README provider list, site provider pills, privacy-policy examples, store-listings
  provider claims.
- **Added/removed a feature or mode** → README, site, store listings, CLAUDE.md
  architecture, and privacy policy *if it changes a data flow*.
- **Changed platform support** (e.g. mobile ships) → the "coming soon" lines on the
  site, README platform notes, store listings, the desktop-vs-mobile provider caveats.
- **Rebrand / rename** → sweep every surface in Part A (name, repo URL, bundle id).
- **Changed visual identity** (orb gradient, colors, font) → `dev-docs/style.md`,
  the site CSS + app CSS (kept in sync), all icon/share-image sources, regenerate
  rasters.
- **Changed a default or config option** → `config/default.yaml` comment,
  `src/config.py` default, the settings UI, and any doc that quotes the value.
- **Changed data handling** (new network call, new stored data, new third-party
  service) → privacy policy + the App Store / Play data-safety answers.

## Part C — keep this list current

- Did this change introduce a **new place** that describes the product (a new page,
  a new doc, a new marketing surface)? **Add it to Part A.**
- Did it introduce a new **class of ripple effect**? Add it to Part B.
- If a surface listed here was removed, delete its entry.
