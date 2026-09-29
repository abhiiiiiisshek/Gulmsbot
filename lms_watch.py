#!/usr/bin/env python3
"""
GU LMS watcher
Checks the Galgotias Moodle LMS for new modules, assignments, deadlines,
announcements and notifications, and sends ONLY what changed to Telegram.

Mode A: Moodle mobile web-service API (clean, preferred)
Mode B: normal web login + Moodle's AJAX endpoints (fallback if the API is disabled)

Credentials come from environment variables (GitHub Secrets) - never hard-code them.
"""
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
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")
STATE_FILE = os.environ.get("STATE_FILE", "state.json")
DUE_SOON_HOURS = int(os.environ.get("DUE_SOON_HOURS", "48"))
HEARTBEAT = os.environ.get("HEARTBEAT", "1") == "1"  # "nothing new" ping on the morning run

IST = timezone(timedelta(hours=5, minutes=30))
UA = {"User-Agent": "Mozilla/5.0 (GU-LMS-Watcher; personal notifier)"}
CATEGORIES = ("courses", "modules", "assignments", "events", "announcements", "notifications")

warnings = []


class LMSError(Exception):
    pass


# ----------------------------------------------------------------- helpers
def clean(text):
    if not text:
        return ""
    text = BeautifulSoup(str(text), "html.parser").get_text(" ")
    return re.sub(r"\s+", " ", text).strip()


