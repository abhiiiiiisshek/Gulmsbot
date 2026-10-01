#!/usr/bin/env python3
"""
Study brain (runs every morning on GitHub Actions, ~7:05 AM IST)

1. Course maps: reads ALL course files (PPTX/DOCX/PDF) and builds a topic map per course
   (units -> topics, teaching order, difficulty, exam weight, which files teach it).
   Rebuilt only when a course's files change.
2. "Recently taught": files uploaded in the last 10 days = what was covered in class lately.
3. Priorities: deterministic score per topic (exam weight, freshly taught, weak, not started,
   teaching order) -> top candidates.
4. Daily plan: the AI composes today's study plan from the candidates, deadlines, quizzes,
   review cards and your daily study time, and explains why.
5. Lessons for today's plan are pre-generated, so "▶️ Start" in Telegram is instant.

Everything is stored in the bot's Cloudflare KV; the Telegram bot reads it.
"""
import hashlib
import io
import json
import re
import sys
import time
from datetime import datetime, timedelta

import lms_watch as w

FRESH_DAYS = 10
MAX_COURSE_CHARS = 300_000
MAX_FILE_CHARS = 14_000
LESSON_CHARS = 60_000
NOW = time.time()
TODAY = w.NOW_IST.strftime("%Y-%m-%d")
log = lambda *a: print("[brain]", *a, flush=True)  # noqa: E731


def pdf_text(data):
    from pypdf import PdfReader
    r = PdfReader(io.BytesIO(data))
    return "\n".join(f"[Page {i + 1}] {(p.extract_text() or '').strip()}" for i, p in enumerate(r.pages[:80]))


def file_text(api, f):
    mime = f.get("mimetype") or ""
    data = api.download(f["fileurl"], limit=25 * 1024 * 1024)
    if not data:
        return ""
    if "pdf" in mime:
        return pdf_text(data)
    if "officedocument" in mime:
        return w.office_text(data, mime)
    if "text/plain" in mime:
        return data.decode("utf8", "ignore")
    return ""


def parse_json(txt):
    if not txt:
        return None
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", txt.strip())
    start = min([i for i in (t.find("{"), t.find("[")) if i >= 0] or [0])
    try:
        return json.loads(t[start:])
    except ValueError:
        end = max(t.rfind("}"), t.rfind("]"))
        return json.loads(t[start:end + 1])


def course_files(api, cid):
    """Readable files of a course in teaching order: [{cmid, name, section, files:[...], modified}]"""
    out = []
    for sec in api.call("core_course_get_contents", courseid=cid):
        for m in sec.get("modules", []):
            if m.get("modname") not in ("resource", "folder"):
                continue
            files = [f for f in (m.get("contents") or []) if f.get("type") == "file" and w.READABLE.search(f.get("mimetype") or "")
                     and not (f.get("mimetype") or "").startswith("image/")]
            if files:
                out.append({"cmid": m["id"], "name": w.clean(m.get("name")), "section": w.clean(sec.get("name")),
                            "files": files[:4], "modified": max(f.get("timemodified") or f.get("timecreated") or 0 for f in files)})
    return out


# ------------------------------------------------------------------ 1. maps
MAP_PROMPT = """Below is ALL the course material for "{course}" (slides/notes in course order; each file has an id).
Build a study map of this course's syllabus. Return ONLY JSON:
{{"units": [{{"name": "unit name", "topics": [{{"name": "short topic name", "summary": "what it covers, max 20 words",
"cmids": [ids of the files where it is taught], "difficulty": 1-3, "minutes": realistic minutes to learn it well (15-60),
"weight": likely exam importance 1-3}}]}}]}}
Rules: 3-8 units, 3-10 topics per unit, in teaching order; only content that is actually in the material; merge duplicates;
skip admin content (attendance, marking scheme, course logistics)."""


