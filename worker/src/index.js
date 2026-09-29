// GU LMS Telegram bot — Cloudflare Worker (free plan)
// Live commands, AI chat (text + voice), and assignment submission from Telegram.
// Secrets (set automatically by the deploy workflow):
//   LMS_USERNAME, LMS_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY

const BASE = "https://gulms.galgotiasuniversity.org";
const UA = { "User-Agent": "Mozilla/5.0 (GU-LMS-Bot; personal assistant)" };
const GEMINI = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash";

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
  return u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
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

  const msg = update.message;
  if (msg.document || msg.photo) return onFile(msg, env);
  if (msg.voice || msg.audio) return onVoice(msg, env);
  const text = (msg.text || "").trim();
  if (!text) return;

  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;
  switch (cmd) {
    case "/start":
    case "/help": return send(env, chat, HELP);
    case "/pending": return send(env, chat, await pendingText(env, 60, "📋 <b>Everything pending</b>"));
    case "/today": return send(env, chat, await pendingText(env, 1, "📅 <b>Due today</b>"));
    case "/week": return send(env, chat, await pendingText(env, 7, "🗓 <b>Due this week</b>"));
    case "/grades": return send(env, chat, await gradesText(env));
    case "/courses": return send(env, chat, await coursesText(env));
    case "/cal": return send(env, chat, await calendarText(env));
    case "/status": return send(env, chat, await statusText(env));
    case null: return aiChat(env, chat, text);
    default: return send(env, chat, "Unknown command. Try /help — or just ask me in plain words.");
  }
}

const HELP = `🤖 <b>GU LMS assistant</b>

<b>Ask anything</b> — in English or Hinglish, text or 🎤 voice:
<i>"kal kya submit karna hai?"</i>, <i>"plan my week"</i>, <i>"which subject am I behind in?"</i>

<b>Commands</b>
/pending — everything not yet submitted
/today — due today
/week — due in the next 7 days
/grades — your marks + feedback
/courses — your courses
/cal — sync all deadlines to Google Calendar
/status — check the bot is healthy

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
async function actionEvents(env, fromDaysAgo, toDays) {
  const now = Math.floor(Date.now() / 1000);
  const r = await ws(env, "core_calendar_get_action_events_by_timesort", {
    timesortfrom: now - fromDaysAgo * 86400, timesortto: now + toDays * 86400, limitnum: 50,
  });
  return (r.events || [])
    .filter((e) => e.action?.actionable !== false)
    .map((e) => ({
      name: clean(e.activityname || e.name.replace(/ is due$| closes$| opens$/i, "")),
      label: clean(e.name), due: e.timesort, course: shortName(e.course?.fullname || ""),
      type: e.modulename, instance: e.instance, url: e.url, overdue: e.timesort < now,
    }));
}

// ------------------------------------------------------------- commands
async function pendingText(env, days, title) {
  let items;
  if (days === 1) {
    const end = endOfTodayIST();
    items = (await actionEvents(env, 14, 2)).filter((e) => e.due <= end);
  } else items = await actionEvents(env, 14, days);
  if (!items.length) return `${title}\n\nNothing! 🎉 Go touch grass.`;
  const overdue = items.filter((e) => e.overdue);
  const upcoming = items.filter((e) => !e.overdue);
  let out = `${title} (${items.length})\n`;
  if (overdue.length) out += `\n🔴 <b>Overdue</b>\n${overdue.map(fmtItem).join("\n")}\n`;
  if (upcoming.length) out += `\n${upcoming.map(fmtItem).join("\n")}`;
  return out;
}

function fmtItem(e) {
  const icon = { assign: "📝", quiz: "❓", forum: "💬" }[e.type] || "📌";
  return `${icon} <a href="${esc(e.url)}">${esc(e.name)}</a> — ${esc(e.course)}\n    ⏳ ${fmtTime(e.due)} <i>(${relTime(e.due)})</i>`;
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
      out += `• ${esc(clean(g.itemname))}: <b>${esc(g.gradeformatted)}${max}</b>`;
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
  const lines = ev.map((e) => `- ${e.overdue ? "[OVERDUE] " : ""}${e.type}: "${e.name}" (${e.course}) due ${fmtTime(e.due)} (${relTime(e.due)})`);
  return `Today is ${fmtTime(Math.floor(Date.now() / 1000), true)} (IST).
Enrolled courses: ${cs.map((c) => c.name).join("; ")}.
Pending items not yet submitted/attempted (${ev.length}):
${lines.join("\n") || "- none"}`;
}

const SYSTEM = `You are Abhi's personal study assistant inside a Telegram bot connected to his Galgotias University LMS (MCA, first semester).
Style: friendly peer, witty but brief, reply in the same language/mix he uses (English or Hinglish). Keep answers short and scannable for a phone screen.
Formatting: plain text only. Use "•" for bullets and *single asterisks* for bold. No markdown headings, no tables.
Use ONLY the LMS data provided for facts about deadlines; never invent assignments or dates. If something isn't in the data, say so and suggest the right command (/grades, /pending, /cal).
For academic work: help him understand, plan and check — but do not write graded assignment answers for him to submit.`;

async function aiChat(env, chat, text) {
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });
  const ctx = await lmsContext(env);
  const history = JSON.parse((await env.KV.get(`h:${chat}`)) || "[]");
  const reply = await gemini(env, [{ text: `${ctx}\n\nRecent chat:\n${history.join("\n") || "(none)"}\n\nAbhi: ${text}` }], { system: SYSTEM });
  await saveHistory(env, chat, history, text, reply);
  return send(env, chat, mdToHtml(reply));
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
  return send(env, chat, mdToHtml(reply));
}

async function geminiModel(env) {
  return env.GEMINI_MODEL || (await env.KV.get("gmodel")) || DEFAULT_MODEL;
}

async function gemini(env, parts, { system, maxTokens = 4096 } = {}, retried = false) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const model = await geminiModel(env);
  const body = { contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.5 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(`${GEMINI}/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (r.status === 404 && !retried) { await pickModel(env); return gemini(env, parts, { system, maxTokens }, true); }
  if (r.status === 429) throw new Error("AI is busy (free-tier rate limit). Try again in a minute.");
  const j = await r.json();
  if (!r.ok) throw new Error(`AI error: ${j.error?.message || r.status}`);
  const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
  if (!text) throw new Error("AI returned an empty answer — try rephrasing.");
  return text;
}

// If the default model is retired, pick the newest "flash" model available on the free key
async function pickModel(env) {
  const r = await fetch(`${GEMINI}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
  const j = await r.json();
  const flash = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/.test(m.name) && !/lite|image|tts|live|audio|preview|exp/.test(m.name))
    .map((m) => m.name.replace("models/", ""))
    .sort().reverse();
  if (flash[0]) await env.KV.put("gmodel", flash[0], { expirationTtl: 7 * 86400 });
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
  const [act, aid] = (cq.data || "").split(":");
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});

  if (act === "x") return edit(env, chat, mid, "❌ Cancelled. Nothing was uploaded.");
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
