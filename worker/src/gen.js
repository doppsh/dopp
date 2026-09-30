/* Generator (any OpenAI-compatible chat-completions API), paste parsing, and public dataset discovery.
   The generator writes words (names, keywords, synthetic states, paste splitting). Every judgement goes to the oracle (Jev) via jevDecide (never recorded). */
import { err, json, jevDecide, nouls, choiceOf, pool, EngineError } from "./lib.js";
import { checkDecide } from "./answer.js";
const errOf = e => { if (e instanceof EngineError) { try { return err(JSON.parse(e.text).error || e.message, e.status >= 500 ? 502 : e.status); } catch (_) { return err(e.text || e.message, 502); } } return err(e.message, e.status); };
import { projectByTenant, setsOf, ingest } from "./data.js";
import { compose } from "./synth.js";
import { isChunks, CH } from "./shape.js";
import { chargeGen } from "./ledger.js";

export const GEN_MISSING = "Writing requests needs a writer: set GEN_API_KEY (any OpenAI-compatible chat API; Gemini's works, and GEN_BASE_URL and GEN_MODEL pick another) and restart.";
export const hasGen = env => !!env.GEN_API_KEY;
export const noGen = () => err(GEN_MISSING, 503);
export const genModel = env => env.GEN_MODEL || "gemini-3.1-flash-lite";

// Pull the first JSON object/array out of a model reply (tolerates code fences and chatter around it).
export function looseJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  for (const [o, c] of [["{", "}"], ["[", "]"]]) { const a = t.indexOf(o), b = t.lastIndexOf(c); if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}
export async function generator(env, system, user, { max_tokens = 2000, temperature = 0.7, pid = null, note = null } = {}) {
  const base = (env.GEN_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");
  const call = rf => fetch(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.GEN_API_KEY },
    body: JSON.stringify({ model: genModel(env), max_tokens, temperature, messages: [{ role: "system", content: system + "\nReply with one strict JSON object and nothing else." }, { role: "user", content: user }], ...(rf ? { response_format: { type: "json_object" } } : {}) }) });
  let r = await call(true);
  if (r.status === 400 || r.status === 422) r = await call(false);   // provider without response_format support
  const t = await r.text();
  // out of credit or rate-limited on our side: say so in plain words (the caller is never charged for a call that didn't happen)
  if (r.status === 402 || (r.status === 429 && /RESOURCE_EXHAUSTED|quota|credit/i.test(t))) { console.log("generator out of credit: " + t.slice(0, 200)); throw Object.assign(new Error("The writer (" + genModel(env) + ") is out of credit or quota on GEN_API_KEY, so nothing was written. Top it up with that provider, or set another key, and try again."), { status: 503 }); }
  if (!r.ok) throw Object.assign(new Error("Generator returned " + r.status + ": " + t.slice(0, 300)), { status: 502 });
  let content, usage = null; try { const j = JSON.parse(t); content = j.choices[0].message.content; usage = j.usage; } catch (_) { content = t; }
  if (pid) await chargeGen(env, pid, usage, note);
  const out = looseJSON(content); if (!out || typeof out !== "object") throw Object.assign(new Error("Generator did not return JSON."), { status: 502 });
  return out;
}

// ---- naming: {name, description, tags[], keywords[]} from a question-set
export async function nameFromQuestions(env, questions, sample = null, pid = null) {
  const o = await generator(env, "You name machine-learning classification projects. Given the questions a classifier answers about each input text (and, when present, one real input), return {\"name\": \"2-4 word project name\", \"description\": \"one sentence: what texts come in and what gets decided\", \"tags\": [\"up to 5 short lowercase tags\"], \"keywords\": [\"up to 6 search phrases (1-3 words each) that would find public datasets of the same kind of input text on Hugging Face; name the subject matter (e.g. 'pii detection', 'customer support tickets'), never the mechanics (not 'token classification')\"]}.",
    JSON.stringify(sample ? { questions, one_real_input: clip(sample, 1500) } : questions), { max_tokens: 600, temperature: 0.3, pid, note: "naming" });
  const strs = (a, n) => (Array.isArray(a) ? a : []).filter(x => typeof x === "string" && x.trim()).map(x => x.trim().slice(0, 60)).slice(0, n);
  return { name: String(o.name || "").trim().slice(0, 60) || null, description: String(o.description || "").trim().slice(0, 300) || null, tags: strs(o.tags, 5), keywords: strs(o.keywords, 6) };
}
// Keywords without a generator: the most distinctive words in the question text.
const STOP = new Set("what which does this that with from have your about into there their they them then than when were will would could should is the and for are was not you how any all can our out its it's one two per each more most some such only also just like been being over under very much many other these those customer user message text main want wants question answer".split(" "));
export function keywordsFallback(questions, project = {}) {
  const words = {}; for (const w of ((/^(Default|Project \d+)$/.test(project.name || "") ? "" : project.name || "") + " " + (project.description || "")).toLowerCase().match(/[a-z]{4,}/g) || []) if (!STOP.has(w)) words[w] = 10; for (const [qid, q] of Object.entries(questions || {})) for (const w of (qid + " " + (q.instructions || q.question || "") + " " + Object.keys(Array.isArray(q.criteria) ? {} : q.criteria || {}).join(" ")).toLowerCase().match(/[a-z]{4,}/g) || []) if (!STOP.has(w)) words[w] = (words[w] || 0) + 1;
  return Object.entries(words).sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 4);
}

