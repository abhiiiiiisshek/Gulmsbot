// GU LMS Telegram bot — Cloudflare Worker (free plan)
// Live commands, AI chat (text + voice), and assignment submission from Telegram.
// Secrets (set automatically by the deploy workflow):
//   LMS_USERNAME, LMS_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY

const BASE = "https://gulms.galgotiasuniversity.org";
const UA = { "User-Agent": "Mozilla/5.0 (GU-LMS-Bot; personal assistant)" };
const GEMINI = "https://generativelanguage.googleapis.com";

// ------------------------------------------------------------------ entry
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const secret = await webhookSecret(env);

    if (url.pathname === "/health") {
      if (url.searchParams.get("k") !== secret) return new Response("forbidden", { status: 403 });
      const out = { worker: "ok" };
      try { out.lms_courses = (await courses(env)).length; } catch (e) { out.lms_error = String(e.message || e); }
      try { out.ai = (await gemini(env, [{ text: "Reply with just: ok" }], { maxTokens: 400 })).slice(0, 20); } catch (e) { out.ai_error = String(e.message || e).slice(0, 200); }
      return Response.json(out);
    }
    if (url.pathname !== "/tg" || req.method !== "POST") return new Response("GU LMS bot is running 🤖");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return new Response("forbidden", { status: 403 });

    const update = await req.json();
    // Telegram retries on slow/failed responses: never process the same update twice
    const seenKey = `u:${update.update_id}`;
    if (await env.KV.get(seenKey)) return new Response("dup");
    await env.KV.put(seenKey, "1", { expirationTtl: 86400 });

    try {
      await handle(update, env);
    } catch (e) {
      const chat = chatOf(update);
      if (chat) await tg(env, "sendMessage", { chat_id: chat, text: `⚠️ Error: ${String(e.message || e).slice(0, 300)}` }).catch(() => {});
    }
    return new Response("ok");
  },
};

function chatOf(u) {
  return u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? u.poll_answer?.user?.id;
}

