# Discord-Auto-Quest-Complete-Bot

Automated Discord quest completion selfbot: auto-enroll and auto-complete supported quests, with optional auto-claim when `NOPECHA_API_KEY` is configured. Runs locally or daily via GitHub Actions.

## Features

- Auto-enroll: automatically accepts available quests
- Auto-complete: completes supported quest types without manual interaction
- Multi-account: process multiple Discord tokens in one run
- Optional auto-claim: tries to redeem completed rewards only when `NOPECHA_API_KEY` exists
- Telegram notifications: per-account completion summary sent to your chat
- Discord webhook embeds: rich status cards sent to Discord when configured
- Workflow keepalive: helps prevent scheduled workflow from being auto-disabled due to repository inactivity
- Daily schedule: runs automatically at 07:15 WIB (00:15 UTC) via GitHub Actions
- Manual trigger: run anytime from the Actions tab

## How It Works

```text
TOKENS (one per line)
    -> for each token
Connect to Discord Gateway (selfbot)
    ->
Fetch available quests (/quests/@me)
    ->
Auto-enroll unenrolled quests (/quests/{id}/enroll)
    ->
Auto-complete supported tasks
    ->
[if NOPECHA_API_KEY set] Auto-claim completed rewards
    ->
Send Telegram/Discord report -> disconnect -> next account
```

### Supported Quest Types

| Type | Method |
|------|--------|
| `WATCH_VIDEO` / `WATCH_VIDEO_ON_MOBILE` | Video progress spoofing |
| `PLAY_ON_DESKTOP` / `PLAY_ON_XBOX` / `PLAY_ON_PLAYSTATION` | Game heartbeat spoofing |
| `PLAY_ACTIVITY` | Activity heartbeat spoofing |
| `ACHIEVEMENT_IN_ACTIVITY` | Discord Says OAuth + progress |
| `STREAM_ON_DESKTOP` | Not supported in headless mode |

## Setup Guide

### Step 1 - Get Your Discord Token