// ---- D1 lookups for a question-set
export async function questionsOf(env, tenant, schema) {
  const pr = await projectByTenant(env, tenant); const list = pr ? await setsOf(env, pr.id) : []; const s = list.find(x => x.id === schema) || (!schema && list[0]);
  return s ? { schema: s.id, questions: s.q || null, set: s } : null;
}
export async function anchorsOf(env, tenant, schema, n = 8, set = null) {
  const r = (await env.DB.prepare("SELECT state_json FROM examples WHERE schema_id = ? ORDER BY t DESC LIMIT ?").bind(schema, n).all()).results;
  const tf = set && set.plan && set.plan.seed_field;   // the field the plan identified as the main text, if any
  // no plan yet: an object's own words (its string fields) stand for it, not a long context around them (a house's devices)
  const words = st => { const w = Object.values(st).filter(v => typeof v === "string" && v.trim()); return w.length ? w.join(" · ") : st; };
  return r.map(x => { const st = JSON.parse(x.state_json); return tf && st && typeof st === "object" && typeof st[tf] === "string" ? st[tf] : st && typeof st === "object" && !Array.isArray(st) ? words(st) : st; }).filter(s => s !== undefined && s !== null && s !== "");
}
/** What the questions ask, in words the generator/oracle can use: chunk sets describe the one template question. */
const describe = set => isChunks(set) ? { [CH]: { ...set.q[CH], note: "This question is asked once per piece of the state (see the template's {text} slot); the answer classifies that piece." } } : set.q;
const clip = (s, n = 400) => { const t = typeof s === "string" ? s : JSON.stringify(s); return t.length > n ? t.slice(0, n) + "…" : t; };

// ---- ingest in batches of 50 (the labeller answers, D1 records); stops at the first error after some rows went in, throws if the first batch fails
export async function ingestAll(env, ws, tenant, schema, states, source, via, meta) {
  const pr = await projectByTenant(env, tenant); const set = pr && (await setsOf(env, pr.id)).find(x => x.id === schema);
  if (!set) throw Object.assign(new Error("unknown question-set"), { status: 404 });
  const plain = !isChunks(set) && states.every(s => typeof s === "string");
  // whole requests (objects already in the kind's shape) go in as they are; only text needs the writer to shape it
  const whole = !isChunks(set) && states.every(s => s && typeof s === "object" && !Array.isArray(s));
  if (!whole && (!plain || (set.plan && set.plan.state_kind !== "string"))) { const r = await seedInto(env, ws, tenant, schema, states.map(s => typeof s === "string" ? s : JSON.stringify(s)), source, via, meta); return { recorded: r.added, holdout: r.holdout, failed: r.failed, dropped: r.dropped, reasons: r.reasons, composed: r.composed, plan: r.plan }; }
  const out = { recorded: 0, holdout: 0, pending: 0, failed: [] };
  for (let o = 0; o < states.length; o += 50) {
    const batch = states.slice(o, o + 50);
    try {
      const r = await ingest(env, ws, pr, set, batch, source, via, meta || null);
      out.recorded += r.recorded || 0; out.holdout += r.holdout || 0; out.pending += r.pending || 0; for (const f of r.failed || []) out.failed.push({ ...f, i: (f.i || 0) + o });
    } catch (e) { if (!o) throw e; batch.forEach((_, i) => out.failed.push({ i: o + i, error: "ingest " + (e.status || 500) + ": " + String(e.text || e.message).slice(0, 200) })); break; }
  }
  return out;
}

