# ADR 0016 — Localization (`@mp/i18n`)

Status: accepted. Follows the UI decision (ADR 0015).

## Context

Player-facing UI text is arriving (the pause screen). We want multiple languages from the
start rather than retrofitting hardcoded strings. Target set spans Latin-script + CJK + Arabic.

## Decision

- A tiny, **dependency-free headless package `@mp/i18n`**: per-language string tables, a typed
  `t(key, params)` lookup, `{param}` interpolation, browser-locale matching, a runtime locale
  switch, and a change subscription.
- **English is the source of truth** — its keys form the `TranslationKey` type, so a typo or
  unknown key fails typecheck; other locales are **partial** and fall back to English at lookup.
- **Headless (no DOM):** the browser consumer does detection/persistence and calls `setLocale`.
  Keeps the package on the headless side of the dependency law.
- **Hand-rolled, not a library:** the key set is small and needs no plurals/date/number
  formatting yet — so no new runtime dependency (matches the stack's "plain functions/data"
  rule). A library (i18next / FormatJS) lands only when ICU-grade formatting is required.
- **Shipped tables:** en, es, fr, nl, pt, ja, ko, zh, ar — seeded translations of the standard
  UI terms (flag for native-speaker review before shipping).

## Technical calls

- **CJK (ja/ko/zh)** render via the device's system fonts for now; production would bundle and
  **subset** fonts (to the glyphs actually used) for a consistent look without bloat.
- **Arabic (ar)** strings shape correctly (canvas 2D handles bidi/joining) but **RTL layout
  mirroring is deferred** — a separate pass; flagged, not silently skipped.
- A locale switch notifies subscribers; the pause menu re-reads every label live.

## Consequences

- All player-facing UI text routes through `t()`; adding a language is one table file.
- New package `@mp/i18n` (headless, zero dependencies). Consumed by `modes/parkour` (pause menu).

## Rejected

- **i18next / FormatJS now** — heavier than the current key set warrants; revisit when plurals /
  number-date / rich ICU formatting are needed.
- **Compile-time-complete tables** (every locale must implement every key) — chose partial +
  English fallback so adding a key doesn't break all locales; completeness stays a review concern.