async function webhookSecret(env) {
  const data = new TextEncoder().encode(`${env.TELEGRAM_BOT_TOKEN}:gulms-webhook`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

// ---------------------------------------------------------------- router
async function handle(update, env) {
  const chat = chatOf(update);
  if (!chat) return;
  if (String(chat) !== String(env.TELEGRAM_CHAT_ID).trim()) {
    if (update.message) await send(env, chat, "🔒 This is a private bot.");
    return;
  }

  if (update.callback_query) return onCallback(update.callback_query, env);
  if (update.poll_answer) return onPollAnswer(update.poll_answer, env);

  const msg = update.message;
  if (msg.document || msg.photo) return onFile(msg, env);
  if (msg.voice || msg.audio) return onVoice(msg, env);
  const text = (msg.text || "").trim();
  if (!text) return;

  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;
  const who = msg.from?.first_name || "";
  switch (cmd) {
    case "/start":
    case "/menu": return sendView(env, chat, await homeView(env, who));
    case "/help": return sendView(env, chat, await namedView(env, "help"));
    case "/pending":
    case "/done": return sendView(env, chat, await namedView(env, "pending"));
    case "/today": return sendView(env, chat, await namedView(env, "today"));
    case "/week": return sendView(env, chat, await namedView(env, "week"));
    case "/hidden": return sendView(env, chat, await namedView(env, "hidden"));
    case "/grades": return sendView(env, chat, await namedView(env, "grades"));
    case "/courses": return sendView(env, chat, await namedView(env, "courses"));
    case "/cal": return sendView(env, chat, await namedView(env, "cal"));
    case "/status": return sendView(env, chat, await namedView(env, "status"));
    case "/study": return sendView(env, chat, withNav(await coursePicker(env, "📚 <b>Study mode</b>\nPick a course:", "sc")));
    case "/exam": return sendView(env, chat, await namedView(env, "exam"));
    case "/start_here":
    case "/plan": return startHere(env, chat);
    case "/files": return sendView(env, chat, await assignListView(env));
    case "/stop":
      await env.KV.delete(`s:${chat}`); await env.KV.delete(`sh:${chat}`);
      return sendView(env, chat, { text: "🛑 Left study mode. Back to normal chat.", markup: { inline_keyboard: [NAV] } });
    case null: {
      const s = await getSession(env, chat);
      if (s?.mode === "ask") return studyAsk(env, chat, s, text);
      if (/(where|kaha+n?|kidhar).{0,25}(start|shuru|begin)|kya padh|what (should|do) i study|start studying/i.test(text)) return startHere(env, chat);
      return aiChat(env, chat, text);
    }
    default: return send(env, chat, "Unknown command. Try /help — or just ask me in plain words.");
  }
}

const HELP = `🤖 <b>GU LMS assistant</b>

🏠 /menu — your dashboard with buttons
📚 /study — pick a course file → summary, explain simply, quiz, flashcards, Q&A
🎯 /exam — revision plan + 10-question mock test for a course
🧭 /plan — "where do I start?" — a study plan for right now
📂 /files — assignment brief + attachments, answer template (.docx), how-to-start

<b>Ask anything</b> — in English or Hinglish, text or 🎤 voice:
<i>"kal kya submit karna hai?"</i>, <i>"plan my week"</i>, <i>"which subject am I behind in?"</i>

<b>Commands</b>
/pending — everything not yet submitted
/today — due today
/week — due in the next 7 days
/grades — your marks + feedback
/courses — your courses
/hidden — things you marked done yourself (undo here)
/cal — sync all deadlines to Google Calendar
/status — check the bot is healthy

✅ <b>Mark something done</b> (submitted offline, Wooclap, etc.): tap it under /pending, or just say <i>"ER diagram ho gaya"</i>.

📤 <b>Submit an assignment</b>: just send me the file (PDF, DOC, image…). I'll ask which assignment, can AI-check it against the brief, and only submit after you tap ✅.`;

// ---------------------------------------------------------------- Moodle
function flatten(obj, prefix = "", out = {}) {
  if (Array.isArray(obj)) obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (obj !== null && typeof obj === "object")
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}[${k}]` : k, out);
  else out[prefix] = typeof obj === "boolean" ? (obj ? 1 : 0) : obj;
  return out;
}

async function mtoken(env, fresh = false) {
  if (!fresh) {
    const t = await env.KV.get("mtoken");
    if (t) return t;
  }
  const r = await fetch(`${BASE}/login/token.php`, {
    method: "POST", headers: UA,
    body: new URLSearchParams({ username: env.LMS_USERNAME, password: env.LMS_PASSWORD, service: "moodle_mobile_app" }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`LMS login failed: ${j.error || "no token"}`);
  await env.KV.put("mtoken", j.token, { expirationTtl: 7 * 86400 });
  return j.token;
}

async function ws(env, fn, params = {}, retried = false) {
  const token = await mtoken(env, retried);
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json" });
  for (const [k, v] of Object.entries(flatten(params))) body.append(k, String(v));
  const r = await fetch(`${BASE}/webservice/rest/server.php`, { method: "POST", headers: UA, body });
  const j = await r.json();
  if (j && j.exception) {
    if (!retried && /token/i.test(`${j.errorcode} ${j.message}`)) return ws(env, fn, params, true);
    throw new Error(`${fn}: ${j.message}`);
  }
  return j;
}

async function userId(env) {
  const c = await env.KV.get("uid");
  if (c) return Number(c);
  const info = await ws(env, "core_webservice_get_site_info");
  await env.KV.put("uid", String(info.userid), { expirationTtl: 30 * 86400 });
  return info.userid;
}

async function courses(env) {
  const list = await ws(env, "core_enrol_get_users_courses", { userid: await userId(env) });
  return list.map((c) => ({ id: c.id, name: shortName(c.fullname) }));
}

const shortName = (n) => clean(n).replace(/\s*\([A-Z0-9]+\)\s*$/, "");

// Action events = things that still need doing (Moodle hides them once submitted)
// Items you marked done yourself (submitted offline, no-submit activities…). Stored in KV key "done".
async function getDone(env) {
  const d = JSON.parse((await env.KV.get("done")) || "{}");
  const cutoff = Date.now() / 1000 - 90 * 86400;
  for (const k of Object.keys(d)) if (d[k].at < cutoff) delete d[k];
  return d;
}
async function setDone(env, key, name, done) {
  const d = await getDone(env);
  if (done) d[key] = { name, at: Math.floor(Date.now() / 1000) };
  else delete d[key];
  await env.KV.put("done", JSON.stringify(d));
}

async function actionEvents(env, fromDaysAgo, toDays, includeDone = false) {
  const now = Math.floor(Date.now() / 1000);
  const done = includeDone ? {} : await getDone(env);
  const r = await ws(env, "core_calendar_get_action_events_by_timesort", {
    timesortfrom: now - fromDaysAgo * 86400, timesortto: now + toDays * 86400, limitnum: 50,
  });
  return (r.events || [])
    .filter((e) => e.action?.actionable !== false)
    .map((e) => ({
      name: clean(e.activityname || e.name.replace(/ is due$| closes$| opens$/i, "")),
      label: clean(e.name), due: e.timesort, course: shortName(e.course?.fullname || ""),
      type: e.modulename, instance: e.instance, url: e.url, overdue: e.timesort < now,
      key: `${e.modulename}:${e.instance}`,
    }))
    .filter((e) => !done[e.key]);
}

// ------------------------------------------------------------- commands
async function pendingText(env, days, title) {
  let items;
  if (days === 1) {
    const end = endOfTodayIST();
    items = (await actionEvents(env, 14, 2)).filter((e) => e.due <= end);
  } else items = await actionEvents(env, 14, days);
  const hidden = Object.keys(await getDone(env)).length;
  const hiddenNote = hidden ? `\n\n<i>🙈 ${hidden} item(s) marked done by you — /hidden to see or undo.</i>` : "";
  if (!items.length) return { text: `${title}\n\nNothing! 🎉 Go touch grass.${hiddenNote}` };
  const overdue = items.filter((e) => e.overdue);
  const upcoming = items.filter((e) => !e.overdue);
  let out = `${title} (${items.length})\n<i>🔴 overdue · 🟠 &lt;24h · 🟡 &lt;3 days · 🟢 later</i>\n`;
  if (overdue.length) out += `\n🔴 <b>Overdue</b>\n${overdue.map(fmtItem).join("\n")}\n`;
  if (upcoming.length) out += `\n${upcoming.map(fmtItem).join("\n")}`;
  out += `\n\n<i>Tap to mark something done (e.g. submitted offline):</i>${hiddenNote}`;
  const kb = items.slice(0, 10).map((e) => [{ text: `✅ ${e.name}`.slice(0, 50), callback_data: `m:${e.key}` }]);
  return { text: out, markup: { inline_keyboard: kb } };
}

async function hiddenView(env) {
  const d = await getDone(env);
  const keys = Object.keys(d);
  if (!keys.length) return { text: "🙈 Nothing marked done by you. Everything comes straight from the LMS." };
  return {
    text: `🙈 <b>Marked done by you</b> (${keys.length})\n\n${keys.map((k) => `• ${esc(d[k].name)} — ${fmtTime(d[k].at)}`).join("\n")}\n\n<i>Tap to bring one back:</i>`,
    markup: { inline_keyboard: keys.slice(0, 10).map((k) => [{ text: `↩️ ${d[k].name}`.slice(0, 50), callback_data: `u:${k}` }]) },
  };
}

const sendView = (env, chat, v) => send(env, chat, v.text, v.markup ? { reply_markup: v.markup } : {});

function fmtItem(e) {
  const icon = { assign: "📝", quiz: "❓", forum: "💬" }[e.type] || "📌";
  const when = e.overdue ? `<b>${relTime(e.due)}</b>` : `<b>${countdown(e.due)}</b> left`;
  return `${urgency(e)} ${icon} <a href="${esc(e.url)}">${esc(e.name)}</a>\n      ${esc(e.course)} · ${when} · <i>${fmtTime(e.due)}</i>`;
}

async function gradesText(env) {
  const uid = await userId(env);
  const cs = await courses(env);
  const results = await Promise.all(cs.map((c) =>
    ws(env, "gradereport_user_get_grade_items", { courseid: c.id, userid: uid }).then((r) => ({ c, r })).catch(() => null)));
  let out = "📊 <b>Your grades</b>\n";
  let any = false;
  for (const x of results) {
    if (!x) continue;
    const items = (x.r.usergrades?.[0]?.gradeitems || []).filter((g) => g.itemtype !== "course" && g.gradeformatted && g.gradeformatted !== "-");
    const total = (x.r.usergrades?.[0]?.gradeitems || []).find((g) => g.itemtype === "course");
    if (!items.length) continue;
    any = true;
    out += `\n<b>${esc(x.c.name)}</b>${total && total.gradeformatted !== "-" ? ` — total ${esc(total.gradeformatted)}` : ""}\n`;
    for (const g of items) {
      const max = g.grademax ? `/${Number(g.grademax)}` : "";
      const pct = Number(g.graderaw) >= 0 && Number(g.grademax) > 0 ? Number(g.graderaw) / Number(g.grademax) : null;
      const medal = pct === null ? "•" : pct >= 0.9 ? "🏆" : pct >= 0.75 ? "🌟" : pct >= 0.6 ? "👍" : "📈";
      out += `${medal} ${esc(clean(g.itemname))}: <b>${esc(g.gradeformatted)}${max}</b>${pct !== null ? `\n   ${bar(pct)} ${Math.round(pct * 100)}%` : ""}`;
      const fb = clean(g.feedback);
      if (fb) out += `\n   💬 <i>${esc(fb.slice(0, 150))}</i>`;
      out += "\n";
    }
  }
  return any ? out : "📊 No grades published yet.";
}

async function coursesText(env) {
  const [cs, ev] = await Promise.all([courses(env), actionEvents(env, 14, 60)]);
  const count = {};
  for (const e of ev) count[e.course] = (count[e.course] || 0) + 1;
  return "📚 <b>Your courses</b>\n\n" + cs.map((c) =>
    `• <a href="${BASE}/course/view.php?id=${c.id}">${esc(c.name)}</a>${count[c.name] ? ` — ${count[c.name]} pending` : " ✅"}`).join("\n");
}

async function calendarText(env) {
  const r = await ws(env, "core_calendar_get_calendar_export_token");
  const uid = await userId(env);
  const link = `${BASE}/calendar/export_execute.php?userid=${uid}&authtoken=${r.token}&preset_what=all&preset_time=recentupcoming`;
  return `🗓 <b>Sync deadlines to Google Calendar</b>

1. Open <a href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl">Google Calendar → Add from URL</a> (on a computer)
2. Paste this link:
<code>${esc(link)}</code>
3. Click <b>Add calendar</b>. Done!

Google refreshes it automatically every few hours, including changed deadlines. 🔒 Keep the link private: it shows your LMS calendar.`;
}

async function statusText(env) {
  const t0 = Date.now();
  let lms = "❌", ai = "❌";
  try { lms = `✅ ${(await courses(env)).length} courses`; } catch (e) { lms = `❌ ${esc(e.message)}`; }
  try { await gemini(env, [{ text: "Reply: ok" }], { maxTokens: 400 }); ai = "✅"; } catch (e) { ai = `❌ ${esc(String(e.message).slice(0, 150))}`; }
  return `🩺 <b>Status</b>\nLMS: ${lms}\nAI: ${ai}\n⏱ ${Date.now() - t0} ms`;
}

// ------------------------------------------------------------------ AI
async function lmsContext(env) {
  const [cs, ev] = await Promise.all([courses(env), actionEvents(env, 14, 45)]);
  const done = await getDone(env);
  const lines = ev.map((e) => `- [id=${e.key}] ${e.overdue ? "[OVERDUE] " : ""}${e.type}: "${e.name}" (${e.course}) due ${fmtTime(e.due)} (${relTime(e.due)})`);
  const doneLines = Object.entries(done).map(([k, v]) => `- [id=${k}] "${v.name}"`);
  return `Today is ${fmtTime(Math.floor(Date.now() / 1000), true)} (IST).
Enrolled courses: ${cs.map((c) => c.name).join("; ")}.
Pending items not yet submitted/attempted (${ev.length}):
${lines.join("\n") || "- none"}
Items Abhi already marked done himself (hidden from the list):
${doneLines.join("\n") || "- none"}`;
}

// The AI may append [[DONE:id]] / [[UNDONE:id]] tags; apply them and strip them from the reply
async function applyAiActions(env, reply) {
  const notes = [];
  const all = [...reply.matchAll(/\[\[(DONE|UNDONE):([a-z_]+:\d+)\]\]/g)];
  if (all.length) {
    const ev = await actionEvents(env, 30, 90, true);
    const done = await getDone(env);
    for (const [, act, key] of all) {
      const name = ev.find((e) => e.key === key)?.name || done[key]?.name;
      if (!name) continue;
      await setDone(env, key, name, act === "DONE");
      notes.push(act === "DONE" ? `✅ Marked done: <b>${esc(name)}</b>` : `↩️ Back on your list: <b>${esc(name)}</b>`);
    }
  }
  const text = mdToHtml(reply.replace(/\[\[(DONE|UNDONE):[^\]]*\]\]/g, "").trim());
  return notes.length ? `${text}\n\n${notes.join("\n")}` : text;
}

const SYSTEM = `You are Abhi's personal study assistant inside a Telegram bot connected to his Galgotias University LMS (MCA, first semester).
Style: friendly peer, witty but brief, reply in the same language/mix he uses (English or Hinglish). Keep answers short and scannable for a phone screen.
Formatting: plain text only. Use "•" for bullets and *single asterisks* for bold. No markdown headings, no tables.
Use ONLY the LMS data provided for facts about deadlines; never invent assignments or dates. If something isn't in the data, say so and suggest the right command (/grades, /pending, /cal).
If Abhi clearly says a pending item is finished/submitted/done (e.g. "ER diagram ho gaya", "mark SQL lab done"), confirm briefly and append [[DONE:<id>]] using the item's id from the data. If he says to bring one back / it's not done, append [[UNDONE:<id>]]. Only use ids that appear in the data; if unclear which item, ask instead of tagging.
If he asks to learn/revise a topic from his courses, answer briefly and tell him he can open 📚 Study (/study) to learn from the actual course slides, or /exam for a mock test.
For academic work: help him understand, plan and check — but do not write graded assignment answers for him to submit. If he asks for answers to an assignment, say briefly (no lecture) that you won't write them, and offer: 📂 /files → answer template + "how do I start", explaining the concept, a worked example on a *different* similar problem, or checking his own attempt.`;

async function aiChat(env, chat, text) {
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });
  const ctx = await lmsContext(env);
  const history = JSON.parse((await env.KV.get(`h:${chat}`)) || "[]");
  const reply = await gemini(env, [{ text: `${ctx}\n\nRecent chat:\n${history.join("\n") || "(none)"}\n\nAbhi: ${text}` }], { system: SYSTEM });
  await saveHistory(env, chat, history, text, reply);
  return send(env, chat, await applyAiActions(env, reply));
}