// ---- generation: the generator writes states anchored on real ones, the oracle (Jev) gates "reads like the real examples", survivors are ingested
export async function generate(env, ws, tenant, b) {
  if (!hasGen(env)) return noGen();
  const pr = await projectByTenant(env, tenant); const set = pr && (await setsOf(env, pr.id)).find(x => x.id === b.schema); if (!set) return err("Unknown question-set for this project.", 404);
  try {
    const r = await compose(env, ws, pr, set, { count: Math.max(1, Math.min(50, +b.count || 10)), target: b.target || null, hint: b.prompt || null, source: "generated", via: "generated" });
    return json(r);
  } catch (e) { if (e.status) return errOf(e); throw e; }
}
/** The generator's plan for a set (what it would write, in words), or a corrected one. */
export async function planFor(env, ws, tenant, b) {
  if (!hasGen(env)) return noGen();
  const pr = await projectByTenant(env, tenant); const set = pr && (await setsOf(env, pr.id)).find(x => x.id === b.schema); if (!set) return err("Unknown question-set for this project.", 404);
  const { plan } = await import("./synth.js");
  try { return json(await plan(env, ws, pr, set, b.correction || null)); } catch (e) { if (e.status) return errOf(e); throw e; }
}
/** Raw texts (dataset rows, pasted lines) → examples in the set's format: direct when the state is a plain string with fixed questions, composed otherwise. */
export async function seedInto(env, ws, tenant, schema, texts, source, via, meta) {
  const pr = await projectByTenant(env, tenant); const set = pr && (await setsOf(env, pr.id)).find(x => x.id === schema); if (!set) throw Object.assign(new Error("unknown question-set"), { status: 404 });
  const out = { added: 0, dropped: { format: 0, realism: 0, duplicate: 0 }, reasons: [], holdout: 0, failed: [], composed: false, plan: null };
  for (let o = 0; o < texts.length; o += 40) {
    const r = await compose(env, ws, pr, set, { seeds: texts.slice(o, o + 40), source, via, meta: meta || null });
    out.added += r.added; for (const k of Object.keys(out.dropped)) out.dropped[k] += r.dropped[k] || 0; out.reasons.push(...r.reasons.filter(x => !out.reasons.includes(x)).slice(0, 3)); out.holdout += r.holdout; out.failed.push(...r.failed); out.composed = r.composed; out.plan = r.plan;
  }
  return out;
}

