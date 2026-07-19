# Discord-Auto-Quest-Complete-Bot

Automated Discord quest completion selfbot — auto-enroll and auto-complete supported quests, with optional auto-claim when `NOPECHA_API_KEY` is configured. Runs locally or daily via **GitHub Actions**.

## ✨ Features

- 🎯 **Auto-enroll** — automatically accepts available quests
- ▶️ **Auto-complete** — completes supported quest types without manual interaction
- 👥 **Multi-account** — process multiple Discord tokens in one run
- 🏆 **Optional auto-claim** — tries to redeem completed rewards only when NOPECHA_API_KEY exists
- 📨 **Telegram notifications** — per-account completion summary sent to your chat
- ♻️ **Workflow keepalive** — prevents scheduled workflow from being auto-disabled due to repository inactivity
- ⏰ **Daily schedule** — runs automatically at **07:15 WIB** (00:15 UTC) via GitHub Actions
- 🖐️ **Manual trigger** — run anytime from the Actions tab

## How It Works

```text
TOKENS (one per line)
    ↓ for each token
Connect to Discord Gateway (selfbot)
    ↓
Fetch available quests (/quests/@me)
    ↓
Auto-enroll unenrolled quests (/quests/{id}/enroll)
    ↓
Auto-complete supported tasks
    ↓
[if NOPECHA_API_KEY set] Auto-claim completed rewards
    ↓
Send Telegram report → disconnect → next account
```

### Supported Quest Types

| Type | Method |
|------|--------|
| `WATCH_VIDEO` / `WATCH_VIDEO_ON_MOBILE` | Video progress spoofing |
| `PLAY_ON_DESKTOP` / `PLAY_ON_XBOX` / `PLAY_ON_PLAYSTATION` | Game heartbeat spoofing |
| `PLAY_ACTIVITY` | Activity heartbeat spoofing |
| `ACHIEVEMENT_IN_ACTIVITY` | Discord Says OAuth + progress |
| `STREAM_ON_DESKTOP` | ⚠️ Not supported in headless mode |

---

## 🚀 Setup Guide

### Step 1 — Get Your Discord Token

> [!CAUTION]
> Discord user tokens are sensitive credentials. Never share them. Using selfbots violates Discord's Terms of Service — your account may be banned.

