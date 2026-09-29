# GU LMS Watcher

Checks the Galgotias Moodle LMS twice a day (7:45 AM & 7:45 PM IST) and sends you a Telegram message with **only what's new**:

- 🆕 New assignments
- 🗓 New deadlines (quizzes, submissions, anything with a due date)
- ✏️ Changed deadlines
- 📢 Course announcements
- 📦 New modules / study material
- 🔔 LMS notifications
- ⏰ Anything due in the next 48 hours (every run, as a reminder)

It runs on GitHub's servers for free, so your laptop can stay off.

---

## Setup (about 15 minutes)

### 0. Change your LMS password first
Use the new password only in step 3.

### 1. Create a Telegram bot
1. In Telegram, open **@BotFather** → send `/newbot` → pick a name → copy the **bot token**.
2. Open your new bot and press **Start** (it can't message you until you do).
3. Open **@userinfobot** → it replies with your numeric **chat ID**. Copy it.

### 2. Create a PRIVATE GitHub repo
1. github.com → **New repository** → name it `gu-lms-watcher` → choose **Private** (important) → Create.
2. **Add file → Upload files** → upload `lms_watch.py`, `requirements.txt`, `README.md` → Commit.
3. **Add file → Create new file** → in the name box type exactly
   `.github/workflows/lms-watch.yml`
   → paste the contents of `lms-watch.yml` → Commit.

### 3. Add your secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add four:

| Name | Value |
|---|---|
| `LMS_USERNAME` | your LMS username |
| `LMS_PASSWORD` | your (new) LMS password |
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `TELEGRAM_CHAT_ID` | number from @userinfobot |

### 4. First run
Repo → **Actions** tab → enable workflows if asked → **GU LMS watcher** → **Run workflow**.

Within a minute you should get: *"✅ GU LMS watcher connected"* with your upcoming deadlines. From then on it runs automatically.

---

## Tweaks
- **Change times:** edit the `cron` lines in the workflow (times are UTC; IST = UTC + 5:30).
- **Reminder window:** add an env `DUE_SOON_HOURS: "72"` under the *Check LMS* step.
- **No "nothing new" morning ping:** add env `HEARTBEAT: "0"`.
- **Check right now:** Actions → Run workflow.

## Troubleshooting
- **"couldn't log in"** on Telegram → wrong username/password secret (or you changed your password — update `LMS_PASSWORD`).
- **Log says "falling back to web login"** → normal; the college disabled Moodle's app API, so it uses the regular login page instead.
- **Timeouts / connection refused** → the college site may block non-Indian IPs. Tell Claude; the fallback is running the same script on your own machine or an Indian-region free VM.
- **No message at all** → make sure you pressed Start on your bot, and check the Actions run log.

## Privacy
- Your password only lives in GitHub's encrypted Secrets; it's never printed or committed.
- `state.json` (course and assignment names, used to detect what's new) is committed to the repo — that's why the repo must be **private**.
- Usage: roughly 60 of your free 2,000 GitHub Actions minutes per month.
