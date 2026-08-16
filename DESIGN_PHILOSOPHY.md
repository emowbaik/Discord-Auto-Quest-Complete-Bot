# DESIGN_PHILOSOPHY

Why this fork exists and the trade-offs it chose.

## Mission

Turn Discord Quests from a manual, attention-taxing clickfest into a reliable background job: enroll, complete, and — when a captcha solver is configured — claim, across N accounts, with one command locally or one schedule in GitHub Actions. Observable via Telegram/Discord, silent about secrets.

Upstream `aiko-chan-ai/Discord-Quest-Auto-Completion-Selfbot` proved the idea; this fork's focus is **boring reliability**: sequential per-account runs, isolated errors, keepalive so the schedule survives, and the smallest surface that still works.

## Ideology — Lazy Senior Dev

The ladder, enforced by repo rules:

1. Feature needed at all? (YAGNI — if `STREAM_ON_DESKTOP` needs headless media, skip it)
2. Stdlib/native first (`fetch`, `Intl.DateTimeFormat`, HTML escaping)
3. Platform feature over custom code (`undici` dispatcher vs hand-rolled TLS)
4. Existing dep over new dep (no new captcha SDK — `fetch` + round-robin pool)
5. One line over ten (string `split(/[\r\n,]+/)` over a parser lib)
6. Only then: minimal code that works

No abstractions for one implementation, no factories, no config that never changes. Shortest working diff wins. When two stdlib options tie, pick edge-case-correct. Mark deliberate ceilings with `ponytail:` (known limit + upgrade path).

## Decisions & Why

**Sequential claims, not parallel.** Captcha challenges mutate per-quest tokens (`session_id/rqtoken/rqdata`). Parallel `redeemQuest` cross-talks tokens and triggers `10008 Unknown Message`. One `for await` loop per account avoids it.

**One captcha provider (NopeCHA) after removing NoneCap (2026-08-16, 1310506).** NoneCap solved at 100% on dashboard but Discord rejected every `P1_…` token as `10008` without a sticky residential proxy; measured `6/11 -> 0/12` without it. Keeping both meant two code paths for one bug. Deleted `providers/nonecap.ts` and tests, kept `ponytail: re-add via nonecap.ts + NONECAP_* env` — restore is one commit if proxy budget appears.

**Headers: quest-home parity over clever spoofing.** `referer: https://discord.com/quest-home`, UA Chrome 138, `x-super-properties.client_build_number` live-fetched from `discord.com/app` (594031). Questku proved this is what Discord checks on `claim-reward`.

**Notifications: both, fire-and-forget.** Telegram `HTML` + Discord embeds use the same `AccountReport`; caller never awaits failure. Webhook URL is a bearer secret — never logged, POST only. Errors sliced to 900 chars for embed limits.

**Docs match code, not aspiration.** README is "how to run", `CODE_DOCUMENTATION` is "how it fits", this file is "why". Schedule drift (`07:15 WIB` vs `cron 13 17 UTC`) was fixed because Actions is UTC — docs must state `01:13 WITA — cron '13 17 * * *'`.

## Non-Goals (On Purpose)

- No browser/extension captcha hybrid — API solver covers the job without shipping a browser to Actions.
- No dashboard UI, no DB — logs + notifications are enough.
- NoToS-compliant mode — user-token selfbots violate Discord ToS by nature; docs disclose via `> [!CAUTION]` and `SECURITY.md`, logging never leaks raw `TOKENS`.

## What Would Change the Philosophy

- Discord ships a real OAuth quest claim endpoint → migrate off user tokens entirely.
- Enterprise hcaptcha without proxy becomes unsolvable via API → reconsider a minimal browser path with strict IP pinning.
- Multi-DC or >100 accounts → then (and only then) introduce a queue/worker and a small persistence layer.