// ---- parse pasted text into states
export function parseCSV(text, delim) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === "") q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.length > 1 || row[0] !== "") rows.push(row); return rows;
}
function sniff(text) {
  const t = text.trim(); if (!t) return { rows: [], format: "lines" };
  if (t[0] === "[" || t[0] === "{") { try { let v = JSON.parse(t); if (!Array.isArray(v) && v && typeof v === "object") v = Object.values(v).find(Array.isArray) || [v]; return { rows: v, format: "json" }; } catch (_) {} }
  const lines = t.split(/\r?\n/).filter(l => l.trim());
  const js = lines.map(l => { try { return JSON.parse(l); } catch (_) { return undefined; } });
  if (js.filter(x => x !== undefined && typeof x === "object").length >= 0.8 * lines.length) return { rows: js.filter(x => x !== undefined), format: "jsonl" };
  for (const d of ["\t", ",", ";", "|"]) {
    if (!lines[0].includes(d)) continue;
    const rows = parseCSV(t, d); const w = rows[0].length;
    if (w >= 2 && rows.length >= 2 && rows.filter(r => r.length === w).length >= 0.8 * rows.length && rows[0].every(h => h.trim() && h.length < 60)) {
      const head = rows[0].map(h => h.trim()); return { rows: rows.slice(1).filter(r => r.length === w).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]]))), format: "csv" };
    }
  }
  const paras = t.split(/\r?\n\s*\r?\n/).map(s => s.trim()).filter(Boolean);   // blank-line separated multi-line blocks
  if (paras.length >= 2 && lines.length >= 2 * paras.length) return { rows: paras, format: "lines" };
  return { rows: lines.map(l => l.trim()), format: "lines" };
}
const avgLen = (rows, c) => rows.reduce((s, r) => s + String(r[c] ?? "").length, 0) / Math.max(1, rows.length);
export async function parse(env, ws, b, pid = null) {
  const text = String(b.text || "").slice(0, 2_000_000);
  if (b.hint) {   // let the generator split messy text (email dumps, chat logs) into separate inputs
    if (!hasGen(env)) return noGen();
    const o = await generator(env, "You split pasted text into the separate inputs it contains (one message, ticket, review or record each). Keep each input's original wording exactly; drop headers, separators and numbering.", "Return {\"states\": [strings]}.\n\n" + text.slice(0, 24000), { max_tokens: 8000, temperature: 0, pid, note: "split pasted text" });
    const states = (o.states || []).filter(s => typeof s === "string" && s.trim()); return json({ states, format: "hint", n: states.length });
  }
  const { rows, format } = sniff(text);
  const objs = rows.filter(r => r && typeof r === "object" && !Array.isArray(r));
  if (!objs.length) { const states = rows.map(r => typeof r === "string" ? r : JSON.stringify(r)).filter(s => s.trim()); return json({ states, format, n: states.length }); }
  const cols = [...new Set(objs.flatMap(Object.keys))].filter(c => objs.filter(r => typeof r[c] === "string" && r[c].trim()).length >= 0.8 * objs.length && avgLen(objs, c) >= 3 && objs.filter(r => /^[\d\s.:\/+-]*$/.test(String(r[c] ?? ""))).length < 0.8 * objs.length);   // text, not ids/dates/numbers
  let column = b.column && cols.includes(b.column) ? b.column : null, picked_by = column ? "you" : null;
  if (!column && cols.length === 1) { column = cols[0]; picked_by = "only text column"; }
  if (!column && cols.length > 1) {
    try {
      const a = await jevDecide(env, ws, objs.slice(0, 3), { column: { type: "choice", instructions: "These are the first rows of a file someone wants a classifier to read. Which column holds the main free text to classify (the message, ticket, review, post or document), not an id, date, category or label?", criteria: Object.fromEntries(cols.map(c => [c, null])) } });
      column = choiceOf(a.column); picked_by = "jev";
    } catch (e) { picked_by = "longest (jev unavailable: " + (e.status || e.message) + ")"; }
    if (!cols.includes(column)) { column = cols.slice().sort((x, y) => avgLen(objs, y) - avgLen(objs, x))[0]; picked_by = picked_by || "longest"; }
  }
  const states = column ? objs.map(r => r[column]).filter(s => typeof s === "string" && s.trim()) : objs;   // no text column: whole objects are the states
  return json({ states, format, ...(column ? { column } : {}), columns: cols, picked_by, n: states.length });
}

// First request on a new set: derive the model's description and dataset keywords from what the client really sends.
export async function describeFromTraffic(env, pr, set, state) {
  if (!hasGen(env) || JSON.parse(pr.keywords_json || "[]").length) return;
  const n = await nameFromQuestions(env, describe(set), state, pr.id);
  await env.DB.prepare("UPDATE projects SET description = COALESCE(description, ?), tags_json = ?, keywords_json = ? WHERE id = ? AND keywords_json = '[]'").bind(n.description, JSON.stringify(n.tags || []), JSON.stringify(n.keywords || []), pr.id).run();
}

// Auto-suggest: run Find for a set in the background and keep the result on the set (the Examples page shows it without asking).
export async function suggestFor(env, ws, pr, schema) {
  const r = await findDatasets(env, ws, pr, pr.tenant, schema, async n => { await env.DB.prepare("UPDATE projects SET keywords_json = ? WHERE id = ? AND keywords_json = '[]'").bind(JSON.stringify(n.keywords || []), pr.id).run(); }, null, "suggest");
  if (!r.ok) return; const out = await r.json();
  await env.DB.prepare("UPDATE question_sets SET suggestions_json = ? WHERE id = ?").bind(JSON.stringify({ t: Date.now(), datasets: out.slice(0, 5) }), schema).run();
}