async function saveHistory(env, chat, history, q, a) {
  const h = [...history, `Abhi: ${q.slice(0, 300)}`, `Assistant: ${a.slice(0, 400)}`].slice(-8);
  await env.KV.put(`h:${chat}`, JSON.stringify(h), { expirationTtl: 6 * 3600 });
}

async function onVoice(msg, env) {
  const chat = msg.chat.id;
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });
  const v = msg.voice || msg.audio;
  const { bytes } = await tgDownload(env, v.file_id);
  const file = await geminiUpload(env, bytes, v.mime_type || "audio/ogg", "voice.ogg");
  const ctx = await lmsContext(env);
  const history = JSON.parse((await env.KV.get(`h:${chat}`)) || "[]");
  const reply = await gemini(env, [
    { file_data: { mime_type: file.mimeType, file_uri: file.uri } },
    { text: `${ctx}\n\nRecent chat:\n${history.join("\n") || "(none)"}\n\nAbhi sent the voice note above. First line: 🎤 followed by a short transcript in quotes. Then answer it.` },
  ], { system: SYSTEM });
  await saveHistory(env, chat, history, "(voice note)", reply);
  return send(env, chat, await applyAiActions(env, reply));
}

// Free-tier models, best first. If one is retired (404), out of quota (429) or overloaded (5xx),
// the next one is tried. The last model that worked is remembered.
const MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];

async function gemini(env, parts, { system, maxTokens = 8192, json = false } = {}) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const body = { contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.5 } };
  if (json) body.generationConfig.responseMimeType = "application/json";
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const remembered = await env.KV.get("gmodel");
  const order = [...new Set([env.GEMINI_MODEL, remembered, ...MODELS].filter(Boolean))];
  let lastErr = "no model available";
  for (const model of order) {
    const r = await fetch(`${GEMINI}/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if ([404, 429, 500, 503].includes(r.status)) { lastErr = `${model}: ${r.status}`; continue; }
    if (!r.ok) throw new Error(`AI error: ${j.error?.message || r.status}`);
    const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
    if (!text) throw new Error("AI returned an empty answer — try rephrasing.");
    if (model !== remembered) await env.KV.put("gmodel", model, { expirationTtl: 86400 });
    return text;
  }
  throw new Error(`Google's free AI is busy right now (${lastErr}). Try again in a minute.`);
}

async function geminiUpload(env, bytes, mime, name) {
  const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const upUrl = start.headers.get("x-goog-upload-url");
  if (!upUrl) throw new Error(`AI upload failed (${start.status})`);
  const r = await fetch(upUrl, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: bytes });
  let file = (await r.json()).file;
  for (let i = 0; i < 10 && file?.state === "PROCESSING"; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    file = await (await fetch(`${GEMINI}/v1beta/${file.name}`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } })).json();
  }
  if (!file?.uri) throw new Error("AI could not read that file");
  return file;
}

// ------------------------------------------------------ submission flow
async function onFile(msg, env) {
  const chat = msg.chat.id;
  const f = fileOf(msg);
  if (f.size > 20 * 1024 * 1024) return send(env, chat, "⚠️ Telegram only lets bots download files up to 20 MB. Please compress it or upload on the LMS directly.");
  const open = (await actionEvents(env, 14, 60)).filter((e) => e.type === "assign");
  if (!open.length) return send(env, chat, "🤔 You have no open assignments right now, so there's nothing to submit this to.", { reply_to_message_id: msg.message_id });
  const rows = open.slice(0, 12).map((e) => [{ text: `${e.overdue ? "🔴 " : ""}${e.name} · ${e.course}`.slice(0, 60), callback_data: `p:${e.instance}` }]);
  rows.push([{ text: "❌ Cancel", callback_data: "x" }]);
  return send(env, chat, `📎 <b>${esc(f.name)}</b> (${fmtSize(f.size)})\n\nWhich assignment is this for?`, {
    reply_to_message_id: msg.message_id, reply_markup: { inline_keyboard: rows },
  });
}

function fileOf(msg) {
  if (msg.document) return { id: msg.document.file_id, name: msg.document.file_name || "submission", mime: msg.document.mime_type || "application/octet-stream", size: msg.document.file_size || 0 };
  const p = msg.photo[msg.photo.length - 1];
  return { id: p.file_id, name: `photo_${msg.message_id}.jpg`, mime: "image/jpeg", size: p.file_size || 0 };
}

async function assignInfo(env, aid) {
  const st = await ws(env, "mod_assign_get_submission_status", { assignid: aid });
  const ev = (await actionEvents(env, 14, 60)).find((e) => e.type === "assign" && String(e.instance) === String(aid));
  // find full assignment settings (drafts, submission statement, intro)
  let a = null;
  const cs = await courses(env);
  const data = await ws(env, "mod_assign_get_assignments", { courseids: cs.map((c) => c.id) });
  for (const c of data.courses || []) for (const x of c.assignments || []) if (String(x.id) === String(aid)) a = { ...x, courseName: shortName(c.fullname) };
  if (!a) throw new Error("Assignment not found");
  const sub = st.lastattempt?.submission || st.lastattempt?.teamsubmission || {};
  const files = (sub.plugins || []).find((p) => p.type === "file")?.fileareas?.[0]?.files || [];
  return {
    id: aid, cmid: a.cmid, name: clean(a.name), course: a.courseName, due: a.duedate, cutoff: a.cutoffdate,
    drafts: a.submissiondrafts === 1, statement: a.requiresubmissionstatement === 1,
    intro: clean(a.intro).slice(0, 3000), introFiles: a.introattachments || [],
    status: sub.status || "new", existingFiles: files.map((f) => f.filename),
    canEdit: st.lastattempt?.canedit !== false, url: `${BASE}/mod/assign/view.php?id=${a.cmid}`, ev,
  };
}