All methods use Discord Web: [discord.com/app](https://discord.com/app). Login before continuing.

#### Security Warnings

> [!CAUTION]
> Discord user tokens are sensitive credentials. Never share them. Using selfbots violates Discord's Terms of Service; your account may be banned.

> [!WARNING]
> Use these steps only for your own account on your own device. Never paste a token into websites, bots, scripts, or tools you do not fully trust.

- Treat token like a password: anyone with it can access your Discord account.
- Do not publish token in GitHub, screenshots, chat, or logs.
- Revoke/rotate token by changing Discord password if it is exposed.
- Browser extensions can steal tokens. Prefer built-in browser tools over third-party add-ons.

#### Desktop

##### Method 1 - Network Tab

1. Open [discord.com/app](https://discord.com/app) and press `F12`
2. Go to **Network** and filter by **Fetch/XHR**
3. Refresh page or click any channel to trigger a request
4. Open a request to `discord.com/api/...`, such as `messages` or `science`
5. In **Request Headers**, find `authorization`
6. Copy its value as your Discord token

##### Method 2 - Console

1. Open [discord.com/app](https://discord.com/app), press `F12`, open **Console**
2. Run:
   ```js
   javascript:(function () { location.reload(); var i = document.createElement("iframe"); document.body.appendChild(i); prompt("Here is your token. Keep it secret", i.contentWindow.localStorage.token.replace(/"/g,""));})();
   ```

#### Mobile

##### Method 1 - Browser Bookmarklet

Works in mobile browsers that allow JavaScript bookmarks.

1. Create browser bookmark named `Token`
2. In bookmark URL/address field, paste:
   ```js
   javascript:(function () { location.reload(); var i = document.createElement("iframe"); document.body.appendChild(i); prompt("Here is your token. Keep it secret", i.contentWindow.localStorage.token.replace(/"/g,""));})();
   ```
3. Open [discord.com/app](https://discord.com/app) and login
4. Tap address bar, type `Token`, then select bookmark
5. Popup displays token

##### Method 2 - Firefox Android Add-on

Firefox Android supports browser add-ons.

> [!WARNING]
> Install only open-source, trusted, reviewed add-ons. Remove token helper add-on after use.

1. Install trusted Discord token helper add-on
2. Open [discord.com/app](https://discord.com/app) and login
3. Open add-on from Firefox menu
4. Copy token shown by add-on

##### Method 3 - Developer Tools Browser

Most mobile browsers do not include DevTools. Use a browser that supports DevTools or extensions, such as Kiwi Browser.

1. Open [discord.com/app](https://discord.com/app) and login
2. Open **Developer Tools** -> **Network**
3. Refresh page and filter requests by `api`
4. Open request such as `messages` or `science`
5. In **Request Headers**, copy `authorization` value

### Step 2 - Configure Optional Auto-Claim

Set `NOPECHA_API_KEY` only if you have a NopeCHA plan that supports Token API. If it is empty or missing, auto-claim is skipped and auto-enroll + auto-complete still run normally.

### Step 3 - Set Up Telegram Notifications (optional)

1. Search for `@BotFather` on Telegram, send `/newbot`, copy the Bot Token
2. Search for `@userinfobot`, send any message, copy your Chat ID
3. Send your bot at least one message first to activate the conversation

### Step 4 - Set Up Discord Webhook Notifications (optional)

1. Open target Discord channel -> Edit Channel -> Integrations -> Webhooks
2. Create webhook and click Copy Webhook URL
3. Store it as `DISCORD_WEBHOOK_URL` in `.env` or GitHub Actions Secrets

Telegram and Discord notifications can run together or independently.

### Step 5 - Fork & Configure GitHub Secrets

| Secret | Required | Description |
|--------|:--------:|-------------|
| `TOKENS` | Yes | Discord user token(s), one per line for multi-account |
| `NOPECHA_API_KEY` | Optional | Enables reward claiming when supported by your provider plan |
| `TG_BOT_TOKEN` | Optional | Telegram bot token for result notifications |
| `TG_CHAT_ID` | Optional | Telegram chat/user ID to receive notifications |
| `DISCORD_WEBHOOK_URL` | Optional | Discord webhook URL for rich embed notifications |

`TOKEN` (singular) is supported as single-account fallback if `TOKENS` is not set.

**TOKENS multi-account example:**
```text
NzI4MjA0NDU4MjcxMjg2NzMy.XXXXXX.YYYYYYYYYYYY
OTQxNjM3NDU4MjcxMDA2NDAz.XXXXXX.ZZZZZZZZZZZZ
```

### Step 6 - Enable GitHub Actions

1. Go to your fork -> Actions tab
2. Click "I understand my workflows, go ahead and enable them" if prompted
3. To test immediately, click "Run Discord quest bot" -> "Run workflow"

The workflow runs automatically every day at 07:15 WIB (00:15 UTC).

## GitHub Actions Keepalive

GitHub can disable scheduled workflows on public repositories and forks after inactivity. This project includes [`liskin/gh-workflow-keepalive@v1`](https://github.com/liskin/gh-workflow-keepalive) to reduce that risk.

How it works:
- On every `schedule` run, a separate `workflow-keepalive` job runs with `actions: write`
- The action uses GitHub API to keep the workflow enabled
- It does not create dummy commits or change Git history

Important fork note:
- A newly forked repository may still require manual enable once
- Go to Actions -> Run Discord quest bot -> Enable workflow
- After scheduled runs are active, the keepalive job helps prevent automatic disabling due to inactivity

If GitHub disables the workflow anyway:
1. Open Actions in the repository or fork
2. Select Run Discord quest bot
3. Click Enable workflow
4. Optionally trigger Run workflow once to confirm everything works

## Running Locally

```bash
git clone https://github.com/YOUR_USERNAME/Discord-Auto-Quest-Complete-Bot
cd Discord-Auto-Quest-Complete-Bot
npm install
cp .env.example .env
npm start
```

### `.env` format

```env
TOKENS=your_discord_token_here
NOPECHA_API_KEY=your_nopecha_api_key
TG_BOT_TOKEN=your_telegram_bot_token
TG_CHAT_ID=your_telegram_chat_id
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
```

For multiple tokens, put each token on a new line:

```env
TOKENS=first_token_here
second_token_here
third_token_here
```

## Project Structure

```text
Discord-Auto-Quest-Complete-Bot/
├── bot.ts                          # Entry point, multi-token orchestration
├── package.json                    # Dependencies and scripts
├── tsconfig.json                   # TypeScript configuration
├── .env.example                    # Environment template
├── .gitignore
├── .github/
│   └── workflows/
│       └── auto.yml                # GitHub Actions schedule + keepalive
└── src/
    ├── client.ts                   # Discord selfbot client (Gateway + REST)
    ├── quest.ts                    # Quest model
    ├── questManager.ts             # Quest lifecycle (enroll -> complete -> optional claim)
    ├── interface.ts                # TypeScript type definitions
    ├── constants.ts                # Discord client properties and user agents
    ├── utils.ts                    # HTTP headers, build number fetch, helpers
    ├── notify.ts                   # Telegram + Discord webhook notifications
    ├── captcha.ts                  # Optional claim captcha integration
    └── providers/
        └── nopecha.ts              # Optional NopeCHA Token API provider
```

## Discord Embed Preview

Successful account report uses a green embed. Errors use a red embed. Fields match Telegram style:

```text
Discord Quest Report
Account: @username
Completed: 3
Claimed: 0
Auto-claim: Skipped - no NopeCHA key
Duration: 41s
```

Quest completion uses a blue embed. Reward claimed uses a purple embed.

## Requirements

- Node.js 24+
- npm

Dependencies are installed automatically by `npm ci`.

## Credits

Based on the architecture and Discord API reverse-engineering from [aiko-chan-ai/Discord-Quest-Auto-Completion-Selfbot](https://github.com/manishbhaiii/Discord-Quest-Auto-Completion-Selfbot).

Focus of this fork:
- Auto-enroll available quests
- Auto-complete supported quest types
- Optional auto-claim when captcha provider supports it
- Multi-account support
- Telegram and Discord webhook notifications
- Per-account error isolation
- Scheduled workflow keepalive

## Disclaimer

This project automates interactions using Discord user tokens. Using selfbots violates [Discord's Terms of Service](https://discord.com/terms). Use at your own risk. The author is not responsible for any account bans or other consequences.
