#!/usr/bin/env python3
"""
GU LMS watcher (runs hourly on GitHub Actions)

Sends Telegram alerts for:
  new assignments / deadlines / changed deadlines / announcements / material / notifications,
  new grades + feedback, submission confirmations, "nag until done" reminders,
  the draft trap (uploaded but never submitted), quiz windows,
  AI summaries of new PDFs, AI breakdowns of new assignments,
  a morning plan and a Sunday report.
Quiet hours 23:00-07:00 IST: only urgent reminders get through.

Secrets (env): LMS_USERNAME, LMS_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY (optional)
"""
import base64
import io
import zipfile
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

BASE = os.environ.get("LMS_BASE_URL", "https://gulms.galgotiasuniversity.org").rstrip("/")
USER = os.environ.get("LMS_USERNAME", "")
PASS = os.environ.get("LMS_PASSWORD", "")
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODELS = [m for m in [os.environ.get("GEMINI_MODEL")] if m] + [
    "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview",
    "gemini-3.5-flash-lite", "gemini-flash-lite-latest"]
STATE_FILE = os.environ.get("STATE_FILE", "state.json")
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()

IST = timezone(timedelta(hours=5, minutes=30))
UA = {"User-Agent": "Mozilla/5.0 (GU-LMS-Watcher; personal notifier)"}
DIGEST = ("courses", "modules", "assignments", "events", "announcements", "notifications")
NAG_HOURS = (72, 24, 6, 2)          # reminder thresholds before a deadline
URGENT_HOURS = 6                     # what may break quiet hours
MAX_AI_SUMMARIES = 3                 # per run, to stay inside Gemini free-tier limits

warnings = []
NOW = time.time()
NOW_IST = datetime.now(IST)


class LMSError(Exception):
    pass


# ----------------------------------------------------------------- helpers
def clean(text):
    if not text:
        return ""
    text = BeautifulSoup(str(text), "html.parser").get_text(" ")
    return re.sub(r"\s+", " ", text).strip()


def short(name):
    return re.sub(r"\s*\([A-Z0-9]+\)\s*$", "", clean(name))


def esc(text):
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def md_to_html(s):
    s = esc(s)
    s = re.sub(r"^#+\s*(.+)$", r"<b>\1</b>", s, flags=re.M)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)", r"\1<b>\2</b>", s, flags=re.M)
    return re.sub(r"^\s*[-*]\s+", "• ", s, flags=re.M)


def fmt_time(ts):
    if not ts:
        return "no due date"
    return datetime.fromtimestamp(int(ts), IST).strftime("%a %d %b, %I:%M %p")


def rel(ts):
    s = ts - NOW
    a = abs(s)
    txt = f"{round(a / 60)} min" if a < 3600 else f"{round(a / 3600)} h" if a < 172800 else f"{round(a / 86400)} days"
    return f"{txt} ago" if s < 0 else f"in {txt}"


def flatten(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}[{k}]" if prefix else k))
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            out.update(flatten(v, f"{prefix}[{i}]"))
    elif isinstance(obj, bool):
        out[prefix] = int(obj)
    else:
        out[prefix] = obj
    return out


def link(name, url):
    return f'<a href="{esc(url)}">{esc(name)}</a>' if url else esc(name)


# ------------------------------------------------------------------ Moodle
class Api:
    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update(UA)
        r = self.s.post(f"{BASE}/login/token.php", timeout=30,
                        data={"username": USER, "password": PASS, "service": "moodle_mobile_app"})
        data = r.json()
        if "token" not in data:
            raise LMSError(data.get("error") or "LMS login failed")
        self.token = data["token"]

    def call(self, fn, **params):
        payload = {"wstoken": self.token, "wsfunction": fn, "moodlewsrestformat": "json"}
        payload.update(flatten(params))
        data = self.s.post(f"{BASE}/webservice/rest/server.php", data=payload, timeout=60).json()
        if isinstance(data, dict) and data.get("exception"):
            raise LMSError(f"{fn}: {data.get('message')}")
        return data

    def download(self, fileurl, limit=15 * 1024 * 1024):
        sep = "&" if "?" in fileurl else "?"
        r = self.s.get(f"{fileurl}{sep}token={self.token}", timeout=90, stream=True)
        r.raise_for_status()
        data = b""
        for chunk in r.iter_content(65536):
            data += chunk
            if len(data) > limit:
                return None
        return data