async function onCallback(cq, env) {
  const chat = cq.message.chat.id;
  const mid = cq.message.message_id;
  const orig = cq.message.reply_to_message;
  let data = cq.data || "";
  const fresh = data.endsWith("!"); // buttons on watcher alerts open a new message instead of replacing the alert
  data = data.replace(/!$/, "");
  const [act, aid] = data.split(":");
  const parts = data.split(":");
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  const show = (v) => (fresh ? sendView(env, chat, v) : edit(env, chat, mid, v.text, v.markup || { inline_keyboard: [] }));

  if (act === "home") return show(await homeView(env, cq.from?.first_name || ""));
  if (act === "v") return show(await namedView(env, parts[1]));
  if (act === "st") return show(withNav(await coursePicker(env, "📚 <b>Study mode</b>\nPick a course:", "sc")));
  if (act === "sc") return show(await materialsView(env, parts[1], Number(parts[2] || 0)));
  if (act === "sm") { const m = await findMaterial(env, parts[1]); await setSession(env, chat, { cmid: m.cmid, name: m.name, mode: "browse" }); return show(materialCard(m)); }
  if (act === "sa") return studyAction(env, chat, parts[1], parts[2]);
  if (act === "ex") return examPrep(env, chat, parts[1]);
  if (act === "eq") return startQuiz(env, chat, { type: "exam", cid: parts[1] }, 10);
  if (act === "ec") return startCards(env, chat, { type: "exam", cid: parts[1] });
  if (act === "fc") return onCard(env, chat, mid, parts);
  if (act === "go") return startHere(env, chat);
  if (act === "af") return assignFiles(env, chat, parts[1]);
  if (act === "at") return answerTemplate(env, chat, parts[1]);
  if (act === "hs") return howToStart(env, chat, parts[1]);
  if (act === "dl") return downloadMaterial(env, chat, parts[1]);
  if (act === "stop") { await env.KV.delete(`s:${chat}`); await env.KV.delete(`sh:${chat}`); return send(env, chat, "🛑 Left study mode.", { reply_markup: { inline_keyboard: [NAV] } }); }

  if (act === "x") return edit(env, chat, mid, "❌ Cancelled. Nothing was uploaded.");
  if (act === "m" || act === "u") {
    const key = data.slice(2);
    const all = await actionEvents(env, 30, 90, true);
    const item = all.find((e) => e.key === key);
    const name = item?.name || (await getDone(env))[key]?.name || key;
    await setDone(env, key, name, act === "m");
    const note = act === "m"
      ? `✅ Marked done: <b>${esc(name)}</b>${key.startsWith("assign:") ? "\n<i>Heads-up: this only hides it in the bot and stops reminders. The LMS still shows it as not submitted.</i>" : ""}`
      : `↩️ Back on your list: <b>${esc(name)}</b>`;
    await send(env, chat, note);
    if (fresh) return;
    return show(await namedView(env, act === "m" ? "pending" : "hidden"));
  }
  if (!orig || !(orig.document || orig.photo)) return edit(env, chat, mid, "⚠️ I lost track of the file — please send it again.");
  const f = fileOf(orig);

  if (act === "p") return showSummary(env, chat, mid, f, await assignInfo(env, aid));

  if (act === "c") {
    await edit(env, chat, mid, `🔍 Checking <b>${esc(f.name)}</b> against the brief… (≈20 sec)`);
    const info = await assignInfo(env, aid);
    const review = await aiCheck(env, f, info);
    await send(env, chat, `🔍 <b>AI check</b> — ${esc(info.name)}\n\n${mdToHtml(review)}`);
    return showSummary(env, chat, null, f, info, orig.message_id);
  }

  if (act === "f" || act === "d") {
    const final = act === "f";
    await edit(env, chat, mid, `⏳ ${final ? "Submitting" : "Saving draft"}…`);
    const info = await assignInfo(env, aid);
    if (!info.canEdit) return edit(env, chat, mid, `🔒 The LMS doesn't allow changes to <b>${esc(info.name)}</b> anymore (probably submitted/locked or past cut-off).`);
    const { bytes } = await tgDownload(env, f.id);
    const itemid = await moodleUpload(env, bytes, f.name, f.mime);
    const warn = await ws(env, "mod_assign_save_submission", { assignmentid: Number(aid), plugindata: { files_filemanager: itemid } });
    if (Array.isArray(warn) && warn.length) return edit(env, chat, mid, `⚠️ LMS refused: ${esc(warn.map((w) => w.message).join("; "))}`);
    if (final && info.drafts) {
      const w2 = await ws(env, "mod_assign_submit_for_grading", { assignmentid: Number(aid), acceptsubmissionstatement: 1 });
      if (Array.isArray(w2) && w2.length) return edit(env, chat, mid, `⚠️ Uploaded as draft, but final submit failed: ${esc(w2.map((w) => w.message).join("; "))}\nOpen it on the LMS: ${esc(info.url)}`);
    }
    const after = await assignInfo(env, aid);
    const ok = final ? after.status === "submitted" : ["draft", "submitted"].includes(after.status);
    return edit(env, chat, mid,
      `${ok ? "✅" : "⚠️"} <b>${final ? "Submitted" : "Draft saved"}</b>: ${esc(info.name)} (${esc(info.course)})
📎 ${esc(f.name)}
🕒 ${fmtTime(Math.floor(Date.now() / 1000))}
LMS status now: <b>${esc(after.status)}</b>${!final && after.status === "draft" ? "\n\n⚠️ Remember: a draft is NOT submitted. Send the file again and tap ✅ Submit when ready." : ""}
🔗 <a href="${esc(info.url)}">Verify on the LMS</a>`);
  }
}

async function showSummary(env, chat, mid, f, info, replyTo) {
  const now = Date.now() / 1000;
  const late = info.due && info.due < now;
  const lines = [
    `📝 <b>${esc(info.name)}</b> — ${esc(info.course)}`,
    `📎 File: ${esc(f.name)} (${fmtSize(f.size)})`,
    `⏳ Due: ${info.due ? `${fmtTime(info.due)} (${relTime(info.due)})` : "no due date"}${late ? " 🔴 LATE" : ""}`,
    `📌 Current status: <b>${esc(info.status)}</b>`,
  ];
  if (info.existingFiles.length) lines.push(`⚠️ This will <b>replace</b> what's there now: ${esc(info.existingFiles.join(", "))}`);
  if (info.statement) lines.push(`📜 Tapping ✅ accepts the submission statement ("this is my own work").`);
  if (!info.drafts) lines.push(`ℹ️ This assignment has no draft stage — uploading = submitting.`);
  if (!info.canEdit) lines.push(`🔒 The LMS says you can't change this submission anymore.`);
  const buttons = [];
  if (info.canEdit) {
    buttons.push([{ text: "✅ Submit final", callback_data: `f:${info.id}` }]);
    if (info.drafts) buttons.push([{ text: "📝 Save as draft only", callback_data: `d:${info.id}` }]);
    if (/pdf|image|text/.test(f.mime)) buttons.push([{ text: "🔍 AI-check against brief first", callback_data: `c:${info.id}` }]);
  }
  buttons.push([{ text: "❌ Cancel", callback_data: "x" }]);
  const text = lines.join("\n");
  const markup = { inline_keyboard: buttons };
  if (mid) return edit(env, chat, mid, text, markup);
  return send(env, chat, text, { reply_to_message_id: replyTo, reply_markup: markup });
}

async function aiCheck(env, f, info) {
  const parts = [];
  const { bytes } = await tgDownload(env, f.id);
  const up = await geminiUpload(env, bytes, f.mime, f.name);
  parts.push({ file_data: { mime_type: up.mimeType, file_uri: up.uri } });
  const brief = info.introFiles.find((x) => /pdf|image|text/.test(x.mimetype || ""));
  if (brief) {
    const token = await mtoken(env);
    const sep = brief.fileurl.includes("?") ? "&" : "?";
    const r = await fetch(`${brief.fileurl}${sep}token=${token}`, { headers: UA });
    if (r.ok) {
      const b = await r.arrayBuffer();
      if (b.byteLength < 15 * 1024 * 1024) {
        const u2 = await geminiUpload(env, b, brief.mimetype, brief.filename);
        parts.push({ file_data: { mime_type: u2.mimeType, file_uri: u2.uri } });
      }
    }
  }
  parts.push({ text: `The FIRST file is Abhi's submission "${f.name}". ${brief ? "The SECOND file is the assignment brief attachment." : ""}
Assignment: "${info.name}" (${info.course}). Brief text from the LMS:
"""${info.intro || "(no text brief)"}"""

Review the submission against the brief like a strict but friendly TA. Output (plain text, "•" bullets, short):
Verdict: one line (Ready ✅ / Almost ⚠️ / Not ready ❌)
• Missing or incomplete parts (be specific: which question/requirement)
• Format issues (file type, name, headings, required sections)
• Quick wins before submitting (max 3)
Do NOT rewrite or provide answers.` });
  return gemini(env, parts);
}

async function moodleUpload(env, bytes, name, mime) {
  const token = await mtoken(env);
  const fd = new FormData();
  fd.append("token", token);
  fd.append("filearea", "draft");
  fd.append("itemid", "0");
  fd.append("file_1", new Blob([bytes], { type: mime }), name);
  const r = await fetch(`${BASE}/webservice/upload.php`, { method: "POST", headers: UA, body: fd });
  const j = await r.json();
  if (!Array.isArray(j) || !j[0]?.itemid) throw new Error(`LMS upload failed: ${j.error || j.message || JSON.stringify(j).slice(0, 150)}`);
  return j[0].itemid;
}

// ================================================================ UI: home dashboard & views
const NAV = [{ text: "🏠 Menu", callback_data: "home" }];
const withNav = (v, extraRows = []) => ({ text: v.text, markup: { inline_keyboard: [...(v.markup?.inline_keyboard || []), ...extraRows, NAV] } });