def esc(text):
    return (str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def fmt_time(ts):
    if not ts:
        return "no due date"
    return datetime.fromtimestamp(int(ts), IST).strftime("%a %d %b, %I:%M %p")


def flatten(obj, prefix=""):
    """Turn nested params into Moodle's key[0][name]=value form."""
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


def empty_snapshot():
    snap = {c: {} for c in CATEGORIES}
    snap["_ok"] = []          # categories fetched successfully this run
    snap["_failed_courses"] = []
    return snap


# ------------------------------------------------------- Mode A: web service
class ApiClient:
    mode = "Moodle API"

    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update(UA)
        r = self.s.post(f"{BASE}/login/token.php",
                        data={"username": USER, "password": PASS, "service": "moodle_mobile_app"},
                        timeout=30)
        try:
            data = r.json()
        except ValueError:
            raise LMSError("API token endpoint did not return JSON")
        if "token" not in data:
            raise LMSError(data.get("error") or "no API token returned")
        self.token = data["token"]

    def call(self, fn, **params):
        payload = {"wstoken": self.token, "wsfunction": fn, "moodlewsrestformat": "json"}
        payload.update(flatten(params))
        r = self.s.post(f"{BASE}/webservice/rest/server.php", data=payload, timeout=60)
        data = r.json()
        if isinstance(data, dict) and data.get("exception"):
            raise LMSError(f"{fn}: {data.get('message')}")
        return data


def collect_api(c):
    snap = empty_snapshot()
    uid = c.call("core_webservice_get_site_info")["userid"]

    courses = c.call("core_enrol_get_users_courses", userid=uid)
    for co in courses:
        snap["courses"][str(co["id"])] = clean(co["fullname"])
    snap["_ok"].append("courses")
    ids = [co["id"] for co in courses]

    # Modules / course material
    for cid in ids:
        cname = snap["courses"][str(cid)]
        try:
            for sec in c.call("core_course_get_contents", courseid=cid):
                for m in sec.get("modules", []):
                    if m.get("modname") == "label":
                        continue
                    snap["modules"][str(m["id"])] = {
                        "name": clean(m.get("name")), "type": m.get("modname", ""),
                        "course": cname, "section": clean(sec.get("name")),
                        "url": m.get("url") or f"{BASE}/course/view.php?id={cid}",
                    }
        except Exception as e:  # noqa: BLE001
            snap["_failed_courses"].append(cname)
            warnings.append(f"contents of {cname}: {e}")
    snap["_ok"].append("modules")

    # Assignments with due dates
    try:
        data = c.call("mod_assign_get_assignments", courseids=ids)
        for co in data.get("courses", []):
            cname = snap["courses"].get(str(co["id"]), clean(co.get("fullname")))
            for a in co.get("assignments", []):
                snap["assignments"][str(a["id"])] = {
                    "name": clean(a["name"]), "due": a.get("duedate") or 0, "course": cname,
                    "url": f"{BASE}/mod/assign/view.php?id={a['cmid']}", "cmid": a["cmid"],
                }
        snap["_ok"].append("assignments")
    except Exception as e:  # noqa: BLE001
        warnings.append(f"assignments: {e}")

    # Upcoming deadlines (quizzes, assignments, anything with a due date)
    try:
        ev = c.call("core_calendar_get_action_events_by_timesort",
                    timesortfrom=int(time.time()) - 86400, limitnum=50)
        add_events(snap, ev.get("events", []))
        snap["_ok"].append("events")
    except Exception as e:  # noqa: BLE001
        warnings.append(f"deadlines: {e}")

    # Announcements (news forums)
    try:
        forums = c.call("mod_forum_get_forums_by_courses", courseids=ids)
        for f in forums:
            if f.get("type") != "news":
                continue
            cname = snap["courses"].get(str(f.get("course")), "")
            try:
                d = c.call("mod_forum_get_forum_discussions", forumid=f["id"], perpage=10)
            except LMSError:
                d = c.call("mod_forum_get_forum_discussions_paginated", forumid=f["id"],
                           sortby="timemodified", sortdirection="DESC", perpage=10)
            for disc in d.get("discussions", []):
                did = disc.get("discussion") or disc.get("id")
                snap["announcements"][str(did)] = {
                    "name": clean(disc.get("name") or disc.get("subject")), "course": cname,
                    "url": f"{BASE}/mod/forum/discuss.php?d={did}",
                    "text": clean(disc.get("message"))[:200],
                }
        snap["_ok"].append("announcements")
    except Exception as e:  # noqa: BLE001
        warnings.append(f"announcements: {e}")

    add_notifications(snap, lambda: c.call("message_popup_get_popup_notifications",
                                           useridto=uid, limit=20))
    return snap


# ------------------------------------------------- Mode B: web login + AJAX
class WebClient:
    mode = "web login"

    def __init__(self):
        s = self.s = requests.Session()
        s.headers.update(UA)
        r = s.get(f"{BASE}/login/index.php", timeout=30)
        data = {"username": USER, "password": PASS}
        m = re.search(r'name="logintoken"\s+value="([^"]+)"', r.text)
        if m:
            data["logintoken"] = m.group(1)
        r = s.post(f"{BASE}/login/index.php", data=data, timeout=30)
        m = re.search(r'"sesskey":"([^"]+)"', r.text)
        if not m or "/login/index.php" in r.url:
            raise LMSError("web login failed - check LMS_USERNAME / LMS_PASSWORD")
        self.sesskey = m.group(1)

    def ajax(self, fn, **args):
        r = self.s.post(f"{BASE}/lib/ajax/service.php",
                        params={"sesskey": self.sesskey, "info": fn},
                        json=[{"index": 0, "methodname": fn, "args": args}], timeout=60)
        res = r.json()
        if isinstance(res, dict) and res.get("error"):
            raise LMSError(f"{fn}: {res.get('error')}")
        item = res[0]
        if item.get("error"):
            raise LMSError(f"{fn}: {(item.get('exception') or {}).get('message')}")
        return item["data"]


def collect_web(c):
    snap = empty_snapshot()
    data = c.ajax("core_course_get_enrolled_courses_by_timeline_classification",
                  classification="all", limit=0, offset=0, sort="fullname")
    courses = data.get("courses", [])
    for co in courses:
        snap["courses"][str(co["id"])] = clean(co["fullname"])
    snap["_ok"].append("courses")

    for co in courses:
        cid, cname = co["id"], snap["courses"][str(co["id"])]
        try:
            html_ = c.s.get(f"{BASE}/course/view.php?id={cid}", timeout=60).text
            soup = BeautifulSoup(html_, "html.parser")
            for li in soup.select("li.activity"):
                m = re.match(r"module-(\d+)", li.get("id", ""))
                if not m or "modtype_label" in li.get("class", []):
                    continue
                name = li.get("data-activityname")
                if not name:
                    inst = li.select_one(".instancename")
                    if inst:
                        for hidden in inst.select(".accesshide"):
                            hidden.decompose()
                        name = inst.get_text(" ")
                link = li.select_one("a.aalink") or li.select_one("a")
                mtype = next((k[8:] for k in li.get("class", []) if k.startswith("modtype_")), "")
                sec = li.find_parent("li", class_="section")
                sec_name = sec.select_one(".sectionname") if sec else None
                snap["modules"][m.group(1)] = {
                    "name": clean(name), "type": mtype, "course": cname,
                    "section": clean(sec_name.get_text(" ")) if sec_name else "",
                    "url": link["href"] if link and link.get("href") else f"{BASE}/course/view.php?id={cid}",
                }
        except Exception as e:  # noqa: BLE001
            snap["_failed_courses"].append(cname)
            warnings.append(f"course page {cname}: {e}")
    snap["_ok"].append("modules")

    try:
        ev = c.ajax("core_calendar_get_action_events_by_timesort",
                    timesortfrom=int(time.time()) - 86400, limitnum=50)
        add_events(snap, ev.get("events", []))
        snap["_ok"].append("events")
    except Exception as e:  # noqa: BLE001
        warnings.append(f"deadlines: {e}")

    add_notifications(snap, lambda: c.ajax("message_popup_get_popup_notifications",
                                           useridto=0, limit=20))
    return snap


# --------------------------------------------------------- shared collectors
def add_events(snap, events):
    for e in events:
        url = e.get("url") or ((e.get("action") or {}).get("url")) or ""
        snap["events"][str(e["id"])] = {
            "name": clean(e.get("name")), "due": e.get("timesort") or e.get("timestart") or 0,
            "course": clean((e.get("course") or {}).get("fullname")), "url": url,
        }


def add_notifications(snap, fetch):
    try:
        for n in fetch().get("notifications", []):
            snap["notifications"][str(n["id"])] = {
                "name": clean(n.get("subject")), "url": n.get("contexturl") or "",
                "time": n.get("timecreated") or 0,
            }
        snap["_ok"].append("notifications")
    except Exception as e:  # noqa: BLE001
        warnings.append(f"notifications: {e}")


# ------------------------------------------------------------- diff + state
def merge_with_old(new, old):
    """If something failed this run, keep the old data so it isn't re-reported as 'new' later."""
    for cat in CATEGORIES:
        if cat not in new["_ok"]:
            new[cat] = dict(old.get(cat, {}))
    failed = set(new["_failed_courses"])
    for k, v in old.get("modules", {}).items():
        if v.get("course") in failed and k not in new["modules"]:
            new["modules"][k] = v
    return new


def compute_changes(old, new):
    ch = {k: [] for k in ("assignments", "deadlines", "changed", "modules", "announcements", "notifications")}
    ok = set(new["_ok"])
    reported_urls = set()

    if "assignments" in ok:
        for k, v in new["assignments"].items():
            o = old.get("assignments", {}).get(k)
            if not o:
                ch["assignments"].append(v)
                reported_urls.add(v["url"])
            elif v.get("due") and o.get("due") != v.get("due"):
                ch["changed"].append({**v, "old_due": o.get("due")})
                reported_urls.add(v["url"])

    if "events" in ok:
        for k, v in new["events"].items():
            if any(u and u in v["url"] for u in reported_urls):
                continue
            o = old.get("events", {}).get(k)
            if not o:
                ch["deadlines"].append(v)
            elif o.get("due") != v.get("due"):
                ch["changed"].append({**v, "old_due": o.get("due")})

    new_assign_cmids = {str(a.get("cmid")) for a in ch["assignments"]}
    for cat in ("modules", "announcements", "notifications"):
        if cat not in ok:
            continue
        for k, v in new[cat].items():
            if k not in old.get(cat, {}) and not (cat == "modules" and k in new_assign_cmids):
                ch[cat].append(v)
    return ch


def due_soon(snap):
    now = time.time()
    horizon = now + DUE_SOON_HOURS * 3600
    seen, items = set(), []
    for v in list(snap["events"].values()) + list(snap["assignments"].values()):
        due = v.get("due") or 0
        key = v["name"].lower().replace(" is due", "").strip()
        if now < due <= horizon and key not in seen:
            seen.add(key)
            items.append(v)
    return sorted(items, key=lambda x: x["due"])


def upcoming(snap, limit=15):
    now = time.time()
    seen, items = set(), []
    for v in list(snap["events"].values()) + list(snap["assignments"].values()):
        key = v["name"].lower().replace(" is due", "").strip()
        if (v.get("due") or 0) > now and key not in seen:
            seen.add(key)
            items.append(v)
    return sorted(items, key=lambda x: x["due"])[:limit]


# ----------------------------------------------------------------- message
def line(v, show_due=True, extra=""):
    name = f'<a href="{esc(v["url"])}">{esc(v["name"])}</a>' if v.get("url") else esc(v["name"])
    parts = [f"• <b>{name}</b>"]
    if v.get("course"):
        parts.append(f" — {esc(v['course'])}")
    if show_due and v.get("due"):
        parts.append(f"\n   ⏳ {fmt_time(v['due'])}")
    return "".join(parts) + extra


def build_message(ch, snap, mode):
    now = datetime.now(IST).strftime("%d %b, %I:%M %p")
    blocks = []
    if ch["assignments"]:
        blocks.append("🆕 <b>New assignments</b>\n" + "\n".join(line(v) for v in ch["assignments"]))
    if ch["deadlines"]:
        blocks.append("🗓 <b>New deadlines</b>\n" + "\n".join(line(v) for v in ch["deadlines"]))
    if ch["changed"]:
        blocks.append("✏️ <b>Deadline changed</b>\n" + "\n".join(
            line(v, extra=f"\n   (was {fmt_time(v['old_due'])})") for v in ch["changed"]))
    if ch["announcements"]:
        blocks.append("📢 <b>Announcements</b>\n" + "\n".join(
            line(v, show_due=False) + (f"\n   <i>{esc(v['text'][:140])}…</i>" if v.get("text") else "")
            for v in ch["announcements"]))
    if ch["modules"]:
        mods = ch["modules"][:25]
        body = "\n".join(line({**v, "name": f"{v['name']} ({v['type']})" if v.get('type') else v['name']},
                              show_due=False) for v in mods)
        if len(ch["modules"]) > 25:
            body += f"\n…and {len(ch['modules']) - 25} more"
        blocks.append("📦 <b>New modules / material</b>\n" + body)
    if ch["notifications"]:
        blocks.append("🔔 <b>Notifications</b>\n" + "\n".join(line(v, show_due=False) for v in ch["notifications"]))

    soon = due_soon(snap)
    has_news = bool(blocks)
    if soon:
        blocks.append(f"⏰ <b>Due in the next {DUE_SOON_HOURS}h</b>\n" + "\n".join(line(v) for v in soon))

    if not has_news and not soon:
        if HEARTBEAT and datetime.now(IST).hour < 12:
            return f"✅ <b>GU LMS</b> — nothing new ({now})"
        return None
    header = f"📚 <b>GU LMS update</b> — {now}"
    return header + "\n\n" + "\n\n".join(blocks)


def build_first_run_message(snap, mode):
    up = upcoming(snap)
    msg = (f"✅ <b>GU LMS watcher connected</b> (via {mode})\n"
           f"Tracking {len(snap['courses'])} courses and {len(snap['modules'])} modules.\n"
           f"From now on you'll only hear about what's new.")
    if up:
        msg += "\n\n🗓 <b>Upcoming deadlines</b>\n" + "\n".join(line(v) for v in up)
    return msg


def send(text):
    if not (TG_TOKEN and TG_CHAT):
        print(text)
        return
    chunks, cur = [], ""
    for ln in text.split("\n"):
        if len(cur) + len(ln) + 1 > 3900:
            chunks.append(cur)
            cur = ""
        cur += ln + "\n"
    chunks.append(cur)
    for chunk in chunks:
        r = requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                          data={"chat_id": TG_CHAT, "text": chunk, "parse_mode": "HTML",
                                "disable_web_page_preview": "true"}, timeout=30)
        if not r.ok:
            print("Telegram error:", r.text, file=sys.stderr)


# -------------------------------------------------------------------- main
def main():
    if not USER or not PASS:
        sys.exit("Set LMS_USERNAME and LMS_PASSWORD")

    old = {}
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, encoding="utf-8") as f:
            old = json.load(f)

    try:
        try:
            client = ApiClient()
            snap = collect_api(client)
        except LMSError as e:
            print(f"API mode unavailable ({e}); falling back to web login")
            client = WebClient()
            snap = collect_web(client)
    except Exception as e:  # noqa: BLE001
        send(f"⚠️ <b>GU LMS watcher</b> couldn't check the LMS:\n<code>{esc(e)}</code>\n"
             "If you changed your password, update the LMS_PASSWORD secret.")
        raise

    first_run = not old
    snap = merge_with_old(snap, old)
    msg = build_first_run_message(snap, client.mode) if first_run else \
        build_message(compute_changes(old, snap), snap, client.mode)
    if msg:
        send(msg)
    else:
        print("Nothing new.")

    for w in warnings:
        print("warning:", w)
    snap.pop("_ok", None)
    snap.pop("_failed_courses", None)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=1, ensure_ascii=False, sort_keys=True)


if __name__ == "__main__":
    main()