_KV_NS = None


def _kv_base():
    """Cloudflare KV of the Telegram bot (shared brain: done-list, settings, snoozes, health)."""
    global _KV_NS
    if not (CF_TOKEN and CF_ACCOUNT):
        return None, None
    h = {"Authorization": f"Bearer {CF_TOKEN}"}
    base = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/storage/kv/namespaces"
    if _KV_NS is None:
        _KV_NS = next((n["id"] for n in requests.get(f"{base}?per_page=100", headers=h, timeout=30).json().get("result", [])
                       if n["title"].endswith("gulmsbot-kv")), "")
    return (f"{base}/{_KV_NS}", h) if _KV_NS else (None, None)


def kv_get(key, default=None):
    base, h = _kv_base()
    if not base:
        return default
    r = requests.get(f"{base}/values/{key}", headers=h, timeout=30)
    try:
        return r.json() if r.ok else default
    except ValueError:
        return r.text if r.ok else default


def kv_put(key, value):
    base, h = _kv_base()
    if base:
        requests.put(f"{base}/values/{key}", headers=h, data=str(value).encode(), timeout=30)


def get_done():
    """Items marked done in the Telegram bot. Keys like 'assign:55'."""
    return set(kv_get("done", {}) or {})


SETTINGS = {"mode": "hourly", "quiet": "23-7", "plan": True, "summaries": True, "sunday": True}
SNOOZED = set()
DONE = set()


def safe(label, fn, default=None):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        warnings.append(f"{label}: {e}")
        return default