function urgency(e) {
  const left = e.due - Date.now() / 1000;
  return left < 0 ? "🔴" : left < 86400 ? "🟠" : left < 3 * 86400 ? "🟡" : "🟢";
}
function countdown(ts) {
  const s = Math.max(0, ts - Date.now() / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function bar(frac, n = 10) {
  const f = Math.max(0, Math.min(n, Math.round(frac * n)));
  return "▰".repeat(f) + "▱".repeat(n - f);
}

async function homeView(env, who = "") {
  const ev = await actionEvents(env, 14, 60);
  const now = Date.now() / 1000;
  const end = endOfTodayIST();
  const overdue = ev.filter((e) => e.overdue).length;
  const today = ev.filter((e) => !e.overdue && e.due <= end).length;
  const week = ev.filter((e) => !e.overdue && e.due <= now + 7 * 86400).length;
  const next = ev.filter((e) => !e.overdue).sort((a, b) => a.due - b.due)[0];
  const mood = overdue ? "🔥 A few fires to put out" : today ? "⚡ Busy day — let's go" : week ? "🙂 Manageable week" : "😎 All clear. Rare. Enjoy it.";
  let text = `🎓 <b>Hey${who ? ` ${esc(who)}` : ""}!</b>  ·  ${fmtTime(Math.floor(now)).split(",")[0]}\n${mood}\n\n`
    + `🔴 Overdue     <b>${overdue}</b>\n📅 Due today  <b>${today}</b>\n🗓 This week  <b>${week}</b>\n`;
  if (next) text += `\n⏳ <b>Next up</b> ${urgency(next)} ${esc(next.name)}\n     ${esc(next.course)} · <b>${countdown(next.due)}</b> left\n`;
  text += `\n<i>💬 Ask anything · 🎤 voice note · 📎 drop a file to submit</i>`;
  const kb = [
    [{ text: `📋 Pending (${ev.length})`, callback_data: "v:pending" }, { text: "📅 Today", callback_data: "v:today" }],
    [{ text: "🗓 This week", callback_data: "v:week" }],
    [{ text: "🧭 Where do I start?", callback_data: "go" }],
    [{ text: "📚 Study", callback_data: "st" }, { text: "🎯 Exam prep", callback_data: "v:exam" }],
    [{ text: "📂 Assignment files", callback_data: "v:assign" }, { text: "📊 Grades", callback_data: "v:grades" }],
    [{ text: "🗓 Calendar sync", callback_data: "v:cal" }, { text: "🙈 Hidden", callback_data: "v:hidden" }],
    [{ text: "🩺 Status", callback_data: "v:status" }, { text: "❓ Help", callback_data: "v:help" }],
  ];
  return { text, markup: { inline_keyboard: kb } };
}

async function namedView(env, name) {
  switch (name) {
    case "pending": return withNav(await pendingText(env, 60, "📋 <b>Everything pending</b>"));
    case "today": return withNav(await pendingText(env, 1, "📅 <b>Due today</b>"));
    case "week": return withNav(await pendingText(env, 7, "🗓 <b>Due this week</b>"));
    case "hidden": return withNav(await hiddenView(env));
    case "grades": return withNav({ text: await gradesText(env) });
    case "courses": return withNav({ text: await coursesText(env) });
    case "cal": return withNav({ text: await calendarText(env) });
    case "status": return withNav({ text: await statusText(env) });
    case "help": return withNav({ text: HELP });
    case "assign": return assignListView(env);
    case "exam": return withNav(await coursePicker(env, "🎯 <b>Exam prep</b>\nPick a course — I'll read its latest material and build a revision plan + mock test.", "ex"));
    default: return homeView(env);
  }
}

// ================================================================ Study mode
const READABLE = /pdf|presentationml|wordprocessingml|text\/plain/;
const KIND = (mime) => /presentationml/.test(mime) ? "📊" : /pdf/.test(mime) ? "📕" : /wordprocessingml/.test(mime) ? "📝" : "📄";

async function coursePicker(env, title, prefix) {
  const cs = await courses(env);
  const rows = [];
  for (let i = 0; i < cs.length; i += 2)
    rows.push(cs.slice(i, i + 2).map((c) => ({ text: c.name.slice(0, 30), callback_data: prefix === "ex" ? `ex:${c.id}` : `sc:${c.id}:0` })));
  return { text: title, markup: { inline_keyboard: rows } };
}

async function listMaterials(env, cid) {
  const cached = await env.KV.get(`ml:${cid}`);
  if (cached) return JSON.parse(cached);
  const secs = await ws(env, "core_course_get_contents", { courseid: cid });
  const list = [];
  for (const sec of secs)
    for (const m of sec.modules || []) {
      if (!["resource", "folder"].includes(m.modname)) continue;
      const files = (m.contents || []).filter((f) => f.type === "file" && READABLE.test(f.mimetype || ""))
        .slice(0, 4).map((f) => ({ url: f.fileurl, mime: f.mimetype, name: f.filename, size: f.filesize }));
      if (files.length) list.push({ cmid: m.id, cid, name: clean(m.name), section: clean(sec.name), files });
    }
  await env.KV.put(`ml:${cid}`, JSON.stringify(list), { expirationTtl: 6 * 3600 });
  return list;
}

async function findMaterial(env, cmid) {
  for (const c of await courses(env)) {
    const m = (await listMaterials(env, c.id)).find((x) => String(x.cmid) === String(cmid));
    if (m) return { ...m, course: c.name };
  }
  throw new Error("That file isn't on the LMS anymore.");
}

async function materialsView(env, cid, page = 0) {
  const [list, cs] = await Promise.all([listMaterials(env, cid), courses(env)]);
  const cname = cs.find((c) => String(c.id) === String(cid))?.name || "Course";
  const per = 8, pages = Math.max(1, Math.ceil(list.length / per));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * per, page * per + per);
  const rows = slice.map((m) => [{ text: `${KIND(m.files[0].mime)} ${m.name}`.slice(0, 55), callback_data: `sm:${m.cmid}` }]);
  const pager = [];
  if (page > 0) pager.push({ text: "⬅️ Prev", callback_data: `sc:${cid}:${page - 1}` });
  if (page < pages - 1) pager.push({ text: "Next ➡️", callback_data: `sc:${cid}:${page + 1}` });
  if (pager.length) rows.push(pager);
  rows.push([{ text: "🎯 Exam prep for this course", callback_data: `ex:${cid}` }]);
  rows.push([{ text: "⬅️ Courses", callback_data: "st" }, ...NAV]);
  const text = list.length
    ? `📚 <b>${esc(cname)}</b>\n${list.length} readable files · page ${page + 1}/${pages}\n\n<i>📊 slides · 📕 PDF · 📝 doc — pick one to study:</i>`
    : `📚 <b>${esc(cname)}</b>\n\nNo readable files here yet (I can read PDF, PPTX, DOCX, TXT).`;
  return { text, markup: { inline_keyboard: rows } };
}

function materialCard(m) {
  const kinds = [...new Set(m.files.map((f) => KIND(f.mime)))].join(" ");
  return {
    text: `📖 <b>${esc(m.name)}</b>\n📚 ${esc(m.course)}${m.section ? ` · ${esc(m.section)}` : ""}\n${kinds} ${m.files.length > 1 ? `${m.files.length} files` : esc(m.files[0].name)}\n\nWhat should we do with it?`,
    markup: { inline_keyboard: [
      [{ text: "📝 Summary", callback_data: `sa:sum:${m.cmid}` }, { text: "💡 Explain simply", callback_data: `sa:eli5:${m.cmid}` }],
      [{ text: "🧠 Quiz me (5)", callback_data: `sa:quiz:${m.cmid}` }, { text: "🃏 Flashcards", callback_data: `sa:cards:${m.cmid}` }],
      [{ text: "💬 Ask questions about it", callback_data: `sa:ask:${m.cmid}` }, { text: "⬇️ Download", callback_data: `dl:${m.cmid}` }],
      [{ text: "⬅️ Files", callback_data: `sc:${m.cid}:0` }, ...NAV],
    ] },
  };
}

// --- read PPTX / DOCX (zip files) without any library
async function zipEntries(buf, want) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip");
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!want(name)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = u8.subarray(start, start + csize);
    let xml;
    if (method === 0) xml = td.decode(data);
    else if (method === 8) xml = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    else continue;
    out.push({ name, xml });
  }
  return out;
}
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function officeText(buf, mime) {
  if (/presentationml/.test(mime)) {
    const slides = await zipEntries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    slides.sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
    return slides.map((s, i) => {
      const paras = s.xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("")).filter((t) => t.trim());
      return paras.length ? `[Slide ${i + 1}] ${unxml(paras.join(" | "))}` : "";
    }).filter(Boolean).join("\n");
  }
  if (/wordprocessingml/.test(mime)) {
    const [doc] = await zipEntries(buf, (n) => n === "word/document.xml");
    if (!doc) return "";
    return unxml(doc.xml.split(/<\/w:p>/).map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")).filter((t) => t.trim()).join("\n"));
  }
  return new TextDecoder().decode(buf);
}

// Returns Gemini "parts" for a material: extracted text for slides/docs, uploaded file for PDFs. Cached in KV.
async function materialParts(env, m) {
  const key = `mp:${m.cmid}`;
  const cached = await env.KV.get(key);
  if (cached) return JSON.parse(cached);
  const token = await mtoken(env);
  const parts = [];
  let hasFile = false, textBudget = 90000;
  for (const f of m.files) {
    const r = await fetch(`${f.url}${f.url.includes("?") ? "&" : "?"}token=${token}`, { headers: UA });
    if (!r.ok) continue;
    const buf = await r.arrayBuffer();
    if (/pdf/.test(f.mime)) {
      if (buf.byteLength > 18 * 1024 * 1024) continue;
      const up = await geminiUpload(env, buf, f.mime, f.name);
      parts.push({ file_data: { mime_type: up.mimeType, file_uri: up.uri } });
      hasFile = true;
    } else {
      const t = (await officeText(buf, f.mime)).slice(0, textBudget);
      textBudget -= t.length;
      if (t.trim()) parts.push({ text: `MATERIAL "${f.name}":\n${t}` });
    }
  }
  if (!parts.length) throw new Error("I couldn't read anything in that file (maybe it's only images).");
  // Gemini keeps uploaded files ~48h, so PDF-based parts are cached shorter
  await env.KV.put(key, JSON.stringify(parts), { expirationTtl: hasFile ? 40 * 3600 : 7 * 86400 });
  return parts;
}

const STUDY_STYLE = `You are a friendly, sharp tutor for Abhi (MCA, first semester, Galgotias University). Use ONLY the course material provided as your source; if something isn't covered, say so briefly.
Formatting for Telegram on a phone: plain text, short lines, emoji section markers, "•" bullets, *single asterisks* for bold. No markdown headings or tables. Match his language (English/Hinglish).`;

async function setSession(env, chat, s) { await env.KV.put(`s:${chat}`, JSON.stringify(s), { expirationTtl: 3 * 3600 }); }
async function getSession(env, chat) { return JSON.parse((await env.KV.get(`s:${chat}`)) || "null"); }