**Via Network Tab:**
1. Open [discord.com](https://discord.com) in your browser → press `F12`
2. Go to **Network** tab → filter by **Fetch/XHR**
3. Click any channel to trigger a request
4. Click any request to `discord.com/api/...`
5. In **Request Headers**, find the `Authorization` header → that's your token

**Via Console:**
1. Open [discord.com](https://discord.com) → press `F12` → **Console**
2. Run:
   ```js
   (webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken).exports.default.getToken()
   ```

### Step 2 — Configure Optional Auto-Claim

Set `NOPECHA_API_KEY` only if you have a NopeCHA plan that supports Token API. If it is empty or missing, auto-claim is skipped and auto-enroll + auto-complete still run normally.

### Step 3 — Set Up Telegram Notifications (optional)

1. Search for `@BotFather` on Telegram → send `/newbot` → copy the **Bot Token**
2. Search for `@userinfobot` → send any message → copy your **Chat ID**
3. Send your bot at least one message first to activate the conversation

### Step 4 — Fork & Configure GitHub Secrets

1. **Fork** this repository to your GitHub account
2. Go to your fork → **Settings → Secrets and variables → Actions**
3. Add the following secrets:

| Secret | Required | Description |
|--------|:--------:|-------------|
| `TOKENS` | ✅ | Discord user token(s) — one per line for multi-account |
| `NOPECHA_API_KEY` | ⬜ optional | Enables reward claiming when supported by your provider plan |
| `TG_BOT_TOKEN` | ⬜ optional | Telegram bot token for result notifications |
| `TG_CHAT_ID` | ⬜ optional | Telegram chat/user ID to receive notifications |

> `TOKEN` (singular) is supported as single-account fallback if `TOKENS` is not set.

**`TOKENS` multi-account example:**
```
NzI4MjA0NDU4MjcxMjg2NzMy.XXXXXX.YYYYYYYYYYYY
OTQxNjM3NDU4MjcxMDA2NDAz.XXXXXX.ZZZZZZZZZZZZ
```

### Step 5 — Enable GitHub Actions

1. Go to your fork → **Actions** tab
2. Click **"I understand my workflows, go ahead and enable them"** if prompted
3. To test immediately: click **"Run Discord quest bot"** → **"Run workflow"**

The workflow runs automatically every day at **07:15 WIB (00:15 UTC)**.

### GitHub Actions Keepalive

GitHub can disable scheduled workflows on public repositories and forks after a long period of repository inactivity. This project includes [`liskin/gh-workflow-keepalive@v1`](https://github.com/liskin/gh-workflow-keepalive) to reduce that risk.

How it works:
- On every `schedule` run, a separate `workflow-keepalive` job runs with `actions: write`
- The action uses GitHub API to keep the workflow enabled
- It does **not** create dummy commits or change your Git history

Important fork note:
- A newly forked repository may still require **manual enable once**
- Go to **Actions → Run Discord quest bot → Enable workflow**
- After scheduled runs are active, the keepalive job helps prevent automatic disabling due to inactivity

If GitHub disables the workflow anyway:
1. Open **Actions** in the repository or fork
2. Select **Run Discord quest bot**
3. Click **Enable workflow**
4. Optionally trigger **Run workflow** once to confirm everything works

## 🏠 Running Locally

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/Discord-Auto-Quest-Complete-Bot
cd Discord-Auto-Quest-Complete-Bot

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your values

# Run
npm start
```

### `.env` format:
```env
TOKENS=your_discord_token_here
NOPECHA_API_KEY=your_nopecha_api_key
TG_BOT_TOKEN=your_telegram_bot_token
TG_CHAT_ID=your_telegram_chat_id
```

For multiple tokens, put each token on a new line:
```env
TOKENS=first_token_here
second_token_here
third_token_here
```

---

## 📂 Project Structure

```text
Discord-Auto-Quest-Complete-Bot/
├── bot.ts                          # Entry point — multi-token orchestration
├── package.json                    # Dependencies & scripts
├── tsconfig.json                   # TypeScript configuration
├── .env.example                    # Environment template
├── .gitignore
├── .github/
│   └── workflows/
│       └── auto.yml                # GitHub Actions daily schedule
└── src/
    ├── client.ts                   # Discord selfbot client (Gateway + REST)
    ├── quest.ts                    # Quest model (status, completion checks)
    ├── questManager.ts             # Quest lifecycle (enroll → complete → optional claim)
    ├── interface.ts                # TypeScript type definitions
    ├── constants.ts                # Discord client properties & user agents
    ├── utils.ts                    # HTTP headers, build number fetch, helpers
    ├── notify.ts                   # Telegram notification sender
    ├── captcha.ts                  # Reserved for future claim experiments
    └── providers/
        └── nopecha.ts              # Reserved for future claim experiments
```

---

## ⚙️ Customization

### Change schedule

Edit `.github/workflows/auto.yml`:
```yaml
schedule:
  - cron: '15 0 * * *'   # 07:15 WIB — change as needed
```
Use https://crontab.guru to generate cron expressions.

---

## 📊 Telegram Notification Example

After each run, you'll receive messages like:

```text
✅ Discord Quest Report
⏱️ 19 Jul 2026, 14:00 WIB

👤 @username
  🎯 Completed: 3
  🎁 Claimed: 0
  🔓 Auto-claim: Skipped — no NopeCHA key
  ⚡ Duration: 41s
```

On failure:

```text
❌ Discord Quest Report
⏱️ 19 Jul 2026, 14:00 WIB

👤 Account 2
  🎯 Completed: 0
  ⚡ Duration: 0s

🚨 Error
Discord ready timeout
```

---

## Requirements

- Node.js 24+
- npm

Dependencies are installed automatically by `npm ci`.

---

## Credits

Based on the architecture and Discord API reverse-engineering from **[aiko-chan-ai/Discord-Quest-Auto-Completion-Selfbot](https://github.com/manishbhaiii/Discord-Quest-Auto-Completion-Selfbot)**.

Focus of this fork now:
- ✨ **Auto-enroll** available quests
- ✨ **Auto-complete** supported quest types
- 👥 **Multi-account support**
- 📨 **Telegram notifications**
- 🛡️ **Per-account error isolation**

---

## ⚠️ Disclaimer

This project automates interactions using Discord user tokens. Using selfbots violates [Discord's Terms of Service](https://discord.com/terms). Use at your own risk. The author is not responsible for any account bans or other consequences.