def build_map(api, cid, cname, mats):
    chunks, total = [], 0
    for m in mats:
        text = ""
        for f in m["files"]:
            try:
                text += w.safe(f"read {f.get('filename')}", lambda: file_text(api, f), "") + "\n"
            except Exception as e:  # noqa: BLE001
                log("skip file", f.get("filename"), e)
        text = text.strip()[:MAX_FILE_CHARS]
        if not text:
            continue
        piece = f"### [file {m['cmid']}] {m['section']} / {m['name']}\n{text}\n"
        if total + len(piece) > MAX_COURSE_CHARS:
            break
        chunks.append(piece)
        total += len(piece)
    if not chunks:
        return None
    log(f"map {cname}: {len(chunks)} files, {total} chars")
    data = parse_json(w.gemini([{"text": MAP_PROMPT.format(course=cname) + "\n\n" + "".join(chunks)}], max_tokens=16000))
    if not data or not data.get("units"):
        return None
    valid = {m["cmid"] for m in mats}
    n = 0
    for u in data["units"]:
        for t in u.get("topics", []):
            n += 1
            t["id"] = f"{cid}-{n}"
            t["cmids"] = [c for c in (t.get("cmids") or []) if c in valid]
            t["order"] = n
    return {"cid": cid, "course": cname, "built": int(NOW), "units": data["units"]}


# ------------------------------------------------------------------ 3. priorities
def candidates(maps, mats_by_course, progress, perf):
    out = []
    for cid, mp in maps.items():
        modified = {m["cmid"]: m["modified"] for m in mats_by_course.get(cid, [])}
        first_open = None
        for u in mp["units"]:
            for t in u.get("topics", []):
                st = (progress.get(t["id"]) or {}).get("status", "new")
                if st == "mastered":
                    continue
                if first_open is None and st in ("new", "seen"):
                    first_open = t["id"]
                fresh = any(NOW - (modified.get(c) or 0) < FRESH_DAYS * 86400 for c in t.get("cmids", []))
                acc = (progress.get(t["id"]) or {}).get("acc")
                score = 2 * (t.get("weight") or 2) + (4 if fresh else 0) + (3 if st == "weak" else 0) \
                    + (1 if st in ("new", "seen") else 0) + (1.5 if t["id"] == first_open else 0) \
                    + (2 if acc is not None and acc < 0.6 else 0)
                out.append({"id": t["id"], "name": t["name"], "course": mp["course"], "unit": u["name"], "status": st,
                            "fresh": fresh, "minutes": t.get("minutes") or 30, "difficulty": t.get("difficulty") or 2,
                            "weight": t.get("weight") or 2, "summary": t.get("summary", ""), "score": round(score, 1)})
    return sorted(out, key=lambda x: -x["score"])


PLAN_PROMPT = """You are the study planner for Abhi (MCA, 1st semester, Galgotias University). Today is {today}.
He has {minutes} minutes to study today. {review}
Upcoming LMS deadlines and quizzes (next 14 days):
{deadlines}

Candidate topics, highest priority first (score from exam weight, recently taught in class = fresh, weak accuracy, not started, teaching order):
{cands}

Pick today's study blocks (2-4 blocks) that fit the time. Prefer: topics needed for the nearest deadline/quiz, freshly taught topics
(revise while fresh), weak topics, then the next topic in teaching order. Avoid more than 2 courses unless a deadline forces it.
Return ONLY JSON: {{"headline": "one motivating line, Hinglish ok, max 12 words",
"blocks": [{{"tid": "topic id from the list", "mode": "learn|revise|practice", "minutes": number, "why": "max 14 words, concrete"}}],
"tip": "one practical tip for today, max 15 words"}}"""