def collect(c):
    snap = {k: {} for k in DIGEST + ("grades", "subs", "quizzes")}
    snap["_ok"] = []
    snap["_failed_courses"] = []
    snap["_extra"] = {"files": {}, "briefs": {}}
    c.uid = c.call("core_webservice_get_site_info")["userid"]

    courses = c.call("core_enrol_get_users_courses", userid=c.uid)
    for co in courses:
        snap["courses"][str(co["id"])] = short(co["fullname"])
    snap["_ok"].append("courses")
    ids = [co["id"] for co in courses]

    for cid in ids:
        cname = snap["courses"][str(cid)]
        try:
            for sec in c.call("core_course_get_contents", courseid=cid):
                for m in sec.get("modules", []):
                    if m.get("modname") in ("label", "subsection"):
                        continue
                    mid = str(m["id"])
                    snap["modules"][mid] = {
                        "name": clean(m.get("name")), "type": m.get("modname", ""), "course": cname,
                        "section": clean(sec.get("name")), "url": m.get("url") or f"{BASE}/course/view.php?id={cid}",
                    }
                    files = [f for f in (m.get("contents") or []) if f.get("type") == "file"]
                    if files:
                        snap["_extra"]["files"][mid] = files[0]
        except Exception as e:  # noqa: BLE001
            snap["_failed_courses"].append(cname)
            warnings.append(f"contents of {cname}: {e}")
    snap["_ok"].append("modules")

    def assignments():
        data = c.call("mod_assign_get_assignments", courseids=ids)
        for co in data.get("courses", []):
            cname = snap["courses"].get(str(co["id"]), short(co.get("fullname")))
            for a in co.get("assignments", []):
                aid = str(a["id"])
                snap["assignments"][aid] = {
                    "name": clean(a["name"]), "due": a.get("duedate") or 0, "course": cname,
                    "url": f"{BASE}/mod/assign/view.php?id={a['cmid']}", "cmid": a["cmid"],
                }
                snap["_extra"]["briefs"][aid] = {"intro": clean(a.get("intro"))[:3000],
                                                 "files": a.get("introattachments") or []}
        snap["_ok"].append("assignments")
    safe("assignments", assignments)

    def events():
        ev = c.call("core_calendar_get_action_events_by_timesort", timesortfrom=int(NOW) - 86400, limitnum=50)
        for e in ev.get("events", []):
            snap["events"][str(e["id"])] = {
                "name": clean(e.get("name")), "due": e.get("timesort") or 0,
                "course": short((e.get("course") or {}).get("fullname")),
                "url": e.get("url") or "", "type": e.get("modulename"), "instance": e.get("instance"),
            }
        snap["_ok"].append("events")
    safe("deadlines", events)

    def announcements():
        for f in c.call("mod_forum_get_forums_by_courses", courseids=ids):
            if f.get("type") != "news":
                continue
            cname = snap["courses"].get(str(f.get("course")), "")
            d = c.call("mod_forum_get_forum_discussions", forumid=f["id"], perpage=10)
            for disc in d.get("discussions", []):
                did = disc.get("discussion") or disc.get("id")
                snap["announcements"][str(did)] = {
                    "name": clean(disc.get("name") or disc.get("subject")), "course": cname,
                    "url": f"{BASE}/mod/forum/discuss.php?d={did}", "text": clean(disc.get("message"))[:200],
                }
        snap["_ok"].append("announcements")
    safe("announcements", announcements)

    def notifications():
        for n in c.call("message_popup_get_popup_notifications", useridto=c.uid, limit=20).get("notifications", []):
            snap["notifications"][str(n["id"])] = {"name": clean(n.get("subject")), "url": n.get("contexturl") or ""}
        snap["_ok"].append("notifications")
    safe("notifications", notifications)

    def grades():
        for cid in ids:
            r = c.call("gradereport_user_get_grade_items", courseid=cid, userid=c.uid)
            for g in (r.get("usergrades") or [{}])[0].get("gradeitems", []):
                if g.get("itemtype") == "course":
                    continue
                gf = g.get("gradeformatted") or "-"
                if gf == "-":
                    continue
                snap["grades"][f"{cid}:{g['id']}"] = {
                    "name": clean(g.get("itemname")), "grade": gf, "max": g.get("grademax"),
                    "feedback": clean(g.get("feedback"))[:300], "course": snap["courses"][str(cid)],
                }
        snap["_ok"].append("grades")
    safe("grades", grades)

    def subs():
        for aid, a in snap["assignments"].items():
            due = a.get("due") or 0
            if due and not (NOW - 3 * 86400 < due < NOW + 21 * 86400):
                continue
            st = c.call("mod_assign_get_submission_status", assignid=int(aid))
            sub = (st.get("lastattempt") or {}).get("submission") or (st.get("lastattempt") or {}).get("teamsubmission") or {}
            snap["subs"][aid] = sub.get("status") or "new"
        snap["_ok"].append("subs")
    safe("submission status", subs)

    def quizzes():
        for q in c.call("mod_quiz_get_quizzes_by_courses", courseids=ids).get("quizzes", []):
            snap["quizzes"][str(q["id"])] = {
                "name": clean(q.get("name")), "course": snap["courses"].get(str(q.get("course")), ""),
                "open": q.get("timeopen") or 0, "close": q.get("timeclose") or 0, "limit": q.get("timelimit") or 0,
                "url": f"{BASE}/mod/quiz/view.php?id={q.get('coursemodule')}",
            }
        snap["_ok"].append("quizzes")
    safe("quizzes", quizzes)
    return snap


def merge_with_old(new, old):
    """Categories that failed this run keep old data, so nothing is re-reported as new later."""
    for cat in DIGEST + ("grades", "subs", "quizzes"):
        if cat not in new["_ok"]:
            new[cat] = dict(old.get(cat, {}))
    failed = set(new["_failed_courses"])
    for k, v in old.get("modules", {}).items():
        if v.get("course") in failed and k not in new["modules"]:
            new["modules"][k] = v
    return new


# ------------------------------------------------------------------- diffs
def digest_changes(old, new):
    ch = {k: [] for k in ("assignments", "deadlines", "changed", "modules", "announcements", "notifications")}
    ok = set(new["_ok"])
    reported = set()
    if "assignments" in ok:
        for k, v in new["assignments"].items():
            o = old.get("assignments", {}).get(k)
            if not o:
                ch["assignments"].append({**v, "id": k})
                reported.add(v["url"])
            elif v.get("due") and o.get("due") != v.get("due"):
                ch["changed"].append({**v, "old_due": o.get("due")})
                reported.add(v["url"])
    if "events" in ok:
        for k, v in new["events"].items():
            if any(u and u in v["url"] for u in reported):
                continue
            o = old.get("events", {}).get(k)
            if not o:
                ch["deadlines"].append(v)
            elif o.get("due") != v.get("due"):
                ch["changed"].append({**v, "old_due": o.get("due")})
    new_cmids = {str(a.get("cmid")) for a in ch["assignments"]}
    for cat in ("modules", "announcements", "notifications"):
        if cat in ok:
            for k, v in new[cat].items():
                if k not in old.get(cat, {}) and not (cat == "modules" and k in new_cmids):
                    ch[cat].append({**v, "id": k})
    return ch