async function studyAction(env, chat, act, cmid) {
  const m = await findMaterial(env, cmid);
  await setSession(env, chat, { cmid: m.cmid, name: m.name, mode: act === "ask" ? "ask" : "browse" });
  if (act === "ask")
    return send(env, chat, `💬 <b>Ask me anything about:</b>\n📖 ${esc(m.name)}\n\nI'll answer from the file itself. Try <i>"explain the main concept"</i> or <i>"what's on slide 5?"</i>\n\n<i>/stop to leave study mode</i>`);
  if (act === "quiz") return startQuiz(env, chat, { type: "mat", cmid: m.cmid }, 5);
  if (act === "cards") return startCards(env, chat, { type: "mat", cmid: m.cmid });
  const wait = await send(env, chat, `⏳ Reading <b>${esc(m.name)}</b>… <i>(~15 sec)</i>`);
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  const parts = await materialParts(env, m);
  const prompt = act === "eli5"
    ? `Explain this material super simply, like to a smart friend who missed the class. Use 1-2 everyday analogies (Indian context welcome), then "🔑 Remember these 3 things". Max 180 words.`
    : `Summarise this material for revision:\n📌 What it's about (1 line)\n🔑 Key points (6-8 bullets)\n🧠 Key terms (term — 1-line meaning, max 6)\n❓ 2 likely exam questions\nMax 230 words.`;
  const out = await gemini(env, [...parts, { text: prompt }], { system: STUDY_STYLE });
  return edit(env, chat, wait.message_id, `${act === "eli5" ? "💡" : "📝"} <b>${esc(m.name)}</b>\n\n${mdToHtml(out)}`, { inline_keyboard: [
    [{ text: "🧠 Quiz me", callback_data: `sa:quiz:${m.cmid}` }, { text: "🃏 Flashcards", callback_data: `sa:cards:${m.cmid}` }],
    [{ text: act === "eli5" ? "📝 Full summary" : "💡 Explain simply", callback_data: `sa:${act === "eli5" ? "sum" : "eli5"}:${m.cmid}` }, { text: "💬 Ask about it", callback_data: `sa:ask:${m.cmid}` }],
    NAV,
  ] });
}

async function studyAsk(env, chat, s, question) {
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  const m = await findMaterial(env, s.cmid);
  const parts = await materialParts(env, m);
  const hist = JSON.parse((await env.KV.get(`sh:${chat}`)) || "[]");
  const out = await gemini(env, [...parts, { text: `${hist.length ? `Earlier in this study chat:\n${hist.join("\n")}\n\n` : ""}Abhi asks: ${question}\nAnswer from the material (mention slide/page when useful). Max 150 words.` }], { system: STUDY_STYLE });
  await env.KV.put(`sh:${chat}`, JSON.stringify([...hist, `Q: ${question.slice(0, 200)}`, `A: ${out.slice(0, 300)}`].slice(-6)), { expirationTtl: 3 * 3600 });
  return send(env, chat, `${mdToHtml(out)}\n\n<i>📖 Studying: ${esc(m.name)} · /stop to exit</i>`, { reply_markup: { inline_keyboard: [
    [{ text: "🧠 Quiz me on this", callback_data: `sa:quiz:${m.cmid}` }, { text: "🛑 Stop studying", callback_data: "stop" }],
  ] } });
}

// --- source of questions: one material, or a course's latest material (exam prep)
async function sourceParts(env, src) {
  if (src.type === "mat") {
    const m = await findMaterial(env, src.cmid);
    return { title: m.name, parts: await materialParts(env, m) };
  }
  const [list, cs] = await Promise.all([listMaterials(env, src.cid), courses(env)]);
  const cname = cs.find((c) => String(c.id) === String(src.cid))?.name || "Course";
  if (!list.length) throw new Error("No readable material in this course yet.");
  const latest = list.slice(-3);
  const parts = [{ text: `COURSE: ${cname}\nAll material titles: ${list.map((m) => m.name).join("; ")}` }];
  for (const m of latest) parts.push(...(await materialParts(env, { ...m, course: cname })));
  return { title: cname, parts, latest: latest.map((m) => m.name) };
}

async function examPrep(env, chat, cid) {
  const wait = await send(env, chat, "🎯 Reading your latest course material and building a plan… <i>(~30 sec)</i>");
  const src = await sourceParts(env, { type: "exam", cid });
  const out = await gemini(env, [...src.parts, { text: `Create exam prep for this course:\n🎯 Top 8 topics most likely to be asked (1 line each, most important first)\n📅 5-day revision plan (Day 1…Day 5, one line each)\n⚡ 3 smart exam tips for these topics\nMax 250 words.` }], { system: STUDY_STYLE });
  return edit(env, chat, wait.message_id, `🎯 <b>Exam prep — ${esc(src.title)}</b>\n<i>Based on: ${esc(src.latest.join(", "))}</i>\n\n${mdToHtml(out)}`, { inline_keyboard: [
    [{ text: "📝 10-question mock test", callback_data: `eq:${cid}` }],
    [{ text: "🃏 Flashcards", callback_data: `ec:${cid}` }, { text: "📚 Pick a file", callback_data: `sc:${cid}:0` }],
    NAV,
  ] });
}

// ================================================================ Quiz (native Telegram quiz polls)
function parseJson(s) {
  const t = s.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1));
}

async function startQuiz(env, chat, src, n) {
  const wait = await send(env, chat, `🧠 Cooking up ${n} questions… <i>(~20 sec)</i>`);
  const { title, parts } = await sourceParts(env, src);
  const raw = await gemini(env, [...parts, { text: `Create ${n} multiple-choice questions that test real understanding of the material above (university exam style; mix easy, medium, hard; no trivia about file names).
Return ONLY a JSON array: [{"q": "question, max 250 chars", "options": ["4 options", "each max 90 chars"], "answer": 0, "why": "why the answer is right, max 180 chars"}]. "answer" is the 0-based index of the correct option. Vary where the correct answer is.` }], { system: STUDY_STYLE, json: true });
  let qs = [];
  try { qs = parseJson(raw).filter((q) => q.q && Array.isArray(q.options) && q.options.length >= 2 && q.options[q.answer] !== undefined).slice(0, n); } catch { /* handled below */ }
  if (!qs.length) return edit(env, chat, wait.message_id, "😵 The AI returned a messy quiz. Tap again to retry.", { inline_keyboard: [NAV] });
  await env.KV.put(`qz:${chat}`, JSON.stringify({ total: qs.length, answered: 0, score: 0, title, src }), { expirationTtl: 2 * 86400 });
  await edit(env, chat, wait.message_id, `🧠 <b>Quiz: ${esc(title)}</b>\n${qs.length} questions below. Tap an answer — I'll keep score. 🎯`);
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const poll = await tg(env, "sendPoll", {
      chat_id: chat, question: `${i + 1}/${qs.length}. ${q.q}`.slice(0, 300),
      options: q.options.slice(0, 10).map((o) => ({ text: String(o).slice(0, 100) })),
      type: "quiz", correct_option_id: Number(q.answer), explanation: String(q.why || "").slice(0, 200), is_anonymous: false,
    });
    await env.KV.put(`poll:${poll.poll.id}`, JSON.stringify({ c: Number(q.answer) }), { expirationTtl: 2 * 86400 });
  }
}

async function onPollAnswer(pa, env) {
  const chat = pa.user.id;
  const p = JSON.parse((await env.KV.get(`poll:${pa.poll_id}`)) || "null");
  const s = JSON.parse((await env.KV.get(`qz:${chat}`)) || "null");
  if (!p || !s) return;
  s.answered += 1;
  if (pa.option_ids?.[0] === p.c) s.score += 1;
  await env.KV.put(`qz:${chat}`, JSON.stringify(s), { expirationTtl: 2 * 86400 });
  if (s.answered < s.total) return;
  const frac = s.score / s.total;
  const verdict = frac === 1 ? "🏆 Perfect! Topper energy." : frac >= 0.8 ? "🌟 Solid! Almost there." : frac >= 0.5 ? "👍 Decent — review the ones you missed." : "📚 Time to revise this one. You got this.";
  const again = s.src.type === "mat" ? `sa:quiz:${s.src.cmid}` : `eq:${s.src.cid}`;
  const cards = s.src.type === "mat" ? `sa:cards:${s.src.cmid}` : `ec:${s.src.cid}`;
  return send(env, chat, `🏁 <b>Quiz done — ${esc(s.title)}</b>\n\nScore: <b>${s.score}/${s.total}</b>\n${bar(frac)} ${Math.round(frac * 100)}%\n${verdict}`, { reply_markup: { inline_keyboard: [
    [{ text: "🔁 New questions", callback_data: again }, { text: "🃏 Flashcards", callback_data: cards }],
    NAV,
  ] } });
}

