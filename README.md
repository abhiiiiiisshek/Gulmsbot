# GU LMS Assistant 🤖

A personal Telegram assistant for the Galgotias LMS. Runs 100% on free tiers — your laptop can stay off.

| Part | Runs on | Does |
|---|---|---|
| **Watcher** (`lms_watch.py`) | GitHub Actions, hourly | Alerts: new assignments, deadlines, material, announcements, grades + feedback, submission confirmations, nag-until-done reminders, draft trap, quiz windows, AI summaries & breakdowns, morning plan, Sunday report |
| **Bot** (`worker/`) | Cloudflare Workers | Live chat: `/pending` `/today` `/week` `/grades` `/courses` `/cal` `/status`, AI answers (text + 🎤 voice, Hinglish OK), **submit assignments by sending the file** |
| **AI** | Google Gemini free tier | Summaries, plans, pre-submit checks, chat |

Quiet hours: 11 PM – 7 AM IST, only urgent reminders (≤ 6 h left).

---

## One-time setup (≈15 min)

### 1. Gemini API key (free)
1. Go to **aistudio.google.com/apikey** → sign in with Google → **Create API key**.
2. Copy it.

### 2. Cloudflare (free)
1. Sign up at **dash.cloudflare.com** (free plan, no card).
2. Open **Workers & Pages** once. This creates your free `*.workers.dev` subdomain. If it asks you to pick a subdomain, pick anything.
3. Copy your **Account ID** (right sidebar on the Workers & Pages page, or the dashboard URL).
4. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template** → Continue → Create → copy the token.

### 3. Add GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | from step 2 |
| `CLOUDFLARE_API_TOKEN` | from step 2 |

(`LMS_USERNAME`, `LMS_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` are already there.)

### 4. Deploy
**Actions → Deploy Telegram bot → Run workflow.** When it's green, open the bot in Telegram and send `/start`.

That's it. Future code changes redeploy automatically.

---

## Extras
- **Google Calendar sync:** send `/cal` to the bot and follow the 3 steps.
- **Submit an assignment:** send the file to the bot → pick the assignment → (optional) 🔍 AI-check → ✅ Submit. It never submits without your tap, and it verifies the LMS status afterwards.
- **Test Telegram:** Actions → *Telegram test*. **Test LMS API:** Actions → *LMS probe*.

## Free-tier budgets (you're far below all of them)
- GitHub Actions (private repo): 2,000 min/month — hourly watcher ≈ 750.
- Cloudflare Workers: 100,000 requests/day.
- Gemini: free-tier rate limits (a few hundred requests/day). If busy, the bot says so; try again in a minute.

## Privacy
- Passwords/keys live only in GitHub Secrets and Cloudflare's encrypted secrets.
- `state.json` holds course/assignment names → **keep this repo Private**.
- On Gemini's free tier, Google may use prompts to improve its models — don't send anything you wouldn't share.
- The bot only answers your Telegram account (`TELEGRAM_CHAT_ID`); everyone else gets "private bot".