def grade_changes(old, new):
    if "grades" not in new["_ok"] or "grades" not in old:  # first run with grades = silent baseline
        return []
    out = []
    for k, g in new["grades"].items():
        o = old.get("grades", {}).get(k)
        if not o or o.get("grade") != g["grade"] or (g["feedback"] and o.get("feedback") != g["feedback"]):
            out.append({**g, "updated": bool(o)})
    return out


def submission_confirmations(old, new):
    out = []
    for aid, st in new["subs"].items():
        if st == "submitted" and old.get("subs", {}).get(aid) not in (None, "submitted"):
            a = new["assignments"].get(aid)
            if a:
                out.append(a)
    return out


def nags(new, meta, quiet):
    """Nag-until-done reminders + draft trap. Returns list of (html, assignment id, name)."""
    out = []
    sent = meta.setdefault("nag", {})
    for aid, a in new["assignments"].items():
        due = a.get("due") or 0
        st = new["subs"].get(aid)
        if not due or due <= NOW or st is None or st == "submitted" or f"assign:{aid}" in DONE or f"assign:{aid}" in SNOOZED:
            continue
        hours = (due - NOW) / 3600
        crossed = [h for h in NAG_HOURS if hours <= h]
        if not crossed:
            continue
        level = min(crossed)
        done = sent.get(aid, [])
        if level in done:
            continue
        if quiet and level > URGENT_HOURS:
            continue
        sent[aid] = sorted(set(done) | set(crossed))
        icon = "🚨" if level <= 6 else "⏰"
        trap = "\n   🪤 <b>It's still a DRAFT</b> — your teacher can't see it until you click Submit!" if st == "draft" else ""
        out.append((f"{icon} <b>{link(a['name'], a['url'])}</b> — {esc(a['course'])}\n"
                    f"   due {fmt_time(due)} (<b>{rel(due)}</b>), not submitted yet{trap}", aid, a["name"]))
    # forget finished assignments
    for aid in list(sent):
        if aid not in new["assignments"] or new["subs"].get(aid) == "submitted":
            sent.pop(aid, None)
    return out


def quiz_alerts(api, new, meta, quiet):
    out = []
    last = meta.get("last_run", NOW - 3600)
    flags = meta.setdefault("quiz", {})
    for qid, q in new["quizzes"].items():
        if f"quiz:{qid}" in DONE:
            continue
        f = flags.setdefault(qid, [])
        if q["open"] and last < q["open"] <= NOW and "open" not in f and not quiet:
            lim = f", ⏱ {q['limit'] // 60} min limit" if q["limit"] else ""
            closes = f", closes {fmt_time(q['close'])}" if q["close"] else ""
            out.append((f"❓ <b>Quiz open now:</b> {link(q['name'], q['url'])} — {esc(q['course'])}{closes}{lim}", None, None))
            f.append("open")
        if q["close"] and NOW < q["close"] <= NOW + 24 * 3600 and "closing" not in f:
            if quiet and q["close"] - NOW > URGENT_HOURS * 3600:
                continue
            attempts = safe("quiz attempts", lambda: api.call("mod_quiz_get_user_attempts", quizid=int(qid), status="finished"), {})
            if not (attempts or {}).get("attempts"):
                out.append((f"⏳ <b>Quiz closes {rel(q['close'])}</b> and you haven't attempted it: "
                            f"{link(q['name'], q['url'])} — {esc(q['course'])}", None, None))
            f.append("closing")
    for qid in list(flags):
        if qid not in new["quizzes"]:
            flags.pop(qid)
    return out