// ================================================================ Flashcards
async function startCards(env, chat, src) {
  const wait = await send(env, chat, "🃏 Making flashcards… <i>(~15 sec)</i>");
  const { title, parts } = await sourceParts(env, src);
  const raw = await gemini(env, [...parts, { text: `Create 8 revision flashcards from the material above: the most exam-relevant definitions, concepts and differences.
Return ONLY a JSON array: [{"q": "front: short question or term, max 150 chars", "a": "back: crisp answer, max 250 chars"}].` }], { system: STUDY_STYLE, json: true });
  let cards = [];
  try { cards = parseJson(raw).filter((c) => c.q && c.a).slice(0, 10); } catch { /* handled below */ }
  if (!cards.length) return edit(env, chat, wait.message_id, "😵 Couldn't make cards this time. Tap again to retry.", { inline_keyboard: [NAV] });
  const deck = { cards, i: 0, known: 0, missed: [], title, src };
  await env.KV.put(`fc:${chat}`, JSON.stringify(deck), { expirationTtl: 86400 });
  return edit(env, chat, wait.message_id, cardText(deck, false), cardKb(deck, false));
}

function cardText(d, revealed) {
  const c = d.cards[d.i];
  const dots = d.cards.map((_, k) => (k < d.i ? "●" : k === d.i ? "◉" : "○")).join("");
  return `🃏 <b>Card ${d.i + 1}/${d.cards.length}</b> · ${esc(d.title)}\n${dots}\n\n❓ <b>${esc(c.q)}</b>${revealed ? `\n\n💡 ${esc(c.a)}` : "\n\n<i>Think of the answer, then reveal…</i>"}`;
}
function cardKb(d, revealed) {
  return { inline_keyboard: revealed
    ? [[{ text: "✅ Knew it", callback_data: "fc:k:1" }, { text: "🔁 Not yet", callback_data: "fc:k:0" }]]
    : [[{ text: "👀 Reveal", callback_data: "fc:r" }], [{ text: "⏹ End deck", callback_data: "fc:end" }]] };
}

async function onCard(env, chat, mid, parts) {
  const d = JSON.parse((await env.KV.get(`fc:${chat}`)) || "null");
  if (!d) return edit(env, chat, mid, "This deck expired. Start a new one from 📚 Study.", { inline_keyboard: [NAV] });
  if (parts[1] === "r") return edit(env, chat, mid, cardText(d, true), cardKb(d, true));
  if (parts[1] === "again") {
    Object.assign(d, { cards: d.missed, i: 0, known: 0, missed: [] });
  } else if (parts[1] === "k") {
    if (parts[2] === "1") d.known += 1; else d.missed.push(d.cards[d.i]);
    d.i += 1;
  }
  if (parts[1] === "end" || d.i >= d.cards.length) {
    await env.KV.put(`fc:${chat}`, JSON.stringify(d), { expirationTtl: 86400 });
    const seen = parts[1] === "end" ? d.i : d.cards.length;
    const frac = seen ? d.known / seen : 0;
    const rows = [];
    if (d.missed.length) rows.push([{ text: `🔁 Practice the ${d.missed.length} I missed`, callback_data: "fc:again" }]);
    rows.push([{ text: "🧠 Quiz me", callback_data: d.src.type === "mat" ? `sa:quiz:${d.src.cmid}` : `eq:${d.src.cid}` }], NAV);
    return edit(env, chat, mid, `🏁 <b>Deck done — ${esc(d.title)}</b>\n\nYou knew <b>${d.known}/${seen}</b>\n${bar(frac)} ${Math.round(frac * 100)}%\n${frac >= 0.8 ? "🔥 Locked in!" : "💪 A couple more rounds and it'll stick."}`, { inline_keyboard: rows });
  }
  await env.KV.put(`fc:${chat}`, JSON.stringify(d), { expirationTtl: 86400 });
  return edit(env, chat, mid, cardText(d, false), cardKb(d, false));
}

// ================================================================ Files: send to Telegram, build .docx
async function tgSendFile(env, chat, bytes, filename, caption = "", markup) {
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("document", new Blob([bytes]), filename);
  if (caption) { fd.append("caption", caption.slice(0, 1000)); fd.append("parse_mode", "HTML"); }
  if (markup) fd.append("reply_markup", JSON.stringify(markup));
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram sendDocument: ${j.description}`);
  return j.result;
}

async function lmsFile(env, url, limit = 45 * 1024 * 1024) {
  const token = await mtoken(env);
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}token=${token}`, { headers: UA });
  if (!r.ok) throw new Error(`LMS file download failed (${r.status})`);
  const b = await r.arrayBuffer();
  if (b.byteLength > limit) throw new Error("File too big for Telegram (50 MB max) — open it on the LMS.");
  return b;
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// Minimal zip writer (no compression) — enough to build a .docx
function makeZip(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const xesc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function para(text, { bold = false, size = 22, color, italic = false, space = 120 } = {}) {
  const rpr = `<w:rPr>${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr>`;
  return `<w:p><w:pPr><w:spacing w:after="${space}"/></w:pPr><w:r>${rpr}<w:t xml:space="preserve">${xesc(text)}</w:t></w:r></w:p>`;
}
function buildDocx(paragraphsXml) {
  return makeZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphsXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>` },
  ]);
}
const safeName = (s) => String(s).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "file";

// ================================================================ Assignment files, templates, "how to start"
async function assignListView(env) {
  const open = (await actionEvents(env, 14, 60)).filter((e) => e.type === "assign");
  if (!open.length) return withNav({ text: "📂 No open assignments right now. 🎉" });
  return withNav({
    text: `📂 <b>Assignment files</b>\nTap one to get its brief + attachments, an answer template, or a "how to start" plan:`,
    markup: { inline_keyboard: open.slice(0, 12).map((e) => [{ text: `${urgency(e)} ${e.name} · ${e.course}`.slice(0, 60), callback_data: `af:${e.instance}` }]) },
  });
}

async function assignFiles(env, chat, aid) {
  const info = await assignInfo(env, aid);
  const brief = info.intro ? esc(info.intro.slice(0, 2500)) : "<i>(no text brief — see attached files)</i>";
  await send(env, chat, `📝 <b>${esc(info.name)}</b> — ${esc(info.course)}\n⏳ ${info.due ? `${fmtTime(info.due)} · <b>${relTime(info.due)}</b>` : "no due date"} · status <b>${esc(info.status)}</b>\n\n${brief}`, { reply_markup: { inline_keyboard: [
    [{ text: "📄 Answer template (.docx)", callback_data: `at:${aid}` }, { text: "🧭 How do I start?", callback_data: `hs:${aid}` }],
    [{ text: "🔗 Open on LMS", url: info.url }], NAV,
  ] } });
  for (const f of info.introFiles.slice(0, 5)) {
    try { await tgSendFile(env, chat, await lmsFile(env, f.fileurl), f.filename, `📎 ${esc(info.name)}`); }
    catch (e) { await send(env, chat, `⚠️ Couldn't send ${esc(f.filename)}: ${esc(e.message)}`); }
  }
}

async function briefParts(env, info) {
  const parts = [{ text: `ASSIGNMENT "${info.name}" (${info.course}). Brief from the LMS:\n"""${info.intro || "(see attachment)"}"""` }];
  for (const f of info.introFiles.slice(0, 2)) {
    try {
      const buf = await lmsFile(env, f.fileurl, 15 * 1024 * 1024);
      if (/pdf|image/.test(f.mimetype || "")) { const up = await geminiUpload(env, buf, f.mimetype, f.filename); parts.push({ file_data: { mime_type: up.mimeType, file_uri: up.uri } }); }
      else if (/officedocument|text\/plain/.test(f.mimetype || "")) parts.push({ text: `ATTACHMENT "${f.filename}":\n${(await officeText(buf, f.mimetype)).slice(0, 40000)}` });
    } catch { /* skip unreadable attachment */ }
  }
  return parts;
}