// ---- public datasets (Hugging Face)
const HF = "https://huggingface.co/api/datasets", DS = "https://datasets-server.huggingface.co";
const FIND_CACHE = new Map();   // per isolate: `${tenant}|${schema}` → {t, out}
async function getJSON(u) { const r = await fetch(u, { headers: { accept: "application/json" } }); if (!r.ok) throw new Error(u.split("?")[0] + " → " + r.status); return r.json(); }
export async function rowsOf(dataset, offset = 0, length = 5, config, split) {
  const q = (c, s) => `${DS}/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(c)}&split=${encodeURIComponent(s)}&offset=${offset}&length=${length}`;
  if (config && split) return { ...(await getJSON(q(config, split))), config, split };
  try { return { ...(await getJSON(q("default", "train"))), config: "default", split: "train" }; } catch (_) {}
  const sp = (await getJSON(`${DS}/splits?dataset=${encodeURIComponent(dataset)}`)).splits || []; if (!sp.length) throw new Error("no splits");
  const s = sp.find(x => x.split === "train") || sp[0]; return { ...(await getJSON(q(s.config, s.split))), config: s.config, split: s.split };
}
// Text columns, best first: input-ish names (text, message, ticket, instruction…) beat output-ish ones (response, answer…), then longer beats shorter.
const IN = /^(text|body|message|content|ticket|review|query|question|instruction|input|utterance|prompt|comment|post|tweet|description|sentence|document)s?$|text|message|body|review/i, OUT = /response|answer|output|reply|label|summary|target|completion|category|intent/i;
const textCols = r => { const rows = (r.rows || []).map(x => x.row || {}); const rank = c => (IN.test(c) ? 2 : 0) - (OUT.test(c) ? 2 : 0);
  return (r.features || []).filter(f => f.type && /^(large_)?string$/.test(f.type.dtype || "")).map(f => f.name).filter(c => rows.some(x => typeof x[c] === "string") && avgLen(rows, c) >= 20)
    .sort((a, b) => rank(b) - rank(a) || avgLen(rows, b) - avgLen(rows, a)); };

export async function findDatasets(env, ws, project, tenant, schema, save, q, note = "decision") {
  const qs = await questionsOf(env, tenant, schema); if (!qs) return err("This project has no question-set yet. Declare questions first.", 404);
  const withPos = out => { const pos = (JSON.parse(project.settings_json || "{}").datasets) || {}; return out.map(d => ({ ...d, next_row: (pos[d.id] || {}).next || 0, used_rows: (pos[d.id] || {}).used || 0 })); };
  const key = tenant + "|" + qs.schema + "|" + (q || ""), hit = FIND_CACHE.get(key); if (hit && Date.now() - hit.t < 15 * 60e3) return json(withPos(hit.out));
  const questions = qs.questions ? describe(qs.set) : {};
  // a dataset named outright ("owner/name" or its Hugging Face address) is looked at as is; otherwise the words typed, else search
  // phrases for THIS kind of request (the route's own keywords come from its first request, which may be another kind entirely)
  const named = q && (String(q).match(/huggingface\.co\/datasets\/([\w.-]+\/[\w.-]+)/) || String(q).trim().match(/^([\w.-]+\/[\w.-]+)$/));
  let kws = named ? [] : q ? q.split(",").map(x => x.trim()).filter(Boolean).slice(0, 4) : [];
  if (!named && !kws.length && hasGen(env)) { try { const one = (await anchorsOf(env, tenant, qs.schema, 1, qs.set))[0]; kws = (await nameFromQuestions(env, questions, one || null, project.id)).keywords; } catch (_) {} }
  if (!named && !kws.length) kws = JSON.parse(project.keywords_json || "[]");
  if (!kws.length) kws = keywordsFallback(questions, project);
  if (!kws.length) return json([]);
  const found = new Map();
  if (named) { try { const d = await getJSON(`${HF}/${named[1]}`); found.set(d.id, d); } catch (e) { return err(`Couldn't open ${named[1]} on Hugging Face (${e.message.split(" → ").pop()}).`, 404); } }
  else for (const list of await pool(kws.slice(0, 4), 4, kw => getJSON(`${HF}?search=${encodeURIComponent(kw)}&limit=20`))) if (Array.isArray(list)) for (const d of list) if (!found.has(d.id) && !d.gated && !d.private && !d.disabled) found.set(d.id, d);
  const cands = [...found.values()].sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, 12);   // bounded: ≤3 fetches each keeps a find under the 50-subrequest floor
  const withRows = (await pool(cands, 6, async d => {
    const r = await rowsOf(d.id); const cols = textCols(r); if (!cols.length) return null;
    const rows = (r.rows || []).map(x => x.row); const sample = rows.map(x => x[cols[0]]).filter(s => typeof s === "string" && s.trim()).slice(0, 3).map(s => clip(s, 300));
    if (!sample.length) return null;
    return { id: d.id, name: d.id.split("/").pop(), url: "https://huggingface.co/datasets/" + d.id, rows: r.num_rows_total ?? null, description: (d.description || d.cardData?.pretty_name || "").slice(0, 300), sample, columns: cols, column: cols[0], config: r.config, split: r.split, downloads: d.downloads || 0 };
  })).filter((x, i, a) => x && !x.__error && a.findIndex(y => y && !y.__error && y.sample.join("|") === x.sample.join("|")) === i).slice(0, 8);   // mirrors of one dataset: keep the most downloaded
  if (!withRows.length) { FIND_CACHE.set(key, { t: Date.now(), out: [] }); return json([]); }
  const anchors = (await anchorsOf(env, tenant, qs.schema, 3, qs.set)).map(a => clip(a, 300));
  const chunks = []; for (let i = 0; i < withRows.length; i += 4) chunks.push(withRows.slice(i, i + 4));
  const qdesc = Object.entries(questions).map(([id, q]) => ({ id, question: q.instructions || q.question || "", options: Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria || {}) }));
  const scored = await pool(chunks, 3, async ch => {
    const state = { classifier_questions: qdesc, ...(anchors.length ? { real_inputs: anchors } : {}), datasets: Object.fromEntries(ch.map((d, i) => ["d" + (i + 1), { name: d.id, sample_texts: d.sample }])) };
    const q = {}; ch.forEach((d, i) => { const k = "d" + (i + 1);
      q[k + "_fit"] = { type: "noul", instructions: `Are dataset ${k}'s sample texts the same kind of input this classifier reads${anchors.length ? " (like the real inputs)" : ""}, so its questions make sense for them?` };
      for (const x of qdesc) q[k + "_" + x.id] = { type: "noul", instructions: `Could dataset ${k}'s texts help teach the answer to "${x.id}" (${x.question}; options ${x.options.join(", ")}), i.e. would different texts plausibly get different answers?` }; });
    const a = await checkDecide(env, ws, project, state, q, note);   // the route's checker (Jev unless its setup says otherwise)
    return ch.map((d, i) => { const k = "d" + (i + 1); return { ...d, fit: Math.round(nouls(a[k + "_fit"]) * 100) / 100, informs: qdesc.filter(x => nouls(a[k + "_" + x.id]) >= 0.5).map(x => x.id) }; });
  });
  const bad = scored.find(r => r && r.__error); if (bad && scored.every(r => r && r.__error)) throw bad.__error;
  const out = scored.filter(r => r && !r.__error).flat().map(d => ({ ...d, reason: `${d.fit >= 0.5 ? "Reads like" : "Doesn't read much like"} ${anchors.length ? "your examples" : "what these questions are about"}${d.informs.length ? "; could inform " + d.informs.join(", ") : ""}.` }))
    .sort((a, b) => b.fit - a.fit).slice(0, 8);
  FIND_CACHE.set(key, { t: Date.now(), out }); return json(withPos(out));
}

