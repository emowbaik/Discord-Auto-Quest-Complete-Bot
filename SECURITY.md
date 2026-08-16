# Security Audit — Discord-Auto-Quest-Complete-Bot

**Date:** 2026-08-16 (re-audited after NoneCap removal)
**Scope:** `bot.ts`, `src/**`, `package.json`, `.env.example`, `.gitignore`, `.github/workflows/auto.yml`
**Method:** Paranoid OWASP Top 10 sweep — secrets scan, injection/XSS, auth, dependency supply-chain
**Delta since 2026-08-14:** removed `src/providers/nonecap.ts`, `tests/nonecap.test.ts`, `NONECAP_*` env (1310506); added `CODE_DOCUMENTATION.md`, `DESIGN_PHILOSOPHY.md`

---

## Audit Log

| Check | Result |
|---|---|
| Secrets committed in repo | 🟢 Passed — no hardcoded tokens/keys in tracked files |
| `.env` ignored | 🟢 Passed — `.gitignore` lists `.env` and variants |
| `.env.example` placeholders only | 🟢 Passed — dummy values, no real secrets |
| `innerHTML` / `eval` / `exec` injection | 🟢 Passed — none found |
| XSS via Telegram `parse_mode: HTML` | 🟢 Passed — `escapeHtml()` applied to user-controlled strings |
| SQL injection | 🟢 Passed — no DB layer |
| Auth on sensitive routes | N/A — selfbot, no exposed HTTP server |
| Dependency vulnerabilities | 🟡 Warning — 2 advisories (see below) |

---

## Findings

### 🔴 Critical

**C1 — Discord user-token selfbot violates Discord ToS**
- **Where:** Entire project is a user-token selfbot (`TOKENS`/`TOKEN`).
- **Risk:** Account bans, token revocation. Discord explicitly forbids automating user accounts.
- **Status:** Accepted risk by design. Must be disclosed.
- **Mitigation:**
  - Keep `README.md` and `SECURITY.md` disclaimer prominent.
  - Never log `TOKENS` value — current code logs only `@username`, good.
  - Advise users to use throwaway/low-value accounts and to rotate token via password change if leaked.

### 🟡 Warning

**W1 — Outdated `undici` (moderate) + `esbuild` (low)**
- `npm audit` (2026-08-14):
  - `undici <=6.27.0` — GHSA-8xcm-r25x-g524 (response desync via retry interceptor), GHSA-m8rv-5g2x-5cg5 (CRLF via blob-like body `type`), GHSA-v3r7-h72x-cjcm (cookie attribute injection) — Severity **moderate**
  - `esbuild 0.27.3 - 0.28.0` — GHSA-g7r4-m6w7-qqqr (arbitrary file read on Windows dev server) — Severity **low**, dev-time only via `tsx`
- **Fix:** Run `npm audit fix` (will bump `undici` to >=6.28+ and `esbuild` via `tsx` transitive). No code change needed, but re-run `npx tsc --noEmit` after.

**W2 — Webhook URL is a bearer secret**
- `DISCORD_WEBHOOK_URL` functions as an auth token — anyone with it can post to the channel.
- Current handling is correct (env-only, not logged, POST as JSON). Keep it out of `README` examples (placeholder `WEBHOOK_ID/WEBHOOK_TOKEN` is fine).
- **Fix already applied:** No commit of real webhook; `.gitignore` coverage verified. Previous dead helper `extractWebhookInfo()` that did `fetch(webhookUrl)` for validation was removed — no unintended GET to Discord.

**W3 — Token extraction guidance increases phishing/stealer risk**
- `README.md` documents bookmarklet + add-on methods.
- **Mitigation already applied:** Security Warnings section added (own-device-only, no paste to untrusted sites, remove add-on after use, rotate on exposure).

**W4 — Telegram HTML escaping limited**
- `escapeHtml()` covers `& < >` which is sufficient for `parse_mode: HTML`, but Discord embed `fields` interpolate `report.account` / `report.error` raw. Discord renders markdown, not HTML, so not exploitable — but `report.error` is sliced to 900 chars (good). Keep truncation.

### 🟢 Passed

- **Secrets hygiene:** All credentials (`TOKENS`, `NOPECHA_API_KEY`, `TG_BOT_TOKEN`, `TG_CHAT_ID`, `DISCORD_WEBHOOK_URL`) read via `process.env` / GitHub Secrets. No `NONECAP_*` remains (removed 1310506). No `grep` hit for hardcoded `API_KEY`, `password`, `secret`, `token` literals. `git status` shows `.env` is untracked/ignored (not staged).
- **Injection:** No `innerHTML`, `dangerouslySetInnerHTML`, `eval`, `exec`, `child_process`.
- **Rate limiting:** `REST` `rateLimited` event is logged; heartbeat/video loops sleep 7–20s between calls.
- **Data protection:** All outbound fetches are HTTPS (`https://discord.com`, `https://api.telegram.org`, `https://discord.com/api/webhooks`, `https://*.discordsays.com`). No stack traces leaked to Telegram/Discord — `console.error` stays local.
- **Supply chain hygiene:** No unused deps; `package.json` pins `@discordjs/*`, `undici`, `tsx`, `typescript`, `discord-api-types`.

---

## Remediation Checklist

- [ ] Run `npm audit fix` and commit `package-lock.json` bump
- [ ] Verify `npx tsc --noEmit` still passes after bump
- [ ] Confirm `.env` never appears in `git log --all -- .env` (already ignored)
- [ ] Keep `DISCORD_WEBHOOK_URL` and `TOKENS` in GitHub **Secrets**, not **Variables**

---

## How to Report a Vulnerability

Do not open a public issue with secrets. Rotate any exposed token immediately (Discord: change password; Telegram: revoke bot token via @BotFather; Discord webhook: regenerate in channel Integrations). Then open a private security advisory or contact the maintainer.

---

## Verification

- `grep_search` for `API_KEY|password|secret|token|webhook` in tracked source: 0 hits
- `grep_search` for `innerHTML|eval\(|exec\(`: 0 hits
- `.gitignore` contains `.env` — verified 2026-08-14
- `npm audit --audit-level=moderate` — 2 advisories pending fix (see W1)
- `SECURITY.md` created at repo root — this file

> **Note on selfbot risk:** This project cannot be made "ToS-compliant" while using user tokens. The only fully compliant alternative is migrating to Discord OAuth2 bot tokens with `bot` scope, which Discord Quests do not support for user quests.