async function answerTemplate(env, chat, aid) {
  const wait = await send(env, chat, "📄 Building your answer template… <i>(~15 sec)</i>");
  const info = await assignInfo(env, aid);
  const raw = await gemini(env, [...await briefParts(env, info), { text: `Extract the structure of this assignment so the student can fill it in. Do NOT answer anything.
Return ONLY JSON: {"title": "assignment title", "instructions": ["general submission rules/format, max 5"], "questions": [{"label": "Q1 (or section name)", "text": "the exact question/task as written", "checklist": ["what the answer must include, max 4 short items"]}]}` }], { json: true });
  let t;
  try { const s = raw.replace(/^```(?:json)?\s*|\s*```$/g, ""); t = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { t = null; }
  if (!t?.questions?.length) return edit(env, chat, wait.message_id, "😵 I couldn't find clear questions in this brief. Open it with 📂 and check the attachment.", { inline_keyboard: [NAV] });
  let x = para(t.title || info.name, { bold: true, size: 36, color: "1F3864", space: 60 });
  x += para(`${info.course}${info.due ? `  ·  Due ${fmtTime(info.due)}` : ""}`, { size: 20, color: "666666", space: 240 });
  x += para("Name: ______________________    Roll No: ______________    Section: ______", { size: 22, space: 300 });
  if (t.instructions?.length) {
    x += para("Instructions", { bold: true, size: 26, color: "1F3864" });
    for (const i of t.instructions) x += para(`•  ${i}`, { size: 21, space: 60 });
    x += para("", { space: 200 });
  }
  for (const q of t.questions) {
    x += para(q.label || "Question", { bold: true, size: 28, color: "1F3864", space: 80 });
    x += para(q.text || "", { size: 22, space: 100 });
    for (const c of q.checklist || []) x += para(`☐  ${c}`, { size: 20, color: "555555", italic: true, space: 40 });
    x += para("Answer:", { bold: true, size: 22, space: 80 });
    for (let k = 0; k < 6; k++) x += para("", { space: 120 });
  }
  x += para("Before submitting: tick every ☐, re-read the brief, export to PDF if asked.", { italic: true, size: 18, color: "888888" });
  await tgSendFile(env, chat, buildDocx(x), `${safeName(info.name)}_template.docx`, `📄 <b>Answer template</b> — ${esc(info.name)}\n${t.questions.length} questions laid out with checklists. Fill it in, then send it back here to submit ✅`);
  return edit(env, chat, wait.message_id, `✅ Template ready for <b>${esc(info.name)}</b> ⬇️`, { inline_keyboard: [[{ text: "🧭 How do I start?", callback_data: `hs:${aid}` }], NAV] });
}

async function materialsIndex(env, onlyCourse) {
  const cs = await courses(env);
  const out = [];
  for (const c of cs) {
    if (onlyCourse && c.name !== onlyCourse) continue;
    for (const m of (await listMaterials(env, c.id)).slice(-12)) out.push({ cmid: m.cmid, name: m.name, course: c.name });
  }
  return out;
}

async function howToStart(env, chat, aid) {
  const wait = await send(env, chat, "🧭 Figuring out your game plan… <i>(~20 sec)</i>");
  const info = await assignInfo(env, aid);
  const mats = await materialsIndex(env, info.course);
  const raw = await gemini(env, [...await briefParts(env, info), { text: `Course files available (id: title): ${mats.map((m) => `${m.cmid}: ${m.name}`).join("; ") || "none"}
Help the student START this assignment himself. Do NOT give answers, code or final content.
Return ONLY JSON: {"gist": "what they're really asking, 1-2 lines", "steps": ["4-6 concrete steps in order, each max 20 words"], "revise": [{"cmid": id from the list or null, "why": "which concept to revise there, max 12 words"}], "time": "realistic time estimate", "trap": "one common mistake to avoid"}. Pick at most 3 files for "revise", only ids that exist in the list.` }], { json: true, system: STUDY_STYLE });
  let g;
  try { const s = raw.replace(/^```(?:json)?\s*|\s*```$/g, ""); g = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { g = null; }
  if (!g) return edit(env, chat, wait.message_id, "😵 Couldn't build a plan this time — tap again.", { inline_keyboard: [NAV] });
  const valid = (g.revise || []).filter((r) => mats.some((m) => String(m.cmid) === String(r.cmid))).slice(0, 3);
  let t = `🧭 <b>How to start: ${esc(info.name)}</b>\n\n🎯 ${esc(g.gist)}\n\n`;
  t += (g.steps || []).map((s, i) => `<b>${i + 1}.</b> ${esc(s)}`).join("\n");
  if (valid.length) t += `\n\n📚 <b>Revise first</b>\n${valid.map((r) => `• ${esc(mats.find((m) => String(m.cmid) === String(r.cmid)).name)} — ${esc(r.why)}`).join("\n")}`;
  t += `\n\n⏱ ${esc(g.time || "")}\n⚠️ ${esc(g.trap || "")}`;
  const rows = valid.map((r) => [{ text: `📖 ${mats.find((m) => String(m.cmid) === String(r.cmid)).name}`.slice(0, 55), callback_data: `sm:${r.cmid}!` }]);
  rows.push([{ text: "📄 Answer template (.docx)", callback_data: `at:${aid}` }], NAV);
  return edit(env, chat, wait.message_id, t, { inline_keyboard: rows });
}

// ================================================================ "Where do I start?" — overall study plan
async function startHere(env, chat) {
  const wait = await send(env, chat, "🧭 Looking at your deadlines, quizzes and course files… <i>(~20 sec)</i>");
  const [ev, mats] = await Promise.all([actionEvents(env, 14, 21), materialsIndex(env)]);
  const pending = ev.map((e) => `- ${e.type} "${e.name}" (${e.course}) ${e.overdue ? "OVERDUE" : `due in ${countdown(e.due)}`}`).join("\n") || "- nothing pending";
  const raw = await gemini(env, [{ text: `Today: ${fmtTime(Math.floor(Date.now() / 1000), true)} IST.
Pending on the LMS:
${pending}
Course files (id | course | title), most recent last per course:
${mats.map((m) => `${m.cmid} | ${m.course} | ${m.name}`).join("\n")}

Abhi asks: "Where should I start studying?" Build a focused plan for the next study session, prioritising overdue work, then the nearest deadlines/quizzes, then the course that seems furthest behind.
Return ONLY JSON: {"why": "1 line on the priority logic", "steps": [{"title": "max 8 words", "do": "what exactly to do, max 20 words", "minutes": 25, "cmid": id of the file to open or null}]}. 3-4 steps, only cmids from the list.` }], { json: true, system: STUDY_STYLE });
  let p;
  try { const s = raw.replace(/^```(?:json)?\s*|\s*```$/g, ""); p = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { p = null; }
  if (!p?.steps?.length) return edit(env, chat, wait.message_id, "😵 Couldn't build a plan right now — try again in a minute.", { inline_keyboard: [NAV] });
  const find = (id) => mats.find((m) => String(m.cmid) === String(id));
  let total = 0;
  const lines = p.steps.slice(0, 4).map((s, i) => {
    total += Number(s.minutes) || 0;
    const f = find(s.cmid);
    return `<b>${i + 1}. ${esc(s.title)}</b>  ⏱ ${Number(s.minutes) || 25} min\n   ${esc(s.do)}${f ? `\n   📖 <i>${esc(f.name)}</i>` : ""}`;
  });
  const rows = p.steps.slice(0, 4).filter((s) => find(s.cmid)).map((s, i) => [{ text: `▶️ ${i + 1}. ${find(s.cmid).name}`.slice(0, 55), callback_data: `sm:${s.cmid}!` }]);
  rows.push([{ text: "📋 Pending", callback_data: "v:pending!" }], NAV);
  return edit(env, chat, wait.message_id, `🧭 <b>Start here</b>  ·  ~${total} min session\n<i>${esc(p.why || "")}</i>\n\n${lines.join("\n\n")}\n\n<i>Tip: phone away, one step at a time. You got this 💪</i>`, { inline_keyboard: rows });
}

async function downloadMaterial(env, chat, cmid) {
  const m = await findMaterial(env, cmid);
  await tg(env, "sendChatAction", { chat_id: chat, action: "upload_document" }).catch(() => {});
  for (const f of m.files) {
    try { await tgSendFile(env, chat, await lmsFile(env, f.url), f.name, `${KIND(f.mime)} ${esc(m.name)} · ${esc(m.course)}`); }
    catch (e) { await send(env, chat, `⚠️ ${esc(f.name)}: ${esc(e.message)}`); }
  }
}

// -------------------------------------------------------------- Telegram
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

async function send(env, chat, html, extra = {}) {
  const chunks = splitMsg(html);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chat, text: chunks[i], parse_mode: "HTML", disable_web_page_preview: true, ...(i === chunks.length - 1 ? extra : {}) };
    try { last = await tg(env, "sendMessage", payload); }
    catch (e) { // HTML parse problem -> resend as plain text
      if (/parse|entities/i.test(e.message)) last = await tg(env, "sendMessage", { ...payload, parse_mode: undefined, text: chunks[i].replace(/<[^>]+>/g, "") });
      else throw e;
    }
  }
  return last;
}

async function edit(env, chat, mid, html, markup) {
  const p = { chat_id: chat, message_id: mid, text: html, parse_mode: "HTML", disable_web_page_preview: true };
  if (markup) p.reply_markup = markup;
  return tg(env, "editMessageText", p).catch((e) => (/not modified/.test(e.message) ? null : send(env, chat, html, markup ? { reply_markup: markup } : {})));
}

async function tgDownload(env, fileId) {
  const f = await tg(env, "getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error("Could not download the file from Telegram");
  return { bytes: await r.arrayBuffer(), path: f.file_path };
}

function splitMsg(text, max = 3900) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > max) { out.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur) out.push(cur);
  return out;
}

// --------------------------------------------------------------- helpers
function clean(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function mdToHtml(s) {
  return esc(s)
    .replace(/^#+\s*(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/gm, "$1<b>$2</b>")
    .replace(/^\s*[-*]\s+/gm, "• ");
}
function fmtSize(n) {
  if (!n) return "?";
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
const IST_MS = 330 * 60 * 1000;
function fmtTime(ts, withYear = false) {
  const d = new Date(ts * 1000 + IST_MS);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let h = d.getUTCHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ""}, ${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap}`;
}
function relTime(ts) {
  const s = ts - Date.now() / 1000;
  const a = Math.abs(s);
  const txt = a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 * 2 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return s < 0 ? `${txt} ago` : `in ${txt}`;
}
function endOfTodayIST() {
  const d = new Date(Date.now() + IST_MS);
  d.setUTCHours(23, 59, 59, 0);
  return Math.floor((d.getTime() - IST_MS) / 1000);
}

export const _test = { flatten, mdToHtml, fmtTime, relTime, endOfTodayIST, splitMsg, shortName, clean, handle, webhookSecret };
