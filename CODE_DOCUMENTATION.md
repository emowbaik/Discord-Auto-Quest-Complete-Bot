# CODE_DOCUMENTATION

Crisp technical reference — what the code does, not how to log in.

## Quick Nav

- `bot.ts` — orchestration, multi-account sequencing
- `src/client.ts` — Discord Gateway selfbot (`@discordjs/ws` + `@discordjs/rest`)
- `src/questManager.ts` — quest lifecycle core
- `src/captcha.ts` / `src/providers/nopecha.ts` — optional reward claim
- `src/notify.ts` — Telegram + Discord webhook reporting
- `src/utils.ts` — headers + build number
- `src/constants.ts` / `src/interface.ts` / `src/quest.ts`

## Architecture

```
TOKENS (one per line, process.env.TOKENS || TOKEN)
  -> bot.ts runAccount(token, i) sequential, 5s gap between accounts
     -> ClientQuest(token) extends @discordjs/core Client
        -> GatewayShard (wss://gateway.discord.gg) READY -> fetchQuests(false)
        -> REST (https://discord.com/api/v9) via Utils.makeHeaders
           -> GET /quests/@me            (QuestManager.fromResponse)
           -> POST /quests/{id}/enroll  (if unenrolled)
           -> heartbeat task loops per type (src/questManager.ts: doingQuest)
           -> POST /quests/{id}/claim-reward (+ x-captcha-* if challenged)
        -> notifyAccountReport -> Telegram + Discord webhook (src/notify.ts)
```

Multi-account uses **sequential** `for ... await redeemQuest` per account — parallel would cross captcha `session_id/rqtoken`.

## Entry: bot.ts (96 lines)

1. Parse `TOKENS.split(/\r?\n/)` — multi-account, `Account N` labeling.
2. `runAccount(token, idx)` returns `AccountRunResult {account, completed, claimed, claimSkipped, durationSeconds}`.
3. Flow: `connect` (120s timeout) -> `READY @username` -> `fetchQuests(false)` -> `filterQuestsValidToDo` -> `Promise.allSettled(doingQuest)` -> if `canSolveCaptcha()` then `fetchQuests` + `filterQuestsValidToRedeem` + sequential `redeemQuest`.
4. `notifyAccountReport` always — success or `catch` error path. Raw token never logged (rule: `@username` / `Account N` only).

## Client: src/client.ts (121 lines)

- Patches `WebSocketShard.prototype.send` once (selfbot shim).
- `makeHeaders` = `Utils` (Authorization stripped of `Bot ` prefix, `x-captcha-*` preserved via header merge).
- `makeRequest` wraps `DefaultRestOptions.makeRequest` to inject headers.
- `fetchQuests(fetchExcludedQuests)` → `GET /quests/@me` → `QuestManager.fromResponse`. Rate-limit log via `REST rateLimited`.

## Quests: src/questManager.ts (~830 lines, largest)

### QuestManager (Map<string, Quest>)

`fromResponse` builds map from `AllQuestsResponse.quests[]` via `Quest.create`. `filterQuestsValidToDo()` excludes `isCompleted|hasClaimedRewards|isExpired|blocked`; `filterQuestsValidToRedeem()` is `isCompleted && !hasClaimedRewards`. `addExcludedQuest(id)` for `excluded_quests` retry.

### doingQuest(type -> handler)

Type switch (interface `QuestTaskConfigType`):

- `WATCH_VIDEO[_ON_MOBILE]` — video progress spoof `POST /quests/{id}/video-progress` (questku-matched: `{timestamp, heartbeat?}`)
- `PLAY_ON_DESKTOP|XBOX|PLAYSTATION` — heartbeat `POST /quests/{id}/heartbeat` with `streamDurationRequirementMinutes * 60*1000` pacing, 7–20s jitter sleeps
- `PLAY_ACTIVITY` / `ACHIEVEMENT_IN_ACTIVITY` — activity heartbeat / Discord Says OAuth flow
- `STREAM_ON_DESKTOP` — headless: `warn + return false` (no media)

All handlers call `notifyQuestCompleted` and update local state.

### redeemQuest — the complex part

```
resolveSealed() = raw.traffic_metadata_sealed ?? config.traffic_metadata_sealed ?? null
doClaim(headers?, dispatcher?, sealedOverride?) => REST POST /quests/{id}/claim-reward
  body: { platform:0, location:11, is_targeted:false, metadata_sealed:null, traffic_metadata_sealed }
fetchFreshTraffic() => GET /quests/@me (find by id) fallback GET /quests/{id} (debugToTelegram logs each step)
helpers: isAlreadyClaimed (409/40010), isUnknownMessage (10007/10008/\"Unknown Message\")
tryAlternativeBodies(headers?, dispatcher?) => variant A sealed:null, variant B sealed+traffic_metadata_raw
handleSuccess => notifyRewardClaimed + quest.updateUserStatus
```