# --------------------------------------------------------------------- AI
def gemini(parts, system=None, max_tokens=4096):
    """Try free-tier models in order; skip ones that are retired (404), out of quota (429) or overloaded (5xx)."""
    if not GEMINI_KEY:
        return None
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0.4}}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    for attempt in range(2):
        for model in GEMINI_MODELS:
            r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                              headers={"x-goog-api-key": GEMINI_KEY}, json=body, timeout=120)
            if r.status_code in (404, 429, 500, 503):
                continue
            if not r.ok:
                warnings.append(f"gemini {model}: {r.status_code} {r.text[:200]}")
                return None
            parts_out = (r.json().get("candidates") or [{}])[0].get("content", {}).get("parts", [])
            return "".join(p.get("text", "") for p in parts_out if not p.get("thought")).strip() or None
        time.sleep(30)
    warnings.append("gemini: all models busy")
    return None


AI_STYLE = ("You write for a Telegram message read on a phone by Abhi, an MCA first-semester student. "
            "Plain text, short, '•' bullets, *single asterisks* for bold, no headings, no tables.")
READABLE = re.compile(r"pdf|image/|text/plain|presentationml|wordprocessingml")


def office_text(data, mime):
    """Plain text from PPTX/DOCX (they're zip files of XML)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    if "presentationml" in mime:
        names = sorted((n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                       key=lambda n: int(re.search(r"\d+", n).group()))
        out = []
        for i, n in enumerate(names, 1):
            paras = ["".join(re.findall(r"<a:t>([^<]*)</a:t>", p)) for p in z.read(n).decode("utf8", "ignore").split("</a:p>")]
            paras = [p for p in paras if p.strip()]
            if paras:
                out.append(f"[Slide {i}] " + " | ".join(paras))
        text = "\n".join(out)
    else:
        xml = z.read("word/document.xml").decode("utf8", "ignore")
        text = "\n".join(t for t in ("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p)) for p in xml.split("</w:p>")) if t.strip())
    return BeautifulSoup(text, "html.parser").get_text()[:90000]


def ai_summary(api, module, f):
    mime = f.get("mimetype") or ""
    if not READABLE.search(mime):
        return None
    data = api.download(f["fileurl"])
    if not data:
        return None
    if "officedocument" in mime:
        text = office_text(data, mime)
        if not text.strip():
            return None
        first = {"text": f"MATERIAL:\n{text}"}
    else:
        first = {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}
    return gemini([first,
                   {"text": f'New study material "{module["name"]}" for {module["course"]}. '
                            "Give: 1 line on what it covers, then 4-5 bullet key points, then 'Key terms:' with 5-8 terms. "
                            "Keep it under 120 words."}], system=AI_STYLE)


def ai_breakdown(api, a, brief):
    parts = []
    for f in brief.get("files", [])[:1]:
        if READABLE.search(f.get("mimetype") or ""):
            data = api.download(f["fileurl"])
            if data:
                parts.append({"inline_data": {"mime_type": f["mimetype"], "data": base64.b64encode(data).decode()}})
    if not parts and len(brief.get("intro", "")) < 20:
        return None
    parts.append({"text": f'New assignment "{a["name"]}" ({a["course"]}), due {fmt_time(a["due"])}.\n'
                          f'Brief: """{brief.get("intro") or "(see attached file)"}"""\n'
                          "Help him plan it (do NOT write the answers): *What they really want* (1-2 lines), "
                          "*Checklist* (bullets of deliverables/requirements), *Time needed* (estimate), "
                          "*Watch out* (1-2 common mistakes). Max 120 words."})
    return gemini(parts, system=AI_STYLE)


def pending_lines(api):
    ev = api.call("core_calendar_get_action_events_by_timesort", timesortfrom=int(NOW) - 14 * 86400,
                  timesortto=int(NOW) + 14 * 86400, limitnum=50).get("events", [])
    ev = [e for e in ev if f"{e.get('modulename')}:{e.get('instance')}" not in DONE]
    return [f"- {'[OVERDUE] ' if e['timesort'] < NOW else ''}{clean(e['name'])} ({short(e['course']['fullname'])}) "
            f"due {fmt_time(e['timesort'])}" for e in ev]


def morning_plan(api):
    lines = pending_lines(api)
    if not lines:
        return "☀️ <b>Good morning!</b> Nothing pending on the LMS. Free day — use it well 😎"
    txt = gemini([{"text": f"Today is {NOW_IST.strftime('%A %d %B')}. Pending LMS items:\n" + "\n".join(lines) +
                          "\n\nWrite a short morning plan: greet in one line (Hinglish ok), then 2-4 bullets of what "
                          "to do TODAY in priority order with rough time boxes, then one line about what's coming "
                          "later this week. Max 90 words."}], system=AI_STYLE)
    if txt:
        return "☀️ <b>Morning plan</b>\n\n" + md_to_html(txt)
    return "☀️ <b>Good morning!</b> Pending:\n" + esc("\n".join(lines[:10]))


def sunday_report(new, meta):
    week_ago = NOW - 7 * 86400
    done = [x for x in meta.get("log_submitted", []) if x[0] > week_ago]
    grades = [x for x in meta.get("log_grades", []) if x[0] > week_ago]
    upcoming = sorted([e for e in new["events"].values() if NOW < e["due"] <= NOW + 7 * 86400
                       and f"{e.get('type')}:{e.get('instance')}" not in DONE], key=lambda e: e["due"])
    pending_now = [a for aid, a in new["assignments"].items()
                   if a.get("due") and a["due"] > NOW and new["subs"].get(aid) not in (None, "submitted")
                   and f"assign:{aid}" not in DONE]
    msg = "📈 <b>Sunday report</b>\n"
    msg += f"\n✅ Submitted this week: <b>{len(done)}</b>"
    if done:
        msg += "\n" + "\n".join(f"   • {esc(n)}" for _, n in done[:10])
    msg += f"\n📊 Grades received: <b>{len(grades)}</b>"
    if grades:
        msg += "\n" + "\n".join(f"   • {esc(n)}" for _, n in grades[:10])
    msg += f"\n📝 Open assignments: <b>{len(pending_now)}</b>"
    msg += f"\n🗓 Due next 7 days: <b>{len(upcoming)}</b>"
    if upcoming:
        msg += "\n" + "\n".join(f"   • {link(e['name'], e['url'])} — {esc(e['course'])}, {fmt_time(e['due'])}" for e in upcoming[:12])
    return msg


# ---------------------------------------------------------------- messages
def line(v, show_due=True, extra=""):
    s = f"• <b>{link(v['name'], v.get('url'))}</b>"
    if v.get("course"):
        s += f" — {esc(v['course'])}"
    if show_due and v.get("due"):
        s += f"\n   ⏳ {fmt_time(v['due'])} ({rel(v['due'])})"
    return s + extra


def digest_message(ch, grades, confirms):
    blocks = []
    if confirms:
        blocks.append("✅ <b>Submission confirmed by the LMS</b>\n" + "\n".join(line(v, show_due=False) for v in confirms))
    if grades:
        blocks.append("📊 <b>Grades</b>\n" + "\n".join(
            f"• <b>{esc(g['name'])}</b> — {esc(g['course'])}: <b>{esc(g['grade'])}"
            f"{'/' + str(round(float(g['max']))) if g.get('max') else ''}</b>{' (updated)' if g['updated'] else ''}"
            + (f"\n   💬 <i>{esc(g['feedback'][:200])}</i>" if g.get("feedback") else "") for g in grades))
    if ch["assignments"]:
        blocks.append("🆕 <b>New assignments</b>\n" + "\n".join(line(v) for v in ch["assignments"]))
    if ch["deadlines"]:
        blocks.append("🗓 <b>New deadlines</b>\n" + "\n".join(line(v) for v in ch["deadlines"]))
    if ch["changed"]:
        blocks.append("✏️ <b>Deadline changed</b>\n" + "\n".join(
            line(v, extra=f"\n   (was {fmt_time(v['old_due'])})") for v in ch["changed"]))
    if ch["announcements"]:
        blocks.append("📢 <b>Announcements</b>\n" + "\n".join(
            line(v, show_due=False) + (f"\n   <i>{esc(v['text'][:160])}…</i>" if v.get("text") else "")
            for v in ch["announcements"]))
    if ch["modules"]:
        mods = ch["modules"][:25]
        body = "\n".join(line({**v, "name": f"{v['name']} ({v['type']})"}, show_due=False) for v in mods)
        if len(ch["modules"]) > 25:
            body += f"\n…and {len(ch['modules']) - 25} more"
        blocks.append("📦 <b>New material</b>\n" + body)
    if ch["notifications"]:
        blocks.append("🔔 <b>Notifications</b>\n" + "\n".join(line(v, show_due=False) for v in ch["notifications"]))
    if not blocks:
        return None
    return f"📚 <b>GU LMS update</b> — {NOW_IST.strftime('%d %b, %I:%M %p')}\n\n" + "\n\n".join(blocks)


def first_run_message(snap):
    up = sorted([e for e in snap["events"].values() if e["due"] > NOW], key=lambda e: e["due"])[:15]
    msg = (f"✅ <b>GU LMS watcher connected</b>\nTracking {len(snap['courses'])} courses, "
           f"{len(snap['modules'])} modules, {len(snap['assignments'])} assignments, {len(snap['grades'])} grades.\n"
           "From now on you'll only hear about what's new.")
    if up:
        msg += "\n\n🗓 <b>Upcoming deadlines</b>\n" + "\n".join(line(v) for v in up)
    return msg


def send(text, buttons=None):
    """buttons: list of rows, each row a list of (label, callback_data). '!' = open as a new message in the bot."""
    if isinstance(text, tuple):
        text, buttons = text
    if not (TG_TOKEN and TG_CHAT):
        raise RuntimeError("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets are missing")
    chunks, cur = [], ""
    for ln in text.split("\n"):
        if len(cur) + len(ln) + 1 > 3900:
            chunks.append(cur)
            cur = ""
        cur += ln + "\n"
    chunks.append(cur)
    for i, chunk in enumerate(chunks):
        data = {"chat_id": TG_CHAT, "text": chunk, "parse_mode": "HTML", "disable_web_page_preview": "true"}
        if buttons and i == len(chunks) - 1:
            data["reply_markup"] = json.dumps({"inline_keyboard": [[{"text": t[:60], "callback_data": d} for t, d in row] for row in buttons]})
        r = requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data, timeout=30)
        if not r.ok and "parse" in r.text.lower():  # broken HTML from AI -> send as plain text
            data.pop("parse_mode")
            data["text"] = re.sub(r"<[^>]+>", "", chunk)
            r = requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data, timeout=30)
        if not r.ok:
            raise RuntimeError(f"Telegram error: {r.json().get('description', r.text)}")


# -------------------------------------------------------------------- main
def main():
    if not USER or not PASS:
        sys.exit("Set LMS_USERNAME and LMS_PASSWORD")
    old = {}
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, encoding="utf-8") as f:
            old = json.load(f)
    meta = old.get("meta", {})

    global DONE, SNOOZED
    DONE = safe("done list", get_done, set())
    SETTINGS.update(safe("settings", lambda: kv_get("settings", {}) or {}, {}))
    SNOOZED = {k for k, v in (safe("snooze", lambda: kv_get("snooze", {}) or {}, {}) or {}).items() if v.get("until", 0) > NOW}
    try:
        api = Api()
        snap = collect(api)
    except Exception as e:  # noqa: BLE001
        send(f"⚠️ <b>GU LMS watcher</b> couldn't check the LMS:\n<code>{esc(e)}</code>\n"
             "If you changed your password, update the LMS_PASSWORD secret.")
        raise

    snap = merge_with_old(snap, old)
    extra = snap.pop("_extra")
    hour = NOW_IST.hour
    q = SETTINGS.get("quiet", "23-7")
    if q == "off":
        quiet = False
    else:
        qs, qe = (int(x) for x in q.split("-"))
        quiet = (hour >= qs or hour < qe) if qs > qe else (qs <= hour < qe)
    # digest frequency: hourly / 3x a day (8, 14, 20) / morning only (first run after quiet hours)
    slots = {"hourly": list(range(24)), "3x": [8, 14, 20], "morning": [7]}.get(SETTINGS.get("mode"), list(range(24)))
    past = [x for x in slots if x <= hour]
    slot_key = f"{NOW_IST.strftime('%Y-%m-%d')}-{past[-1]}" if past else None
    digest_now = not quiet and slot_key is not None and (SETTINGS.get("mode") == "hourly" or meta.get("digest_slot") != slot_key)
    today = NOW_IST.strftime("%Y-%m-%d")
    messages = []

    if not old.get("courses"):
        messages.append((first_run_message(snap), [[("🏠 Open menu", "home!")]]))
        meta["plan_date"] = today
    else:
        urgent = nags(snap, meta, quiet) + quiz_alerts(api, snap, meta, quiet)

        if quiet or not digest_now:
            # hold everything non-urgent until the next digest slot: keep old data so it's reported later
            for cat in DIGEST + ("grades", "subs"):
                snap[cat] = old.get(cat, snap[cat])
        else:
            ch = digest_changes(old, snap)
            grades = grade_changes(old, snap)
            confirms = submission_confirmations(old, snap)
            for a in confirms:
                meta.setdefault("log_submitted", []).append([NOW, a["name"]])
            for g in grades:
                meta.setdefault("log_grades", []).append([NOW, f"{g['name']}: {g['grade']}"])

            meta["digest_slot"] = slot_key
            if SETTINGS.get("plan", True) and meta.get("plan_date") != today:
                plan = safe("morning plan", lambda: morning_plan(api))
                if plan:
                    messages.append((plan, [[("📋 Pending", "v:pending!"), ("🏠 Menu", "home!")]]))
                meta["plan_date"] = today

            msg = digest_message(ch, grades, confirms)
            if msg:
                messages.append((msg, [[("📋 Pending", "v:pending!"), ("🏠 Menu", "home!")]]))

            # AI extras for brand-new items
            if GEMINI_KEY and SETTINGS.get("summaries", True):
                for a in ch["assignments"][:3]:
                    txt = safe("breakdown", lambda: ai_breakdown(api, a, extra["briefs"].get(a["id"], {})))
                    if txt:
                        messages.append((f"🧩 <b>Breakdown:</b> {link(a['name'], a['url'])}\n\n{md_to_html(txt)}",
                                         [[("📂 Brief + files", f"af:{a['id']}!"), ("📄 Answer template", f"at:{a['id']}!")],
                                          [("🧭 How do I start?", f"hs:{a['id']}!")]]))
                done = 0
                for m in ch["modules"]:
                    if done >= MAX_AI_SUMMARIES:
                        break
                    f = extra["files"].get(m["id"])
                    if m["type"] not in ("resource", "folder") or not f:
                        continue
                    txt = safe("summary", lambda: ai_summary(api, m, f))
                    if txt:
                        done += 1
                        messages.append((f"📄 <b>{link(m['name'], m['url'])}</b> — {esc(m['course'])}\n\n{md_to_html(txt)}",
                                         [[("🧠 Quiz me", f"sa:quiz:{m['id']}!"), ("🃏 Flashcards", f"sa:cards:{m['id']}!")],
                                          [("📖 Study this file", f"sm:{m['id']}!")]]))

            if SETTINGS.get("sunday", True) and NOW_IST.weekday() == 6 and hour >= 19 and meta.get("report_week") != NOW_IST.strftime("%G-%V"):
                messages.append((sunday_report(snap, meta), [[("🎯 Exam prep", "v:exam!"), ("🏠 Menu", "home!")]]))
                meta["report_week"] = NOW_IST.strftime("%G-%V")

        if urgent:
            done_btns = [[(f"✅ Done: {name}", f"m:assign:{aid}!")] for _, aid, name in urgent if aid][:5]
            messages.insert(0, ("🔔 <b>Reminders</b>\n\n" + "\n\n".join(h for h, _, _ in urgent),
                                done_btns + [[("📋 Pending", "v:pending!"), ("🏠 Menu", "home!")]]))

    for m in messages:
        if m:
            send(*m) if isinstance(m, tuple) else send(m)
    if not any(messages):
        print("Nothing new.")
    for w in warnings:
        print("warning:", w)

    # trim logs, persist
    for k in ("log_submitted", "log_grades"):
        meta[k] = [x for x in meta.get(k, []) if x[0] > NOW - 30 * 86400]
    meta["last_run"] = NOW
    safe("heartbeat", lambda: kv_put("watcher_last", int(NOW)))
    snap["meta"] = meta
    snap.pop("_ok", None)
    snap.pop("_failed_courses", None)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=1, ensure_ascii=False, sort_keys=True)


if __name__ == "__main__":
    main()