export async function useDataset(env, ws, tenant, b) {
  if (!b.dataset || !b.column) return err("dataset and column are required.");
  const qs = await questionsOf(env, tenant, b.schema); if (!qs) return err("Unknown question-set for this project.", 404);
  const count = Math.max(1, Math.min(500, +b.count || 50)); const states = []; let config = b.config, split = b.split;
  const start = Math.max(0, +b.offset || 0);   // "Use the next 100": the UI passes how many rows it already took from this dataset
  for (let off = start; states.length < count; off += 100) {
    let r; try { r = await rowsOf(b.dataset, off, 100, config, split); } catch (e) { if (!off) return err("Could not read rows from " + b.dataset + ": " + e.message, 502); break; }
    config = r.config; split = r.split;
    for (const x of r.rows || []) { const s = x.row && x.row[b.column]; if (typeof s === "string" && s.trim()) states.push(s.slice(0, 8000)); }
    if (!(r.rows || []).length || off + 100 >= (r.num_rows_total || 0)) break;
  }
  if (!states.length) return err("No text found in column " + b.column + ".", 400);
  const r = await ingestAll(env, ws, tenant, qs.schema, states.slice(0, count), "public", "hf:" + b.dataset, { dataset: b.dataset, config, split, column: b.column });
  const pulled = Math.min(count, states.length), pr = await projectByTenant(env, tenant);
  // where we are in this dataset, kept on the model so a refresh (or another person) continues from the same row
  const st = JSON.parse(pr.settings_json || "{}"); st.datasets = { ...(st.datasets || {}), [b.dataset]: { next: start + pulled, used: ((st.datasets || {})[b.dataset] || {}).used + pulled || pulled } };
  await env.DB.prepare("UPDATE projects SET settings_json = ? WHERE id = ?").bind(JSON.stringify(st), pr.id).run();
  return json({ ...r, schema: qs.schema, pulled, from_row: start, next_row: start + pulled });
}