Retry ladder on captcha challenge (`400 captcha_service:'hcaptcha' sitekey 4bb5aadb-b50f-4f23-b1c2-92b59ba400d5`):
1. `doClaim()` (plain)
2. `doClaim` with `freshTraffic` (after `fetchFreshTraffic`)
3. `doClaim` with `undici` custom `buildConnector` dispatcher (questku-style TLS, guarded fallback)
4. `solveCaptcha({sitekey,url,rqdata})` -> `doClaim(captchaHeaders)` plain
5. dispatcher fallback, second `solveCaptcha`, then `tryAlternativeBodies` variants (with/without dispatcher)

`[debug]` lines are `debugToTelegram()` — currently console-only (Telegram spam disabled, re-enable by uncommenting one line in `src/notify.ts`).

### Constants

- Sitekey constant `4bb5aadb-b50f-4f23-b1c2-92b59ba400d5` (Discord hcaptcha enterprise).
- Build number fetched live from `discord.com/app` assets (`Utils.updateLatestBuildVersion`, 594031 live, fallback 539951) — sent as `x-super-properties.client_build_number`.

## Captcha: src/captcha.ts (67 lines) + providers/nopecha.ts (57)

- `parseList` splits `NOPECHA_API_KEY` by `/[\r\n,]+/` — comma or newline, N keys, round-robin with `tryClients` fallback on `429/402/rate_limited/insufficient_credits`.
- `NoneCap removed (2026-08-16, chore 1310506)`: enterprise hcaptcha tokens without sticky residential proxy were consistently rejected as `10008 Unknown Message` even at dashboard 100% solved; keep one boring provider. Restore via `src/providers/nonecap.ts` + `NONECAP_*` env if needed — ponytail in `captcha.ts:12`.
- `NopeCHASolver`: `POST https://api.nopecha.com/v1/token/hcaptcha {sitekey,url,useragent,rqdata?} -> {data: jobId}` then `GET ?id=jobId` poll 3s up to 120s (token when `data !== jobId`). Auth `Basic {key}`.

## Notify: src/notify.ts (193 lines)

- `sendTelegram(text: HTML)` — `https://api.telegram.org/bot{token}/sendMessage {chat_id, text, parse_mode:'HTML'}` with `escapeHtml(&<> )`, truncates error.
- `sendDiscordEmbed(embed)` — `POST DISCORD_WEBHOOK_URL {username, embeds:[{...footer,timestamp,fields,colors}]}`, webhook is bearer secret (never logged), `escapeDiscord`.
- `debugToTelegram(msg, isWarn)` — console-only by default (one-liner enable for GH Actions without log tail).
- `notifyQuestCompleted(id)`, `notifyRewardClaimed(name)`, `notifyAccountReport(report)` — dual-send `Promise.all([sendTelegram, sendDiscordEmbed])`, report fields: `account/completed/claimed/claimSkipped/durationSeconds/error?`.

## Utils: src/utils.ts (275 lines)

- `makeDesktopHeaders(token)` / `makeAndroidHeaders` — UA `Mozilla/5.0 ... Chrome 138` / Android, `x-super-properties` base64 JSON (`os: Windows 11`, `browser: Chrome`, `client_build_number` live-fetched), `Authorization` (Bot prefix stripped), `referer: https://discord.com/quest-home` (questku parity), `x-discord-locale`, `x-debug-options`.
- `makeHeaders(token)` merges both, caller-provided `x-captcha-*` survives via `Headers` merge.
- `updateLatestBuildVersion()` — fetches `discord.com/app`, extracts `build_number` from asset JS; cached.
- `parseEnvList`-style splitting used in `bot.ts` + `captcha.ts`.

## Types: interface.ts (531 lines) / quest.ts (60) / constants.ts (51)

- `AllQuestsResponse { quests: Quest[], quest_enrollment_blocked_until, excluded_quests }`
- `Quest { id, config: {messages:{quest_name}, rewards_config:{platforms}, expires_at, task_config, traffic_metadata_sealed?}, user_status:{enrolled_at, completed_at, claimed_at}, traffic_metadata_raw/sealed?, raw }`
- `CaptchaDataFromRequest { captcha_key[], captcha_sitekey, captcha_service:'hcaptcha', captcha_session_id, captcha_rqdata, captcha_rqtoken }`
- `Quest.create` validates shape, helpers `isCompleted()/hasClaimedRewards()/isEnrolled()/isExpired()`.

## Config: .env.example (6 lines), auto.yml (60), package.json (31)

- `.env.example`: `TOKENS` (newline multi), `NOPECHA_API_KEY` (comma/newline multi), notifications. No `NONECAP_*`.
- `auto.yml`: `workflow_dispatch + schedule 13 17 * * * (01:13 WITA)`, `permissions: actions:write`, `node 24 + npm ci`, secrets `TOKENS/TOKEN/NOPECHA_API_KEY/TG_*/DISCORD_WEBHOOK_URL`, keepalive `liskin/gh-workflow-keepalive@v1`, cleanup keeps latest run only (`gh run delete`).
- `package.json`: `@discordjs/core 2.4.0 / rest 2.6.2 / ws 2.0.4, undici 6.24.1, discord-api-types 0.38.42, tsx 4.21.0, typescript 5.8.3, node >=24`.

## Verification

```powershell
npx.cmd tsc --noEmit   # 0 errors
# gutted noneCap.test.ts with provider removal — next test to add is nopecha if needed
```