def make_plan(api, maps, cands, settings):
    minutes = int(settings.get("minutes") or 90)
    srs = w.kv_get("srs", {}) or {}
    due = sum(1 for c in (srs.get("cards") or {}).values() if c.get("due", 0) <= NOW)
    ev = api.call("core_calendar_get_action_events_by_timesort", timesortfrom=int(NOW) - 3 * 86400,
                  timesortto=int(NOW) + 14 * 86400, limitnum=50).get("events", [])
    deadlines = "\n".join(f"- {e.get('modulename')}: {w.clean(e['name'])} ({w.short(e['course']['fullname'])}) "
                          f"{'OVERDUE' if e['timesort'] < NOW else 'due ' + w.fmt_time(e['timesort'])}" for e in ev) or "- none"
    top = cands[:16]
    cand_txt = "\n".join(f"- {c['id']} | {c['course']} | {c['unit']} > {c['name']} | {c['status']}{' | TAUGHT RECENTLY' if c['fresh'] else ''}"
                         f" | ~{c['minutes']} min | weight {c['weight']} | score {c['score']}" for c in top)
    review = f"He also has {due} spaced-repetition review cards due (~{max(3, due // 3)} min) — add a short review block first." if due else ""
    data = parse_json(w.gemini([{"text": PLAN_PROMPT.format(today=w.NOW_IST.strftime("%A %d %B"), minutes=minutes, review=review,
                                                            deadlines=deadlines, cands=cand_txt)}], max_tokens=4000))
    ids = {c["id"]: c for c in top}
    blocks = []
    if due:
        blocks.append({"tid": "review", "mode": "review", "minutes": max(3, due // 3), "why": f"{due} cards you missed earlier", "name": "Review cards", "course": ""})
    for b in (data or {}).get("blocks", []):
        c = ids.get(str(b.get("tid")))
        if c and not any(x["tid"] == c["id"] for x in blocks):
            blocks.append({"tid": c["id"], "mode": b.get("mode") or "learn", "minutes": int(b.get("minutes") or c["minutes"]),
                           "why": b.get("why") or "", "name": c["name"], "course": c["course"], "fresh": c["fresh"]})
    if len(blocks) <= (1 if due else 0):  # AI failed -> deterministic fallback
        left = minutes
        for c in top:
            if left <= 10 or len(blocks) >= 3:
                break
            blocks.append({"tid": c["id"], "mode": "learn" if c["status"] in ("new", "seen") else "revise", "minutes": min(c["minutes"], left),
                           "why": "taught recently" if c["fresh"] else "next in syllabus", "name": c["name"], "course": c["course"], "fresh": c["fresh"]})
            left -= c["minutes"]
    return {"date": TODAY, "headline": (data or {}).get("headline") or "Let's get one solid session in 💪",
            "tip": (data or {}).get("tip") or "", "minutes": minutes, "blocks": blocks, "done": []}


# ------------------------------------------------------------------ 5. lessons
LESSON_PROMPT = """Teach the topic "{name}" ({summary}) from the course "{course}" to Abhi, an MCA 1st-semester student,
using the course material below as the source (you may add a standard example if the slides are thin).
Return ONLY JSON:
{{"goal": "By the end you can ... (one line)",
"steps": [{{"title": "short", "explain": "clear explanation with a concrete example, max 110 words, plain text",
"check": {{"q": "quick question that checks understanding (not trivia)", "options": ["4 options", "max 70 chars each"], "answer": 0, "why": "max 140 chars"}}}}],
"recap": ["3-5 one-line takeaways"],
"quiz": [{{"q": "exam-style question", "options": ["4 options"], "answer": 0, "why": "max 160 chars"}}]}}
Use 3-4 steps and exactly 3 quiz questions. Simple English (Hinglish words ok). Vary the correct option position.

MATERIAL:
{material}"""


def build_lesson(api, topic, course, mats_index):
    material = ""
    for cmid in topic.get("cmids", [])[:2]:
        m = mats_index.get(cmid)
        if not m:
            continue
        for f in m["files"][:2]:
            material += w.safe("lesson file", lambda: file_text(api, f), "") + "\n"
    data = parse_json(w.gemini([{"text": LESSON_PROMPT.format(name=topic["name"], summary=topic.get("summary", ""), course=course,
                                                              material=material[:LESSON_CHARS] or "(no slides — teach the standard syllabus content)")}],
                               max_tokens=8000))
    if not data or not data.get("steps"):
        return None
    ok = lambda q: q.get("q") and isinstance(q.get("options"), list) and len(q["options"]) >= 2 and 0 <= int(q.get("answer", -1)) < len(q["options"])  # noqa: E731
    data["steps"] = [s for s in data["steps"] if s.get("explain") and s.get("check") and ok(s["check"])][:4]
    data["quiz"] = [q for q in data.get("quiz", []) if ok(q)][:3]
    data.update({"tid": topic["id"], "name": topic["name"], "course": course, "cmids": topic.get("cmids", [])})
    return data if data["steps"] else None


# ------------------------------------------------------------------ main
def plan_message(plan):
    icon = {"learn": "📘", "revise": "🔁", "practice": "✍️", "review": "🃏"}
    lines = [f"📅 <b>Today's study plan</b> · {plan['minutes']} min\n<i>{w.esc(plan['headline'])}</i>\n"]
    for i, b in enumerate(plan["blocks"], 1):
        lines.append(f"{icon.get(b['mode'], '📘')} <b>{i}. {w.esc(b['name'])}</b> · {b['minutes']} min{' 🆕' if b.get('fresh') else ''}\n"
                     f"   {w.esc(b['course'])}{' · ' if b['course'] else ''}<i>{w.esc(b['why'])}</i>")
    if plan.get("tip"):
        lines.append(f"\n💡 {w.esc(plan['tip'])}")
    lines.append("\n<i>🆕 = taught in class recently</i>")
    buttons = [[(f"▶️ {i}. {b['name']}"[:55], "rv!" if b["tid"] == "review" else f"ls:{b['tid']}!")] for i, b in enumerate(plan["blocks"], 1)]
    buttons.append([("🗺 Course maps", "v:map!"), ("🏠 Menu", "home!")])
    return "\n".join(lines), buttons


def main():
    force = "--force" in sys.argv
    send_plan = "--no-send" not in sys.argv
    api = w.Api()
    api.uid = api.call("core_webservice_get_site_info")["userid"]
    courses = api.call("core_enrol_get_users_courses", userid=api.uid)
    settings = {**{"minutes": 90, "plan": True}, **(w.kv_get("settings", {}) or {})}
    progress = w.kv_get("progress", {}) or {}
    perf = w.kv_get("perf", {}) or {}

    maps, mats_by_course, mats_index = {}, {}, {}
    for co in courses:
        cid, cname = co["id"], w.short(co["fullname"])
        mats = course_files(api, cid)
        mats_by_course[cid] = mats
        mats_index.update({m["cmid"]: m for m in mats})
        fp = hashlib.sha1(json.dumps([(m["cmid"], m["modified"]) for m in mats]).encode()).hexdigest()[:16]
        existing = w.kv_get(f"map:{cid}", None)
        if existing and existing.get("fp") == fp and not force:
            maps[cid] = existing
            continue
        if not mats:
            continue
        mp = w.safe(f"map {cname}", lambda: build_map(api, cid, cname, mats))
        if mp:
            mp["fp"] = fp
            # mark which topics were taught recently, for the map view
            recent = {m["cmid"] for m in mats if NOW - m["modified"] < FRESH_DAYS * 86400}
            for u in mp["units"]:
                for t in u["topics"]:
                    t["fresh"] = any(c in recent for c in t["cmids"])
            w.kv_put(f"map:{cid}", mp)
            maps[cid] = mp
            log(f"map {cname}: {sum(len(u['topics']) for u in mp['units'])} topics")
            time.sleep(8)  # stay inside free-tier rate limits
        elif existing:
            maps[cid] = existing
    w.kv_put("maps:index", [{"cid": cid, "course": mp["course"], "topics": sum(len(u["topics"]) for u in mp["units"])} for cid, mp in maps.items()])

    cands = candidates(maps, mats_by_course, progress, perf)
    log(f"{len(cands)} candidate topics; top: {[c['name'] for c in cands[:5]]}")
    if not cands:
        return
    plan = make_plan(api, maps, cands, settings)
    topics = {t["id"]: (t, mp["course"]) for mp in maps.values() for u in mp["units"] for t in u["topics"]}
    for b in plan["blocks"]:
        if b["tid"] in topics:
            t, course = topics[b["tid"]]
            lesson = w.safe(f"lesson {t['name']}", lambda: build_lesson(api, t, course, mats_index))
            if lesson:
                w.kv_put(f"lesson:{t['id']}", lesson, ttl=3 * 86400)
                log(f"lesson ready: {t['name']}")
            time.sleep(4)
    w.kv_put("plan:today", plan, ttl=2 * 86400)
    print("::notice::maps: " + "; ".join(f"{mp['course']}={sum(len(u['topics']) for u in mp['units'])} topics/{len(mp['units'])} units" for mp in maps.values()))
    print("::notice::fresh (taught recently): " + ", ".join(c["name"] for c in cands if c["fresh"])[:600])
    print("::notice::plan: " + " | ".join(f"{x['name']} ({x['course']}, {x['minutes']}m): {x['why']}" for x in plan["blocks"])[:900])
    print(f"::notice::lessons pre-built: {sum(1 for x in plan['blocks'] if x['tid'] != 'review')} requested")
    if send_plan and settings.get("plan", True):
        w.send(*plan_message(plan))
    for x in w.warnings:
        log("warning:", x)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # surface the reason in the Actions summary
        import traceback
        tb = traceback.format_exc().strip().splitlines()
        print("::error::" + " | ".join(tb[-6:])[:900])
        raise
