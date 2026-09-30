/* D1 data layer, from the original Python proxy, with the same semantics: question-sets (schema ids), examples, corrections, readiness,
   traffic agreement, training rows, held-out labels, ingest, the examples list and corrections, and the model view (training runs on the engine). */
import { enc, engine, EngineError, pool, isKev, familyOf, labelledTrainer, baseReady, engineHasBase, trainGpu, localEngine, BASES, jevStatusText } from "./lib.js";
import { loadSetup, routeOf, groundOf, catchUp, storageKey, YOU } from "./setup.js";
import { answerCtx, ask, whyNot } from "./answer.js";
import { chargeGpu } from "./ledger.js";
import { webState } from "./files.js";
import { CH, shapeOf, isChunks, templateQuestions, defOf, qidsOf, chunkSpans } from "./shape.js";

export const MIN_PER_ANSWER = 20, MIN_TOTAL = 100, RETRAIN_EVERY = 100, AGREE_OVERALL = 0.95, AGREE_PER_ANSWER = 0.90, MIN_LIVE = 20, WINDOW = 500;
export const MAX_TRAIN_ROWS = 600, DOMINANT_CAP = 0.4, DOMINANT_CAP_CHUNK = 0.6, MIN_TRAIN_FILE = 20, MAX_INGEST = 50, HOLDOUT_PCT = 10, STALE_TRAINING_S = 2 * 3600;
export const SOURCES = ["traffic", "typed", "pasted", "public", "generated"], SKIP = "__skip__", EXCLUDE = "__all__";
export const secs = () => Date.now() / 1000;
const J = (s, d = null) => { if (s === null || s === undefined) return d; try { return JSON.parse(s); } catch (_) { return d; } };
const r3 = x => Math.round(x * 1000) / 1000;
const chunks = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
export const batch = async (env, stmts) => { const out = []; for (const c of chunks(stmts, 100)) out.push(...await env.DB.batch(c)); return out; };
// seeded PRNG (the Python used random.Random(0); same idea, not the same stream)
export const seeded = (a = 0) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// ---- identity: json.dumps(..., sort_keys=True) byte-for-byte, so ids match the ones the engine computed
export function pyDumps(v, ascii = true) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") { const s = JSON.stringify(v); return ascii ? s.replace(/[\u0080-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : s; }
  if (Array.isArray(v)) return "[" + v.map(x => pyDumps(x, ascii)).join(", ") + "]";
  return "{" + Object.keys(v).sort().map(k => pyDumps(k, ascii) + ": " + pyDumps(v[k], ascii)).join(", ") + "}";
}
export async function sha1(s) { const d = await crypto.subtle.digest("SHA-1", enc.encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
export const schemaId = async (tenant, questions) => tenant + "-" + (await sha1(pyDumps(Object.fromEntries(Object.keys(questions).map(q => [q, { type: questions[q].type ?? null, criteria: questions[q].criteria ?? null }]))))).slice(0, 10);
// chunk shapes are keyed by the shape, not by the literal chunk ids
/** Identity by structure only: question ids, types and option ids. An option's description is wording, like a question's
    instructions: apps put live state in it ("Kitchen lights (light, currently on)"), and that must not make a new kind. */
const optionIds = c => c == null ? null : Array.isArray(c) ? c : Object.keys(c).sort();
export const structureId = async (tenant, questions) => tenant + "-s" + (await sha1(pyDumps(Object.fromEntries(Object.keys(questions).map(q => [q, { type: questions[q].type ?? null, options: optionIds(questions[q].criteria) }]))))).slice(0, 9);
/** Both ids a request's kind may be stored under: [structure id, legacy id]. Kinds made before structure ids keep their legacy id. */
export async function kindIdsFor(tenant, questions) { const sh = shapeOf(questions); if (sh.kind === "chunks") { const id = await schemaIdFor(tenant, questions); return [id, id]; } return Promise.all([structureId(tenant, questions), schemaId(tenant, questions)]); }
export async function schemaIdFor(tenant, questions) { const sh = shapeOf(questions); return sh.kind === "chunks" ? tenant + "-" + (await sha1("chunks|" + sh.type + "|" + JSON.stringify(sh.criteria) + "|" + sh.template)).slice(0, 10) : schemaId(tenant, questions); }
export const isHoldout = async (state, source) => source !== "traffic" && parseInt((await sha1(pyDumps(state, false))).slice(0, 8), 16) % 100 < HOLDOUT_PCT;
export const sourceOf = r => r.source || (String(r.via || "").startsWith("playground") ? "typed" : "traffic");

// ---- answers
const argmax = p => { let b = null, bv = -Infinity; for (const [k, v] of Object.entries(p || {})) if (v > bv) { b = k; bv = v; } return b; };
export const answerOf = (q, a) => q.type === "choice" ? (a.choice ?? argmax(a.probabilities)) : q.type === "noul" ? (+a.noul >= 0.5 ? "true" : "false") : String(argmax(a.probabilities));
/** How sure a whole reply is: its least sure question. */
export const minConfOf = answers => { const v = Object.values(answers || {}); return v.length ? Math.min(...v.map(topP)) : 1; };
export const topP = a => { if (a && a.type === "noul") { const v = +(a.noul ?? 0.5); return Math.max(v, 1 - v); } const p = Object.values((a && a.probabilities) || {}); return p.length ? Math.max(...p) : 0; };
const crit = q => Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria || {});
export function oneHot(q, label) {
  if (q.type === "choice") return { type: "choice", choice: label, probabilities: Object.fromEntries(crit(q).map(k => [k, k === label ? 1 : 0])) };
  if (q.type === "noul") return { type: "noul", noul: ["true", "yes", "1"].includes(String(label).toLowerCase()) ? 1 : 0 };
  const i = parseInt(label); return { type: "score", score: i, probabilities: Object.fromEntries(crit(q).map((_, k) => [String(k), k === i ? 1 : 0])) };
}
export function distOf(q, a) {
  if (q.type === "choice") return crit(q).map(k => (a.probabilities || {})[k] ?? 0);
  if (q.type === "noul") return [1 - a.noul, +a.noul];
  return crit(q).map((_, i) => (a.probabilities || {})[String(i)] ?? 0);
}
export const optionsOf = q => q.type === "choice" ? crit(q) : q.type === "noul" ? ["true", "false"] : crit(q).map((_, i) => String(i));
// every option with its probability, most likely first (the top one alone hides how unsure an answer is)
export const distList = (q, a) => optionsOf(q).map((o, i) => [o, r3(distOf(q, a)[q.type === "noul" ? 1 - i : i] || 0)]).sort((x, y) => y[1] - x[1]);
export const summ = (q, ans) => Object.fromEntries(Object.keys(q).filter(k => ans && ans[k]).map(k => [k, { answer: answerOf(q[k], ans[k]), p: r3(topP(ans[k])), dist: distList(q[k], ans[k]) }]));

// ---- question-sets
export const projectByTenant = (env, tenant) => env.DB.prepare("SELECT * FROM projects WHERE tenant = ?").bind(tenant).first();
const setRow = r => r && { ...r, q: J(r.questions_json, {}), shape: J(r.shape_json, { kind: "fixed" }), plan: J(r.plan_json), suggestions: J(r.suggestions_json) };
export const upsertPlan = (env, sid, p) => env.DB.prepare("UPDATE question_sets SET plan_json = ? WHERE id = ?").bind(JSON.stringify(p), sid).run();
/** The most recent real requests of a set (traffic first), with their own questions. */
export async function examplesOfSet(env, set, n = 6) {
  const rows = (await env.DB.prepare("SELECT state_json, extra_json FROM examples WHERE schema_id = ? ORDER BY CASE source WHEN 'traffic' THEN 0 WHEN 'typed' THEN 1 ELSE 2 END, t DESC LIMIT ?").bind(set.id, n).all()).results;
  return rows.map(r => ({ state: J(r.state_json), questions: questionsOfRow(set, r) }));
}
export const setsOf = async (env, pid) => (await env.DB.prepare("SELECT * FROM question_sets WHERE project_id = ? ORDER BY COALESCE(first_seen, 1e12), id").bind(pid).all()).results.map(setRow);
export async function setOf(env, pr, sid) { return setRow(await env.DB.prepare("SELECT * FROM question_sets WHERE id = ? AND project_id = ?").bind(sid, pr.id).first()); }
/** The questions of one example: its own for chunk sets (stored on the row), the set's otherwise. */
export const questionsOfRow = (set, r) => isChunks(set) ? ((J(r.extra_json, {}) || {}).questions || {}) : set.q;
export function validQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) return "questions must be an object of question id to question.";
  for (const [qid, q] of Object.entries(questions)) {
    if (!q || typeof q !== "object" || !["choice", "noul", "score"].includes(q.type) || typeof q.instructions !== "string") return `question ${qid} needs type (choice|noul|score) and instructions`;
    if (q.type !== "noul" && crit(q).length < 2) return `question ${qid} needs at least two criteria`;
  }
  return null;
}
// Creates the set on first sight. Returns {id, q, created}. Wording changes (identity ignores wording) update the stored instructions.
export async function ensureSet(env, pr, questions, { declared = false } = {}) {
  const sh = shapeOf(questions), [sid, legacy] = await kindIdsFor(pr.tenant, questions), stored = sh.kind === "chunks" ? templateQuestions(sh) : questions;
  // the structure id wins once it exists; before that, a kind recorded under its legacy id (same wording) stays where it is
  if (sid !== legacy) { const have = (await env.DB.prepare("SELECT id FROM question_sets WHERE project_id = ? AND id IN (?, ?)").bind(pr.id, sid, legacy).all()).results.map(r => r.id);
    if (!have.includes(sid) && have.includes(legacy)) return { ...(await setOf(env, pr, legacy)), created: false };
    if (!have.includes(sid)) { const merged = await mergeWordings(env, pr, sid, stored, sh, declared); if (merged) return merged; } }
  const r = await env.DB.prepare("INSERT OR IGNORE INTO question_sets (id, project_id, questions_json, declared, shape_json) VALUES (?,?,?,?,?)").bind(sid, pr.id, JSON.stringify(stored), declared ? 1 : 0, JSON.stringify(sh)).run();
  const s = await setOf(env, pr, sid); return { ...s, created: !!r.meta.changes };
}
/** A new wording of a kind that was recorded before structure ids, under one legacy id per wording: make the structure id's kind
    and move those requests into it (line numbers shifted so each stays unique), keeping the busiest one's name, plan and suggestions.
    Returns the merged kind, or null when there is nothing to merge. */
async function mergeWordings(env, pr, sid, stored, sh, declared) {
  const all = (await env.DB.prepare("SELECT q.*, (SELECT COUNT(*) FROM examples e WHERE e.schema_id = q.id) n, (SELECT COALESCE(MAX(line), -1) FROM examples e WHERE e.schema_id = q.id) top FROM question_sets q WHERE q.project_id = ?").bind(pr.id).all()).results;
  const olds = [];
  for (const r of all) { const q = J(r.questions_json, {}); if (r.id === sid || J(r.shape_json, { kind: "fixed" }).kind === "chunks") continue; if (await structureId(pr.tenant, q) === sid) olds.push(r); }
  if (!olds.length) return null;
  olds.sort((a, b) => b.n - a.n); const lead = olds[0];
  const st = [env.DB.prepare("INSERT OR IGNORE INTO question_sets (id, project_id, questions_json, declared, shape_json, plan_json, suggestions_json, recipe_json, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(sid, pr.id, JSON.stringify(stored), declared || olds.some(r => r.declared) ? 1 : 0, JSON.stringify(sh), lead.plan_json ?? null, lead.suggestions_json ?? null, lead.recipe_json ?? null, Math.min(...olds.map(r => r.first_seen ?? 1e12)), Math.max(...olds.map(r => r.last_seen ?? 0)))];
  let off = 0; for (const r of olds) { st.push(env.DB.prepare("UPDATE examples SET schema_id = ?, line = line + ? WHERE schema_id = ? AND project_id = ?").bind(sid, off, r.id, pr.id)); off += r.top + 1; }
  await env.DB.batch(st);
  return { ...(await setOf(env, pr, sid)), created: false };
}
export async function noteWording(env, set, questions) {
  if (isChunks(set)) return;
  let changed = false; const q = { ...set.q };
  for (const [qid, x] of Object.entries(questions)) {
    if (q[qid] && typeof x.instructions === "string" && x.instructions !== q[qid].instructions) { q[qid] = { ...q[qid], instructions: x.instructions }; changed = true; }
    // option descriptions are wording too: keep the latest (same option ids, or it would be another kind)
    if (q[qid] && x.criteria && !Array.isArray(x.criteria) && typeof x.criteria === "object" && JSON.stringify(x.criteria) !== JSON.stringify(q[qid].criteria)
        && JSON.stringify(optionIds(x.criteria)) === JSON.stringify(optionIds(q[qid].criteria))) { q[qid] = { ...q[qid], criteria: x.criteria }; changed = true; }
  }
  if (changed) await env.DB.prepare("UPDATE question_sets SET questions_json = ? WHERE id = ?").bind(JSON.stringify(q), set.id).run();
}

// ---- recording: line = per-set counter, allocated inside the insert; the id is <set>:<line> unless r.id is given
// r.route / r.oracle: the route the request went through and that route's oracle; the grounded answer is the first of it that answered
export const recordStmt = (env, pr, sid, r) => { const [gby, g] = r.oracle ? groundOf(r.oracle, r.answers, pr.id) : [null, null];
  return env.DB.prepare("INSERT INTO examples (id, project_id, schema_id, line, t, state_json, source, via, holdout, answers_json, served, ms_json, meta_json, extra_json, route, grounded_json, grounded_by) SELECT COALESCE(?16, ?1 || ':' || n), ?2, ?1, n, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15 FROM (SELECT COALESCE(MAX(line), -1) + 1 AS n FROM examples WHERE schema_id = ?1) RETURNING line")
  .bind(sid, pr.id, r.t ?? secs(), JSON.stringify(r.state), r.source, r.via ?? null, r.holdout ? 1 : 0, JSON.stringify(r.answers || {}), r.served ?? null, r.ms ? JSON.stringify(r.ms) : null, r.meta ? JSON.stringify(r.meta) : null, r.extra ? JSON.stringify(r.extra) : null, r.route ?? null, g ? JSON.stringify(g) : null, gby, r.id ?? null); };
const touchStmt = (env, sid, t) => env.DB.prepare("UPDATE question_sets SET first_seen = COALESCE(first_seen, ?2), last_seen = MAX(COALESCE(last_seen, 0), ?2) WHERE id = ?1").bind(sid, t);
export async function record(env, pr, sid, r) {
  r = { ...r, t: r.t ?? secs(), holdout: await isHoldout(r.state, r.source) };
  const [res] = await env.DB.batch([recordStmt(env, pr, sid, r), touchStmt(env, sid, r.t)]);
  const line = res.results[0].line; return { line, holdout: r.holdout, id: r.id || sid + ":" + line };
}
// An id made before the request is saved (the proxy replies first, then saves): "<set>:r<hex>", so it never meets a "<set>:<line>" id
export const newExampleId = sid => sid + ":r" + [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, "0")).join("");
// shadow targets finish after the response: merge their answers/ms into the row
// (a late answer from the route's oracle becomes the grounded one when nothing earlier in its oracle list answered)
export async function addShadow(env, id, answers, ms, oracle = null, pid = null) {
  await env.DB.prepare("UPDATE examples SET answers_json = json_patch(answers_json, ?), ms_json = json_patch(COALESCE(ms_json, '{}'), ?) WHERE id = ?").bind(JSON.stringify(answers), JSON.stringify(ms), id).run();
  if (!oracle) return;
  const r = await env.DB.prepare("SELECT answers_json FROM examples WHERE id = ?").bind(id).first(); if (!r) return;
  const [by, g] = groundOf(oracle, J(r.answers_json, {}), pid);
  await env.DB.prepare("UPDATE examples SET grounded_json = ?, grounded_by = ? WHERE id = ? AND grounded_pinned = 0").bind(g ? JSON.stringify(g) : null, by, id).run();
}

// ---- ingest. Two entry points, one labeller:
//   ingest(states)         fixed-question sets: each state becomes {state, questions: set.q}
//   ingestRequests(reqs)   whole requests in the set's own format (what synth.compose produces, or what a client sends)
const dupKey = st => typeof st === "string" ? st : JSON.stringify(st);
// Who answers an added request: its route's oracle, first one that can answer now. When you are the labeller, the route's own
// answerers answer it instead, so there is something to confirm or fix; their answer is kept but isn't the label (groundOf skips
// anyone not in the oracle). → {ctx, route, who: [answerer ids]}
async function labellers(env, ws, pr, x) {
  const S = (await loadSetup(env, pr)).setup, route = routeOf(S, x), ctx = await answerCtx(env, pr, ws, S);
  const ok = id => !whyNot(ctx, id), who = route.oracle.filter(ok);
  const asks = route.steps.flatMap(st => st.split ? Object.keys(st.split) : [st.ask]).filter(id => ok(id) && !route.oracle.includes(id));
  return { ctx, route, who: who.length ? who : route.oracle.includes(YOU) ? asks : [] };
}
const labelErr = (id, r) => id === "jev" ? `${jevStatusText(r.code)} ${String(r.raw || "").slice(0, 200)}` : `${id} returned HTTP ${r.code}: ${String(r.raw || "").slice(0, 200)}`;
async function labelOne(L, body) {
  let last = "nobody who labels these requests can answer right now";
  for (const id of L.who) { const r = await ask(L.ctx, id, body, "label"); if (r.ok) return { by: storageKey(id, L.ctx.pr.id), answers: r.answers, usage: r.resp.usage, ms: r.ms }; last = labelErr(id, r); }
  return { error: last };
}
export async function ingestRequests(env, ws, pr, set, reqs, source, via, meta) {
  if (!Array.isArray(reqs) || reqs.length < 1 || reqs.length > MAX_INGEST) throw Object.assign(new Error(`requests: 1..${MAX_INGEST} per call`), { status: 400 });
  if (!SOURCES.includes(source) || source === "traffic") throw Object.assign(new Error("source must be one of pasted, public, generated, typed"), { status: 400 });
  const L = await labellers(env, ws, pr, { schema: set.id, via, source });
  // the same state twice teaches nothing and skews balance
  const have = new Set((await env.DB.prepare("SELECT state_json FROM examples WHERE schema_id = ?").bind(set.id).all()).results.map(r => dupKey(J(r.state_json))));
  const before = reqs.length; reqs = reqs.filter(r => !have.has(dupKey(r.state))); const skipped = before - reqs.length;
  if (!reqs.length) return { recorded: 0, holdout: 0, failed: [], ids: [], skipped };
  const res = await pool(reqs.map((r, i) => ({ i, ...r })), 8, async (rq) => {
    const got = await labelOne(L, { model: "jev-latest", state: rq.state, questions: rq.questions });
    if (got.error) return { i: rq.i, error: got.error };
    return { i: rq.i, st: rq.state, questions: rq.questions, ...got, t: secs(), holdout: await isHoldout(rq.state, source) };
  });
  const got = res.map((r, i) => r && r.__error ? { i, error: "labelling failed: " + String(r.__error.message || r.__error).slice(0, 300) } : r);
  const ok = got.filter(r => r.answers), failed = got.filter(r => r.error);
  // an example nobody could label right now is kept, unlabeled, and can be labeled later ("waiting for a label"); nothing added is thrown away
  // with you as the labeller, a request nobody answered is simply waiting for your label, and is held out (or not) now, like any other
  const mine = L.route.oracle.includes(YOU);
  const pending = await Promise.all(failed.map(async f => ({ ...reqs[f.i], error: mine ? "waiting for your label" : f.error, holdout: mine ? await isHoldout(reqs[f.i].state, source) : false }))), rt = { route: L.route.id, oracle: L.route.oracle };
  const stmts = [...ok.map(r => recordStmt(env, pr, set.id, { t: r.t, state: r.st, source, via, holdout: r.holdout, answers: { [r.by]: r.answers }, served: r.by, ms: { [r.by]: r.ms }, meta, ...rt, extra: { ...(r.usage ? { usage: r.usage } : {}), ...(isChunks(set) ? { questions: r.questions } : {}) } })),
    ...pending.map(r => recordStmt(env, pr, set.id, { t: secs(), state: r.state, source, via, holdout: r.holdout, answers: {}, served: null, meta, ...rt, extra: { pending_label: r.error.slice(0, 200), ...(isChunks(set) ? { questions: r.questions } : {}) } })),
    ...(ok.length || pending.length ? [touchStmt(env, set.id, secs())] : [])];
  const out = stmts.length ? await batch(env, stmts) : [];
  const ids = ok.map((_, k) => set.id + ":" + out[k].results[0].line);
  const idByIndex = Object.fromEntries(ok.map((r, k) => [r.i, ids[k]]));   // which recorded row each input request became
  return { recorded: ok.length, holdout: ok.filter(r => r.holdout).length + pending.filter(r => r.holdout).length, failed: mine ? [] : failed, pending: pending.length, ids, idByIndex, skipped };
}
/** Label examples that are waiting for a label (nobody could label them when they were added). ≤50 per call. → {labeled, still_pending, failed} */
export async function labelPending(env, ws, pr, schema) {
  const w = schema ? "AND schema_id = ?" : "", b = schema ? [pr.id, schema] : [pr.id];
  const rows = (await env.DB.prepare(`SELECT id, schema_id, via, source, state_json, extra_json FROM examples WHERE project_id = ? ${w} AND json_extract(extra_json, '$.pending_label') IS NOT NULL ORDER BY t LIMIT 50`).bind(...b).all()).results;
  if (!rows.length) return { labeled: 0, still_pending: 0, failed: [] };
  const sets = Object.fromEntries((await setsOf(env, pr.id)).map(s => [s.id, s])), Ls = {};
  const res = await pool(rows, 6, async r => {
    const set = sets[r.schema_id]; const st = J(r.state_json), qs = questionsOfRow(set, r), x = { schema: r.schema_id, via: r.via, source: r.source };
    const L = await (Ls[JSON.stringify(x)] || (Ls[JSON.stringify(x)] = labellers(env, ws, pr, x)));
    const got = await labelOne(L, { model: "jev-latest", state: st, questions: qs });
    if (got.error) return { id: r.id, error: got.error };
    const extra = J(r.extra_json, {}) || {}; delete extra.pending_label; if (got.usage) extra.usage = got.usage;
    const [gby, g] = groundOf(L.route.oracle, { [got.by]: got.answers }, pr.id);   // the label only when a labeller answered
    await env.DB.prepare("UPDATE examples SET answers_json = json_patch(answers_json, ?), served = ?, ms_json = json_patch(COALESCE(ms_json, '{}'), ?), extra_json = ?, holdout = ?, route = ?, grounded_json = ?, grounded_by = ? WHERE id = ?")
      .bind(JSON.stringify({ [got.by]: got.answers }), got.by, JSON.stringify({ [got.by]: got.ms }), JSON.stringify(extra), (await isHoldout(st, "generated")) ? 1 : 0, L.route.id, g ? JSON.stringify(g) : null, gby, r.id).run();
    return { id: r.id };
  });
  const got = res.map(r => r && r.__error ? { error: String(r.__error.message || r.__error) } : r);
  const failed = got.filter(r => r.error); const left = (await env.DB.prepare(`SELECT COUNT(*) n FROM examples WHERE project_id = ? ${w} AND json_extract(extra_json, '$.pending_label') IS NOT NULL`).bind(...b).first()).n;
  return { labeled: got.length - failed.length, still_pending: left, failed: failed.slice(0, 3) };
}
export async function ingest(env, ws, pr, set, states, source, via, meta) {
  if (isChunks(set)) throw Object.assign(new Error("This model's questions depend on the state, so new examples have to be written in your request format. Use Generate (or Find / Paste, which go through the same step)."), { status: 400 });
  if (!Array.isArray(states) || states.length < 1 || states.length > MAX_INGEST) throw Object.assign(new Error(`states: 1..${MAX_INGEST} per request`), { status: 400 });
  return ingestRequests(env, ws, pr, set, states.map(st => ({ state: st, questions: set.q })), source, via, meta);
}

// ---- tallies over a project: per set counts, sources, vias, labelled answers, traffic pairs (one D1 round trip)
// the grounded answer of each request (see setup.js: its route's oracle, first that answered); rows from before setups are caught up on read
const GR = "grounded_json", MOD = "json_extract(answers_json, '$.model')";
// A request has a label when its route's labeller answered it (grounded) or a person fixed an answer (a correction). With "you"
// as the labeller (the default), your fixes are the only labels.
export const LABELLED = (a = "") => `(${a}${GR} IS NOT NULL OR ${a}id IN (SELECT example_id FROM corrections WHERE label_json IS NOT NULL))`;
/** The model's setup in force, after every request has its route and grounded answer. */
export async function freshSetup(env, pr) { const s = await loadSetup(env, pr); await catchUp(env, pr, s.setup); return s.setup; }
export async function tally(env, pr) {
  const S = await freshSetup(env, pr);
  const [sets, corr, agg, src, via, lab, pairs] = await Promise.all([setsOf(env, pr.id), correctionsOf(env, pr.id), ...(await env.DB.batch([
    env.DB.prepare("SELECT schema_id, COUNT(*) n, MIN(t) first, MAX(t) last, SUM(holdout) ho FROM examples WHERE project_id = ? GROUP BY schema_id").bind(pr.id),
    env.DB.prepare("SELECT schema_id, source, COUNT(*) n FROM examples WHERE project_id = ? GROUP BY schema_id, source").bind(pr.id),
    env.DB.prepare("SELECT schema_id, via, COUNT(*) n FROM examples WHERE project_id = ? AND via IS NOT NULL GROUP BY schema_id, via").bind(pr.id),
    env.DB.prepare(`SELECT id, schema_id, ${GR} jev, json_extract(extra_json, '$.questions') qs FROM examples WHERE project_id = ? AND holdout = 0 AND ${LABELLED()}`).bind(pr.id),
    env.DB.prepare(`SELECT schema_id, t, extra_json, ${GR} jev, ${MOD} model FROM examples WHERE project_id = ? AND source = 'traffic' AND ${GR} IS NOT NULL AND ${MOD} IS NOT NULL ORDER BY t`).bind(pr.id)])).map(r => r.results)]);
  const by = Object.fromEntries(sets.map(s => [s.id, { set: s, n: 0, first: null, last: null, holdout: 0, sources: {}, via: {}, labelled: 0, counts: Object.fromEntries(Object.keys(s.q).map(k => [k, {}])), pairs: [] }]));
  for (const r of agg) if (by[r.schema_id]) Object.assign(by[r.schema_id], { n: r.n, first: r.first, last: r.last, holdout: r.ho || 0 });
  for (const r of src) if (by[r.schema_id]) by[r.schema_id].sources[r.source] = r.n;
  for (const r of via) if (by[r.schema_id]) by[r.schema_id].via[r.via] = r.n;
  for (const r of lab) { const x = by[r.schema_id]; if (!x) continue; const j = applied(qOf(x.set, { questions: J(r.qs, null), jev: J(r.jev, {}) }), J(r.jev, {}), corr[r.id] || {}); if (!j) continue; x.labelled++;
    if (isChunks(x.set)) { x.chunks = (x.chunks || 0) + Object.keys(j).length; for (const a0 of Object.values(j)) { const a = answerOf(x.set.q[CH], a0); x.counts[CH][a] = (x.counts[CH][a] || 0) + 1; } }
    else for (const [qid, q] of Object.entries(x.set.q)) if (j[qid]) { const a = answerOf(q, j[qid]); x.counts[qid][a] = (x.counts[qid][a] || 0) + 1; } }
  for (const r of pairs) { const x = by[r.schema_id]; if (x) x.pairs.push({ t: r.t, v: (J(r.extra_json, {}) || {}).v ?? null, jev: J(r.jev, {}), local: J(r.model, {}) }); }
  for (const x of Object.values(by)) { x.pairs = x.pairs.slice(-WINDOW); x.agreement = agreement(x.set.q, x.pairs); }
  return { sets, by, S };
}
export function agreement(q, pairs) {
  if (!pairs.length) return { n: 0 };
  const per = {}, byv = {}; let agree = 0, tot = 0;
  const chunky = q[CH] && Object.keys(q).length === 1;
  for (const p of pairs) for (const [qid, qq] of (chunky ? Object.keys(p.jev).map(k => [k, q[CH]]) : Object.entries(q))) {
    if (!p.jev[qid] || !p.local[qid]) continue;
    const a = answerOf(qq, p.jev[qid]), b = answerOf(qq, p.local[qid]), k = qid + "=" + a, d = per[k] || (per[k] = [0, 0]), bv = byv[p.v] || (byv[p.v] = [0, 0]);
    d[1]++; d[0] += a === b; bv[1]++; bv[0] += a === b; tot++; agree += a === b;
  }
  const rows = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { n: v[1], agree: r3(v[0] / v[1]) }]));
  const overall = tot ? r3(agree / tot) : null, nq = Math.max(1, Object.keys(q).length);
  const versions = Object.fromEntries(Object.entries(byv).filter(([, c]) => c[1]).sort((a, b) => +a[0] - +b[0]).map(([v, c]) => ["v" + v, { n: Math.floor(c[1] / nq), agree: r3(c[0] / c[1]) }]));
  const ok = tot >= MIN_LIVE && overall !== null && overall >= AGREE_OVERALL && Object.values(rows).every(v => v.n < MIN_LIVE || v.agree >= AGREE_PER_ANSWER);
  return { n: pairs.length, overall, per_answer: rows, by_version: versions, ready_to_switch: ok };
}
export function mergeAgreement(ags) {
  const per = {}; let n = 0;
  for (const a of ags) { n += a.n || 0; for (const [k, v] of Object.entries(a.per_answer || {})) { const d = per[k] || (per[k] = [0, 0]); d[0] += v.agree * v.n; d[1] += v.n; } }
  const tot = Object.values(per).reduce((s, v) => s + v[1], 0), overall = tot ? r3(Object.values(per).reduce((s, v) => s + v[0], 0) / tot) : null;
  const rows = Object.fromEntries(Object.entries(per).filter(([, v]) => v[1]).map(([k, v]) => [k, { n: v[1], agree: r3(v[0] / v[1]) }]));
  const ok = tot >= MIN_LIVE && overall !== null && overall >= AGREE_OVERALL && Object.values(rows).every(v => v.n < MIN_LIVE || v.agree >= AGREE_PER_ANSWER);
  return { n, overall, per_answer: rows, ready_to_switch: ok };
}
export function readinessOf(x) {
  const waiting = [];
  for (const [qid, cc] of Object.entries(x.counts)) for (const [a, k] of Object.entries(cc)) if (k < MIN_PER_ANSWER) waiting.push(`${MIN_PER_ANSWER - k} more labelled ${qid}=${a}`);
  if (x.n < MIN_TOTAL) waiting.push(`${MIN_TOTAL - x.n} more calls in total`);
  return { calls: x.n, labelled: x.labelled, counts: x.counts, waiting, ready: !waiting.length };
}

/** The engine's held-out agreement counts only the answers it gave; a held-out label it gave no answer for is a miss.
    `sent` is what was written down when training started: how many held-out labels went out, and which answers had none. */
function heldOut(a, sent) {
  if (!sent || !(sent.asked > 0)) return a;
  const answered = +a.n || 0, asked = Math.max(sent.asked, answered), agree = (a.overall ?? 0) * answered;
  return { ...a, n: asked, answered, overall: asked ? Math.round(agree / asked * 1000) / 1000 : null, ...(sent.missing_answers && sent.missing_answers.length ? { missing_answers: sent.missing_answers } : {}) };
}
// ---- models: rows in D1, training on the engine. The current model = the highest ready version.
export const modelsOf = async (env, pid) => (await env.DB.prepare("SELECT * FROM models WHERE project_id = ? ORDER BY version").bind(pid).all()).results;
export const currentVersion = ms => Math.max(0, ...ms.filter(m => m.status === "ready").map(m => m.version));
// A training row polls the engine until it's done (or presumed lost after two hours).
export async function pollTraining(env, pr, ms) {
  for (const m of ms.filter(m => m.status === "training")) {
    let st = null; try { st = await engine(env, "/train/" + encodeURIComponent(m.job), {}, m.base); } catch (e) { if (!(e instanceof EngineError)) throw e; if (e.status === 404) st = { status: "failed", error: "the engine lost this training job" }; }
    if (!st || st.status === "running") { if (secs() - (m.t || 0) > STALE_TRAINING_S) st = { status: "failed", error: "a training run was lost; train again" }; else { m.log = (st && st.log) || null; continue; } }
    if (st.status === "done" || st.status === "failed") await chargeGpu(env, pr.id, trainGpu(env, m.base), Math.max(60, secs() - (m.t || secs())), "v" + m.version + (st.status === "failed" ? " (failed)" : ""));
    if (st.status === "done") Object.assign(m, { status: "ready", trained_rows: st.trained_rows ?? m.trained_rows, t: secs(), holdout_agreement_json: st.holdout_agreement ? JSON.stringify({ ...heldOut(st.holdout_agreement, J(m.holdout_agreement_json)), t: secs() }) : null, error: null });
    else if (st.status === "failed") Object.assign(m, { status: "failed", error: String(st.error || "training failed").slice(0, 1000) });
    else continue;
    await env.DB.prepare("UPDATE models SET status = ?, trained_rows = ?, t = ?, holdout_agreement_json = ?, error = ? WHERE project_id = ? AND version = ?").bind(m.status, m.trained_rows, m.t, m.holdout_agreement_json, m.error, pr.id, m.version).run();
  }
  return ms;
}
export async function modelView(env, pr, T) {
  T = T || await tally(env, pr); const ms = await pollTraining(env, pr, await modelsOf(env, pr.id));
  const xs = Object.values(T.by).filter(x => x.n > 0 || x.set.declared), traffic = mergeAgreement(xs.map(x => x.agreement)), have = new Map();   // sets nobody declared and nothing hit aren't gaps
  for (const x of xs) for (const [qid, q] of Object.entries(x.set.q)) for (const a of optionsOf(q)) { const k = (isChunks(x.set) ? "chunk" : qid) + "\u0000" + a; have.set(k, (have.get(k) || 0) + ((x.counts[qid] || {})[a] || 0)); }
  const gaps = [...have].filter(([, k]) => k < MIN_PER_ANSWER).map(([k, n]) => { const [qid, answer] = k.split("\u0000"); return { qid, answer, have: n, need: MIN_PER_ANSWER }; });
  const calls = xs.reduce((s, x) => s + x.labelled, 0), ready = ms.filter(m => m.status === "ready"), cur = ready[ready.length - 1], training = ms.find(m => m.status === "training"), last = ms[ms.length - 1];
  const versions = ready.map(m => ({ version: m.version, plan: m.plan || "main", base: m.base || "laya", trained_rows: m.trained_rows, trained_on: m.trained_on || 0, t: m.t, ...webState(m), cohort: m.cohort_json ? J(m.cohort_json) : null, ...(m.holdout_agreement_json ? { holdout_agreement: J(m.holdout_agreement_json) } : {}) }));
  const status = training ? "training" : cur ? (traffic.ready_to_switch ? "ready" : "shadow") : "collecting";
  return { group: "default", version: cur ? cur.version : 0, base: cur ? cur.base || "laya" : null, bases: BASES, status, trained_rows: cur ? cur.trained_rows : null, trained_on: cur ? cur.trained_on || 0 : 0,
    last_error: last && last.status === "failed" ? last.error : null, train_started: training ? training.t : null, train_log: training ? training.log || null : null, versions, question_sets: T.sets.map(s => s.id),
    agreement_traffic: traffic, agreement_examples: versions.length ? versions[versions.length - 1].holdout_agreement || null : null,
    readiness: { calls, gaps, ready: calls >= MIN_TOTAL && !gaps.length },
    auto: T.S ? autoPlans(T.S, ms, Object.values(T.by).reduce((s, x) => s + x.labelled, 0), T, env) : [] };
}

// ---- what a training run will take. Everything trains on an H100 ($3.95/h). Kev 0.8B measured 1.3 s per request-epoch;
// Laya measured 0.173 s per sequence-epoch at ~2.4k tokens on an A10G, assumed 3× faster on the H100 until measured (LAYA_H100_SPEEDUP).
// Plus ~2 min of start/save/eval. Shown with the credits margin.
export async function trainEstimate(env, pr, base = "laya", epochs = 2, cohort = null, sel = null) {
  // the same rows and balancing the run itself would use, so the button says what actually trains
  let requests = 0, sequences = 0, tokens = 0, holdout = 0, breakdown = null;
  try { const d = await startTraining(env, pr, base, false, epochs, true, cohort, sel ? sel.plan : null, sel ? sel.keep : null); requests = d.requests; sequences = d.sequences; tokens = d.tokens; holdout = d.holdout; breakdown = d.breakdown; } catch (e) { if (e.status !== 404) throw e; }
  const avgTok = sequences ? tokens / sequences : 600;
  // GLiNER: measured once on an A10G (signup-gate v3, 49 requests, ~1 min); per-request rates are a guess until more runs land
  // Tiny on this machine's CPU (tiny_local.py) picks its own epochs: measured 0.027 s per request-epoch on an M-series laptop
  const tinyEpochs = requests < 300 ? 30 : requests < 1000 ? 15 : 6;
  const fam = familyOf(base), secs_ = fam === "tiny" && localEngine(env, base) ? requests * tinyEpochs * 0.03 + 30 : fam === "tiny" ? requests * epochs * 0.02 + 90 : fam === "kev" ? requests * epochs * 1.3 * (base === "kev-4b" ? 4 : 1) + 120 : fam === "gliner" ? requests * epochs * (base === "gliner-decide" ? 0.21 : 0.085) + 150 : sequences * epochs * (0.173 / (+(env.LAYA_H100_SPEEDUP) || 3)) * Math.max(0.3, avgTok / 2400) + 120;
  const gpu = trainGpu(env, base), rate = ({ H100: 3.95, A10G: 1.10, T4: 0.59, CPU: 0 })[gpu] * (+(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1));   // same margin the Usage page shows
  return { base, epochs, cohort, requests, sequences, holdout, breakdown, avg_tokens: Math.round(avgTok), minutes: Math.max(2, Math.round(secs_ / 60)), cost: Math.round((secs_ / 3600) * rate * 100) / 100, gpu, ...(fam === "gliner" || fam === "tiny" ? { estimate: "a guess until more runs are measured" } : {}), ready: baseReady(env, base) };
}

// ---- corrections
export async function correctionsOf(env, pid) {
  const rows = (await env.DB.prepare("SELECT c.* FROM corrections c JOIN examples e ON e.id = c.example_id WHERE e.project_id = ?").bind(pid).all()).results; const out = {};
  for (const c of rows) (out[c.example_id] || (out[c.example_id] = {}))[c.qid] = { label: c.label_json === null ? null : J(c.label_json), by: c.by, t: c.t };
  return out;
}
// Oracle answers with corrections applied: null = excluded / nothing left; label null = removed (the labeller's answer stands); __skip__ = unsure (dropped).
function applied(q, jev, cs) {
  if ((cs[EXCLUDE] || {}).label === SKIP) return null;
  const j = { ...(jev || {}) };
  for (const [qid, c] of Object.entries(cs)) { if (qid === EXCLUDE || !q[qid] || c.label === null) continue; if (c.label === SKIP) delete j[qid]; else j[qid] = oneHot(q[qid], c.label); }
  return Object.keys(j).length ? j : null;
}
// A chunk example's questions are its own (stored on the row: "Chunk c12: \"Delgado\""), never the bare template — a model trained on
// the template sees every chunk as the same question and can only learn per-text priors.
const qOf = (set, r) => isChunks(set) ? Object.fromEntries(Object.keys(r.questions || r.jev || {}).map(k => [k, (r.questions && r.questions[k] && r.questions[k].instructions) ? r.questions[k] : set.q[CH]])) : set.q;
// Training rows of one set, as core.Schema.training_rows: held-out and excluded dropped, the dominant answer capped, the last 600 kept.
function trainingRowsOf(set, rows, corr) {
  const counts = {}, rng = seeded(0), keep = [], ck = isChunks(set);
  const key = qid => ck ? CH : qid;
  for (const r of rows) { if (!r.jev || !Object.keys(r.jev).length) continue; const q = qOf(set, r); for (const [qid, qq] of Object.entries(q)) if (r.jev[qid]) { const a = answerOf(qq, r.jev[qid]); (counts[key(qid)] || (counts[key(qid)] = {}))[a] = ((counts[key(qid)] || {})[a] || 0) + 1; } }
  for (const r of rows) { const q = qOf(set, r), j = applied(q, r.jev, corr[r.id] || {}); if (j) keep.push({ state: r.state, jev: j, q }); }
  const dom = Object.fromEntries(Object.entries(counts).filter(([, c]) => Object.keys(c).length).map(([qid, c]) => [qid, argmax(c)]));
  const share = Math.max(1e-6, ...Object.entries(counts).filter(([, c]) => Object.keys(c).length).map(([qid, c]) => c[dom[qid]] / Object.values(c).reduce((a, b) => a + b, 0)));
  // a chunk example (one request, many chunks) is kept whole; the cap applies to requests whose every chunk is the dominant answer
  return keep.filter(r => { const allDom = Object.keys(r.q).filter(k => r.jev[k]).every(k => answerOf(r.q[k], r.jev[k]) === dom[key(k)]); return !allDom || rng() < DOMINANT_CAP / share; }).slice(-MAX_TRAIN_ROWS);
}
export async function labelledCount(env, pid) { return (await env.DB.prepare(`SELECT COUNT(*) n FROM examples WHERE project_id = ? AND holdout = 0 AND ${LABELLED()}`).bind(pid).first()).n; }
// → {ok, version} | throws {status, body}
/** A cohort: which requests a training run draws from. {sources: [...], keys: ["key us_xxxxx", ...], schemas: [...], since, until (unix s)}.
    Empty/missing = everything. Held-out rows are always taken from the same cohort. Returns [whereSql, binds] on examples e. */
export function cohortSql(c) {
  const w = [], b = [], list = (v) => Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 50) : [];
  const src = list(c && c.sources).filter(s => SOURCES.includes(s)); if (src.length) { w.push(`e.source IN (${src.map(() => "?").join(",")})`); b.push(...src); }
  const keys = list(c && c.keys); if (keys.length) { w.push(`e.via IN (${keys.map(() => "?").join(",")})`); b.push(...keys); }
  const sch = list(c && c.schemas); if (sch.length) { w.push(`e.schema_id IN (${sch.map(() => "?").join(",")})`); b.push(...sch); }
  if (c && +c.since > 0) { w.push("e.t >= ?"); b.push(+c.since); }
  if (c && +c.until > 0) { w.push("e.t <= ?"); b.push(+c.until); }
  return [w.length ? " AND " + w.join(" AND ") : "", b];
}
export const cleanCohort = c => { if (!c || typeof c !== "object") return null; const o = {}; for (const k of ["sources", "keys", "schemas"]) if (Array.isArray(c[k]) && c[k].length) o[k] = c[k].map(String).slice(0, 50); for (const k of ["since", "until"]) if (+c[k] > 0) o[k] = +c[k]; if (c.include_left_out) o.include_left_out = true; return Object.keys(o).length ? o : null; };
/** plan: the setup's training plan this run belongs to; its own oracle (if any) picks the labels instead of each route's. */
// keep: a Set of request ids to train on (a selection from the request pool); the cohort is then only written down, not applied
/** The field of an object state that holds what a person wrote or said: the planner's pick when real requests have it, else the one
    string field whose value varies across them. null for string states or when there's no single such field. */
export function textFieldOf(sets, rows) {
  const objs = rows.map(r => r.state).filter(st => st && typeof st === "object" && !Array.isArray(st)); if (!objs.length || objs.length < rows.length / 2) return null;
  for (const s of sets) { const f = s.plan && s.plan.seed_field; if (f && objs.every(st => typeof st[f] === "string")) return f; }
  const cands = Object.keys(objs[0]).filter(k => objs.every(st => typeof st[k] === "string"));
  const varying = cands.filter(k => new Set(objs.slice(0, 200).map(st => st[k])).size > 1);
  return varying.length === 1 ? varying[0] : cands.length === 1 ? cands[0] : null;
}
export async function startTraining(env, pr, base = "laya", smoke = false, epochs = 4, dryRun = false, cohort = null, plan = null, keep = null) {
  await freshSetup(env, pr);
  if (!BASES[base]) throw Object.assign(new Error("base must be one of " + Object.keys(BASES).join(", ")), { status: 400 });
  if (!dryRun && !baseReady(env, base)) throw Object.assign(new Error(`${BASES[base]} isn't set up on this server yet (its engine isn't deployed).`), { status: 409 });
  if (!dryRun && !(await engineHasBase(env, base))) throw Object.assign(new Error(`${BASES[base]} isn't on the training engine yet. Nothing was started or charged.`), { status: 409 });
  const ms = await pollTraining(env, pr, await modelsOf(env, pr.id)); const next = Math.max(0, ...ms.map(m => m.version)) + 1;
  if (!dryRun && ms.some(m => m.status === "training" && familyOf(m.base) === familyOf(base))) throw Object.assign(new Error("training already running"), { status: 409, body: { error: "training already running", version: next } });
  const sets = await setsOf(env, pr.id); if (!sets.length) throw Object.assign(new Error("no examples in this project yet"), { status: 404 });
  const [cw, cb] = keep ? ["", []] : cohortSql(cohort);
  const own = plan && plan.oracle && plan.oracle.length ? plan.oracle : null;
  const rows = (await env.DB.prepare(`SELECT id, schema_id, holdout, state_json, ${GR} jev, ${own ? "answers_json," : ""} json_extract(extra_json, '$.questions') qs FROM examples e WHERE project_id = ?${cw} ORDER BY schema_id, line`).bind(pr.id, ...cb).all()).results
    .filter(r => !keep || keep.has(r.id)).map(r => ({ id: r.id, schema: r.schema_id, holdout: r.holdout, state: J(r.state_json), jev: own ? groundOf(own, J(r.answers_json, {}), pr.id)[1] : J(r.jev), questions: J(r.qs) }));
  const corr0 = await correctionsOf(env, pr.id);
  // requests the realism check left out (written ones that didn't read like the real ones) train only when asked for
  const incl = !!((cohort && cohort.include_left_out) || (plan && plan.include_left_out)), isLeftOut = cs => !!cs && (cs[EXCLUDE] || {}).label === SKIP && (cs[EXCLUDE] || {}).by === "realism-check";
  const corr = incl ? Object.fromEntries(Object.entries(corr0).map(([id, cs]) => [id, isLeftOut(cs) ? Object.fromEntries(Object.entries(cs).filter(([k]) => k !== EXCLUDE)) : cs])) : corr0;
  // one questions object for the whole project; an id whose definition differs between sets gets a suffix (ids only pair targets with definitions)
  const q = {}, keymap = {}, sig = d => JSON.stringify(d.criteria ?? null) + (d.type || "");
  for (const s of sets) for (const [qid, d] of Object.entries(s.q)) { let k = isChunks(s) ? s.id + "#chunk" : qid, n = 1; while (q[k] && sig(q[k]) !== sig(d)) { n++; k = qid + "@" + n; } if (!q[k]) q[k] = d; keymap[s.id + "\u0000" + qid] = k; }
  const lines = [], holdout = [];
  for (const s of sets) {
    const mine = rows.filter(r => r.schema === s.id), ck = isChunks(s), km = k => ck ? k : keymap[s.id + "\u0000" + k];
    // chunk rows carry their own questions (ids differ per request); fixed rows use the project-wide definitions
    const kept = trainingRowsOf(s, mine.filter(r => !r.holdout), corr);
    // chunk sets: balance per word, not per request, but keep the hard negatives. Every word of a request that contains a
    // non-dominant answer is kept (that's where "same sentence, different word, different answer" is learned); only the
    // words of all-dominant requests are thinned, so the dominant answer ends near DOMINANT_CAP_CHUNK of the items.
    let dropDom = () => false;
    if (ck) {
      const cc = {}, mixed = new Set(); let domInMixed = 0;
      for (const r of kept) { for (const k of Object.keys(r.q)) if (r.jev[k]) { const a = answerOf(r.q[k], r.jev[k]); cc[a] = (cc[a] || 0) + 1; } }
      const tot = Object.values(cc).reduce((a, b) => a + b, 0), da = argmax(cc), share = tot ? cc[da] / tot : 0, rng = seeded(1);
      for (const r of kept) { const ans = Object.keys(r.q).filter(k => r.jev[k]).map(k => answerOf(r.q[k], r.jev[k])); if (ans.some(a => a !== da)) { mixed.add(r); domInMixed += ans.filter(a => a === da).length; } }
      if (share > DOMINANT_CAP_CHUNK) {
        const nonDom = tot - cc[da], wantDom = Math.max(0, Math.round(nonDom * DOMINANT_CAP_CHUNK / (1 - DOMINANT_CAP_CHUNK)) - domInMixed), cleanDom = Math.max(1, cc[da] - domInMixed), keepP = Math.min(1, wantDom / cleanDom);
        dropDom = (q, a, r) => !mixed.has(r) && answerOf(q, a) === da && rng() > keepP;
      }
    }
    for (const r of kept) { const targets = Object.fromEntries(Object.keys(r.q).filter(k => r.jev[k] && !dropDom(r.q[k], r.jev[k], r)).map(k => [km(k), distOf(r.q[k], r.jev[k])])); if (Object.keys(targets).length) lines.push({ state: r.state, ...(ck ? { questions: r.q } : {}), targets }); }
    for (const r of mine.filter(r => r.holdout)) {
      const cs = corr[r.id] || {}; if ((cs[EXCLUDE] || {}).label === SKIP) continue; const rq = qOf(s, r);
      const lab = Object.fromEntries(Object.entries(r.jev || {}).filter(([k]) => rq[k]).map(([k, a]) => [k, answerOf(rq[k], a)]));
      for (const [k, c] of Object.entries(cs)) { if (k === EXCLUDE || !rq[k] || c.label === null) continue; if (c.label === SKIP) delete lab[k]; else lab[k] = String(c.label); }
      if (Object.keys(lab).length) holdout.push({ state: r.state, ...(ck ? { questions: rq } : {}), labels: Object.fromEntries(Object.entries(lab).map(([k, v]) => [km(k), v])) });
    }
  }
  if (dryRun) {
    // where every request in the pick goes, so the count shown is the one the trainer uses: total = left out + excluded + held out + no label + balanced away + trains
    const lo = rows.filter(r => isLeftOut(corr0[r.id])).length, ex = rows.filter(r => !isLeftOut(corr0[r.id]) && ((corr0[r.id] || {})[EXCLUDE] || {}).label === SKIP).length;
    const fixed = r => Object.entries(corr[r.id] || {}).some(([k, c]) => k !== EXCLUDE && c.label !== null && c.label !== SKIP);
    const out = rows.filter(r => !((corr[r.id] || {})[EXCLUDE] || {}).label), held = out.filter(r => r.holdout).length, nolab = out.filter(r => !r.holdout && (!r.jev || !Object.keys(r.jev).length) && !fixed(r)).length;
    const breakdown = { total: rows.length, left_out: lo, left_out_included: incl, removed: ex, held_out: held, no_label: nolab, balanced_away: Math.max(0, out.length - held - nolab - lines.length), trains: lines.length,
      ...(familyOf(base) === "laya" && lines.length ? { calibration: Math.min(lines.length, Math.max(10, Math.floor(Math.max(lines.length, MIN_TRAIN_FILE) / 10))) } : {}) };
    return { breakdown, requests: lines.length, sequences: lines.reduce((s, r) => s + Object.keys(r.targets).length, 0), holdout: holdout.length, tokens: lines.reduce((s, r) => s + Object.keys(r.targets).length * (JSON.stringify(r.state).length / 4 + 40), 0) };
  }
  if (!lines.length) throw Object.assign(new Error("no examples to train on yet"), { status: 400 });
  const blind = lines.find(r => r.questions && Object.values(r.questions).some(d => /\{text\}|\{n\}/.test(String(d.instructions))));
  if (blind) throw Object.assign(new Error("training file would contain unfilled question templates ({text}); refusing to train on blind questions"), { status: 500 });
  const n_rows = lines.length; while (lines.length < MIN_TRAIN_FILE) lines.push(...lines.slice(0, MIN_TRAIN_FILE - lines.length));   // the trainer keeps 10 rows for calibration
  const trained_on = await labelledCount(env, pr.id);
  // what the held-out check will be over, kept until the engine reports back (see heldOut): labels sent, and answers with none held out
  const seenAns = new Set(holdout.flatMap(r => Object.values(r.labels).map(String)));
  const options = [...new Set(sets.flatMap(s => Object.values(s.q).filter(d => d.type !== "noul" && d.type !== "score").flatMap(d => crit(d).map(String))))];
  const sent = { pending: true, asked: holdout.reduce((n, r) => n + Object.keys(r.labels).length, 0), missing_answers: options.filter(o => !seenAns.has(o)).slice(0, 20) };
  let payload;
  if (labelledTrainer(base)) {   // Kev and GLiNER train on labelled requests: the same rows, with each question's label instead of a soft target
    const labelOf = (d, dist) => { const i = dist.indexOf(Math.max(...dist)); return d.type === "noul" ? i === 1 : d.type === "score" ? i : crit(d)[i]; };
    const toReq = (r, labels) => ({ state: r.state, questions: Object.fromEntries(Object.entries(labels).map(([k, lab]) => { const d = (r.questions || q)[k]; return [k, { type: d.type, instructions: d.instructions, ...(d.criteria != null ? { criteria: d.criteria } : {}), label: lab }]; })) });
    const trainReqs = lines.map(r => toReq(r, Object.fromEntries(Object.entries(r.targets).map(([k, dist]) => [k, labelOf((r.questions || q)[k], dist)]))));
    const holdReqs = holdout.map(r => toReq(r, Object.fromEntries(Object.entries(r.labels).map(([k, v]) => { const d = (r.questions || q)[k]; return [k, d.type === "noul" ? v === "true" : d.type === "score" ? +v : v]; }))));
    payload = { project: pr.id, version: next, base, rows: trainReqs, holdout: holdReqs, epochs, ...(smoke ? { smoke: true } : {}) };
    // Tiny reads one text per request: the state when it is a string, else its text field (the plan's, or the one string field
    // that varies across the route's requests, e.g. a voice command beside a house's device list); files come back like a browser copy
    if (familyOf(base) === "tiny") Object.assign(payload, { route: pr.name, text_field: textFieldOf(sets, rows), epochs: 0, ...(env.SELF_URL ? { web_upload_url: env.SELF_URL } : {}) });
  } else payload = { project: pr.id, version: next, base, questions: q, rows: lines, holdout, epochs, ...(smoke ? { smoke: true } : {}), ...(env.SELF_URL ? { web_upload_url: env.SELF_URL } : {}) };   // after training, the engine exports the version for the browser and hands the files back here
  const r = await engine(env, "/train", { method: "POST", body: JSON.stringify(payload) }, base);
  await env.DB.prepare("INSERT INTO models (project_id, version, status, trained_rows, t, job, trained_on, base, cohort_json, plan, holdout_agreement_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(pr.id, next, "training", n_rows, secs(), String(r.job), trained_on, base, cohort ? JSON.stringify(cohort) : null, plan ? plan.id : "main", JSON.stringify(sent)).run();
  return { ok: true, version: next, base, plan: plan ? plan.id : "main" };
}
// After a request gets a grounded answer: each plan that trains automatically trains its first version at `first_at` labelled
// requests, then again every `every` more (only while live agreement is below the switch bar, if it says so).
// `n` counts labelled requests outside the held-out ones (labelledCount). The route page shows planNext too, so both say the same.
function planNext(plan, ms, n) {
  const cur = ms.filter(m => m.status === "ready" && (m.plan || "main") === plan.id).pop();
  const busy = ms.some(m => m.status === "training" && familyOf(m.base) === familyOf(plan.base));
  return { cur, busy, have: Math.max(0, cur ? n - (cur.trained_on || 0) : n), need: cur ? plan.auto.every : plan.auto.first_at };
}
// "already agrees well enough": no kind of request has MIN_LIVE live comparisons below the switch bar
const agreesEnough = T => !Object.values(T.by).some(x => (x.agreement.n || 0) >= MIN_LIVE && !x.agreement.ready_to_switch);
export async function autoTrain(env, pr) {
  const S = await freshSetup(env, pr), ms = await modelsOf(env, pr.id), n = await labelledCount(env, pr.id); let T = null;
  for (const plan of S.plans.filter(p => p.auto)) {
    const x = planNext(plan, ms, n);
    if (x.busy || x.have < x.need) continue;
    if (x.cur && plan.auto.until_agreement) { T = T || await tally(env, pr); if (agreesEnough(T)) continue; }
    const base = planBase(env, plan);
    if (!base) continue;
    await startTraining(env, pr, base, false, plan.epochs, false, plan.cohort, { ...plan, base });
  }
}
/** For the route page: each plan that trains by itself, how far it is from its next run, and what it waits for:
    "labels" (fewer than `need` new labelled requests), "training" (a run of that base is going), "agreement" (enough labels, but
    the latest version already agrees well enough on live requests), or null (the next labelled request starts it). */
/** The base a plan really trains here: its own, or Tiny on a server without that engine (a self-hosted one often has only
    Tiny), or null when nothing is set up. The route page shows this one, so it says what will happen. */
export const planBase = (env, plan) => baseReady(env, plan.base) ? plan.base : (Object.keys(BASES).find(b => familyOf(b) === "tiny" && baseReady(env, b)) || null);
export function autoPlans(S, ms, n, T, env) {
  return S.plans.filter(p => p.auto).map(plan => {
    const x = planNext(plan, ms, n);
    return { plan: plan.id, name: plan.name, base: (env && planBase(env, plan)) || plan.base, epochs: plan.epochs, oracle: plan.oracle, cohort: plan.cohort, first: !x.cur, have: x.have, need: x.need,
      until_agreement: !!plan.auto.until_agreement, waiting: x.busy ? "training" : x.have < x.need ? "labels" : x.cur && plan.auto.until_agreement && agreesEnough(T) ? "agreement" : null };
  });
}

// ---- views
export function setView(x, mv, meta = {}, { recent = false } = {}) {
  const s = x.set, m = meta[s.id] || {};
  return { id: s.id, tenant: s.id.split("-")[0], first_seen: x.first ?? s.first_seen, last_seen: x.last ?? s.last_seen, via: x.via, sources: x.sources, holdout: x.holdout, declared: !!s.declared,
    group: { id: "default", members: mv.question_sets, calls: mv.readiness.calls, status: mv.status, version: mv.version, trained_rows: mv.trained_rows, trained_on: mv.trained_on, model: mv.version > 0, last_error: mv.last_error },
    questions: Object.keys(s.q), question_defs: s.q, shape: s.shape, plan: s.plan || null, suggestions: s.suggestions || null, chunks: x.chunks || 0,
    status: mv.status, version: mv.version, readiness: readinessOf(x), agreement: x.agreement, name: m.name || null, archived: !!m.archived_at,
    ...(recent ? { recent: x.pairs.slice(-60).map(p => Object.fromEntries(Object.entries(s.q).filter(([k]) => p.jev[k] && p.local[k]).map(([k, q]) => [k, [answerOf(q, p.jev[k]), answerOf(q, p.local[k])]]))) } : {}) };
}
export async function stats(env, pr, schema) {
  const f = schema ? " AND e.schema_id = ?" : "", b = schema ? [pr.id, schema] : [pr.id];
  const [src, corr] = await env.DB.batch([
    env.DB.prepare("SELECT source, COUNT(*) n, SUM(holdout) ho FROM examples e WHERE e.project_id = ?" + f + " GROUP BY source").bind(...b),
    env.DB.prepare(`SELECT COUNT(DISTINCT CASE WHEN c.qid != '${EXCLUDE}' THEN c.example_id END) corrected, COUNT(DISTINCT CASE WHEN c.qid = '${EXCLUDE}' AND c.label_json = '"${SKIP}"' THEN c.example_id END) excluded FROM corrections c JOIN examples e ON e.id = c.example_id WHERE c.label_json IS NOT NULL AND e.project_id = ?` + f).bind(...b)]);
  const c = corr.results[0] || {};
  const pending = (await env.DB.prepare("SELECT COUNT(*) n FROM examples e WHERE e.project_id = ?" + f + " AND json_extract(extra_json, '$.pending_label') IS NOT NULL").bind(...b).first()).n;
  return { by_source: Object.fromEntries(src.results.map(r => [r.source, r.n])), holdout: src.results.reduce((s, r) => s + (r.ho || 0), 0), corrected: c.corrected || 0, excluded: c.excluded || 0, pending_label: pending };
}

// ---- the examples list (GET /examples): newest first, filters ANDed, same fields as the engine's /calls
/** The request log: every request through a key, newest first, with the recorded example (answers, who answered) when there is one.
    ?key=key us_xxxxx  ?status=ok|failed  ?since= ?until= (unix seconds)  ?offset= ?limit= */
export async function listRequests(env, pr, qp) {
  await freshSetup(env, pr);
  const g = k => { const v = qp.get(k); return v === null || v === "" ? null : v; };
  const w = ["r.project_id = ?"], b = [pr.id];
  if (g("key")) { w.push("r.via = ?"); b.push(g("key")); }
  if (g("status") === "failed") w.push("r.status != 200"); else if (g("status") === "ok") w.push("r.status = 200");
  if (g("since")) { w.push("r.t >= ?"); b.push(+g("since")); }
  if (g("until")) { w.push("r.t <= ?"); b.push(+g("until")); }
  const offset = Math.max(0, parseInt(qp.get("offset") || "0") || 0), limit = Math.max(1, Math.min(200, parseInt(qp.get("limit") || "50") || 50)), where = w.join(" AND ");
  const [{ results: rows }, tot] = await Promise.all([env.DB.prepare(`SELECT r.* FROM request_log r WHERE ${where} ORDER BY r.t DESC LIMIT ? OFFSET ?`).bind(...b, limit, offset).all(), env.DB.prepare(`SELECT COUNT(*) n FROM request_log r WHERE ${where}`).bind(...b).first()]);
  const ids = rows.map(r => r.example_id).filter(Boolean), ex = {};
  if (ids.length) {
    const sets = Object.fromEntries((await setsOf(env, pr.id)).map(s => [s.id, s]));
    const got = (await env.DB.prepare(`SELECT * FROM examples WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results;
    const corr = {}; for (const x of (await env.DB.prepare(`SELECT * FROM corrections WHERE label_json IS NOT NULL AND example_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results) (corr[x.example_id] || (corr[x.example_id] = {}))[x.qid] = { label: J(x.label_json), by: x.by, t: x.t };
    for (const r of got) if (sets[r.schema_id]) ex[r.id] = exampleOut(sets[r.schema_id], r, corr[r.id] || {});
  }
  return { total: tot.n, offset, limit, requests: rows.map(r => ({ id: r.id, t: r.t, key: r.via, status: r.status, ok: r.status === 200, error: r.error, served: r.served, ms: r.ms, fallback: r.fallback_json ? J(r.fallback_json) : null, path: r.path_json ? J(r.path_json) : null, example: r.example_id ? ex[r.example_id] || null : null })) };
}
export async function listExamples(env, pr, qp) {
  await freshSetup(env, pr);
  const g = k => { const v = qp.get(k); return v === null || v === "" ? null : v; };
  const w = ["e.project_id = ?"], b = [pr.id];
  if (g("schema")) { w.push("e.schema_id = ?"); b.push(g("schema")); }
  if (g("key")) { w.push("e.via = ?"); b.push(g("key")); }
  if (g("source")) { w.push("e.source = ?"); b.push(g("source")); }
  if (g("since")) { w.push("e.t >= ?"); b.push(+g("since")); }
  if (g("until")) { w.push("e.t <= ?"); b.push(+g("until")); }
  if (g("id")) { w.push("e.id = ?"); b.push(g("id")); }   // one request, e.g. Try it opening one from the list
  if (g("q")) { w.push("e.state_json LIKE ? ESCAPE '\\'"); b.push("%" + g("q").replace(/[\\%_]/g, c => "\\" + c) + "%"); }
  const live = "EXISTS (SELECT 1 FROM corrections c WHERE c.example_id = e.id AND c.label_json IS NOT NULL)";
  if (qp.get("corrected") === "1") w.push(live); else if (qp.get("corrected") === "0") w.push("NOT " + live);
  const offset = Math.max(0, parseInt(qp.get("offset") || "0") || 0), limit = Math.max(1, Math.min(200, parseInt(qp.get("limit") || "50") || 50));
  const answer = g("answer"), maxp = g("maxp") === null ? null : +g("maxp"), disagree = qp.get("disagree") === "1", where = w.join(" AND ");
  const sets = Object.fromEntries((await setsOf(env, pr.id)).map(s => [s.id, s])); let total, rows;
  if (answer || maxp !== null || disagree) {   // answer-level filters need the answers: filter the light rows in JS, then fetch the page
    const [aq, _, av] = answer ? [answer.slice(0, answer.indexOf("=")), 0, answer.slice(answer.indexOf("=") + 1)] : [];
    const light = (await env.DB.prepare(`SELECT e.id, e.schema_id, e.answers_json, e.grounded_json FROM examples e WHERE ${where} ORDER BY e.t DESC`).bind(...b).all()).results.filter(r => {
      const s = sets[r.schema_id]; if (!s) return false; const a = J(r.answers_json, {}), jev = J(r.grounded_json, {}) || {}, loc = a.model, q = isChunks(s) ? Object.fromEntries(Object.keys(jev).map(k => [k, s.q[CH]])) : s.q;
      if (answer && (isChunks(s) ? !Object.values(jev).some(x => answerOf(q[Object.keys(jev)[0]], x) === av) : (!jev[aq] || !q[aq] || answerOf(q[aq], jev[aq]) !== av))) return false;
      if (maxp !== null && !Object.keys(q).some(k => jev[k] && topP(jev[k]) <= maxp)) return false;
      if (disagree && !(loc && Object.keys(q).some(k => loc[k] && jev[k] && answerOf(q[k], loc[k]) !== answerOf(q[k], jev[k])))) return false;
      return true; });
    total = light.length; const ids = light.slice(offset, offset + limit).map(r => r.id), got = {};
    for (const c of chunks(ids, 90)) for (const r of (await env.DB.prepare(`SELECT * FROM examples WHERE id IN (${c.map(() => "?").join(",")})`).bind(...c).all()).results) got[r.id] = r;
    rows = ids.map(id => got[id]).filter(Boolean);
  } else {
    total = (await env.DB.prepare(`SELECT COUNT(*) n FROM examples e WHERE ${where}`).bind(...b).first()).n;
    rows = (await env.DB.prepare(`SELECT e.* FROM examples e WHERE ${where} ORDER BY e.t DESC LIMIT ? OFFSET ?`).bind(...b, limit, offset).all()).results;
  }
  const corr = {};
  for (const c of chunks(rows.map(r => r.id), 90)) for (const x of (await env.DB.prepare(`SELECT * FROM corrections WHERE label_json IS NOT NULL AND example_id IN (${c.map(() => "?").join(",")})`).bind(...c).all()).results) (corr[x.example_id] || (corr[x.example_id] = {}))[x.qid] = { label: J(x.label_json), by: x.by, t: x.t };
  return { total, offset, limit, calls: rows.map(r => exampleOut(sets[r.schema_id] || { q: {} }, r, corr[r.id] || {})) };
}
export function exampleOut(s, r, cr) {
  const a = J(r.answers_json, {}), gr = J(r.grounded_json, null), jev = a.jev || gr || {}, loc = a.model && Object.keys(a.model).length ? a.model : null, extra = J(r.extra_json, {}) || {}, ck = isChunks(s);
  const own = ck ? (extra.questions || Object.fromEntries(Object.keys(jev).map(k => [k, s.q[CH]]))) : null, q = ck ? Object.fromEntries(Object.keys(own).map(k => [k, s.q[CH]])) : s.q, state = J(r.state_json);
  return { id: r.id, schema: r.schema_id, line: r.line, t: r.t, state, via: r.via, v: extra.v ?? null, source: r.source, holdout: !!r.holdout, ...(extra.pending_label ? { pending_label: extra.pending_label } : {}),
    ...(ck ? { question_defs: own, chunks: chunkSpans(state, own, s.plan && s.plan.seed_field) } : {}),
    served: r.served || (Object.keys(jev).length ? "jev" : null), meta: J(r.meta_json), answers: Object.fromEntries(Object.entries(a).filter(([, x]) => x && Object.keys(x).length).map(([tg, x]) => [tg, summ(q, x)])),
    ms: J(r.ms_json), fallback: extra.fallback || null, errors: extra.errors || null, route: r.route || null, path: extra.path || null,
    grounded_by: r.grounded_by || null, grounded: gr ? summ(q, gr) : null, jev: summ(q, a.jev || {}), local: loc ? Object.fromEntries(Object.keys(q).filter(k => loc[k]).map(k => [k, answerOf(q[k], loc[k])])) : null,
    corrections: Object.fromEntries(Object.entries(cr).filter(([k]) => k !== EXCLUDE)), excluded: (cr[EXCLUDE] || {}).label === SKIP,
    // why it is left out of training: the realism check ("didn't read like your requests") or a person
    left_out: (cr[EXCLUDE] || {}).label === SKIP ? ((cr[EXCLUDE] || {}).by === "realism-check" ? "realism" : "person") : null, questions: Object.keys(q) };
}
// label: an option / true|false / level index; __skip__ = unsure; null = remove. qid __all__ with __skip__ excludes the example (null re-includes).
export async function correct(env, pr, b, by) {
  const id = String(b.id || ""), sid = id.slice(0, id.lastIndexOf(":")), qid = b.qid; let label = b.label === undefined ? null : b.label;
  const ex = await env.DB.prepare("SELECT id, extra_json, answers_json FROM examples WHERE id = ? AND project_id = ?").bind(id, pr.id).first(); const s = ex && await setOf(env, pr, sid);
  if (!s) return [404, { error: "unknown call" }];
  const qdef = s && (isChunks(s) ? ((questionsOfRow(s, ex)[qid] || ((J(ex.answers_json, {}).jev || {})[qid])) ? s.q[CH] : null) : s.q[qid]);
  if (qid === EXCLUDE) { if (label !== SKIP && label !== null) return [400, { error: "use __skip__ to exclude, null to include" }]; }
  else if (!qdef) return [400, { error: "unknown question id" }];
  else if (label !== null && label !== SKIP) {
    const q = qdef;
    if (q.type === "choice") { if (!crit(q).includes(label)) return [400, { error: "label must be one of " + JSON.stringify(crit(q)) }]; }
    else if (q.type === "noul") { const v = String(label).toLowerCase(); if (!["true", "false", "yes", "no"].includes(v)) return [400, { error: "label must be true or false" }]; label = v === "true" || v === "yes" ? "true" : "false"; }
    else { if (!/^\d+$/.test(String(label)) || +label >= crit(q).length) return [400, { error: `label must be a level index 0..${crit(q).length - 1}` }]; label = +label; }
  }
  await env.DB.prepare(`INSERT INTO corrections (example_id, qid, label_json, "by", t) VALUES (?,?,?,?,?) ON CONFLICT(example_id, qid) DO UPDATE SET label_json = excluded.label_json, "by" = excluded."by", t = excluded.t`)
    .bind(id, qid, label === null ? null : JSON.stringify(label), by || "ui", secs()).run();
  return [200, { ok: true }];
}

// ---- bulk remove: by explicit ids, or every example matching a source and/or question-set. → {removed}
export async function removeExamples(env, pr, b) {
  let ids = Array.isArray(b.ids) ? b.ids.filter(x => typeof x === "string") : null;
  if (!ids) {
    const w = ["project_id = ?"], v = [pr.id];
    if (b.source) { w.push("source = ?"); v.push(b.source); }
    if (b.schema) { w.push("schema_id = ?"); v.push(b.schema); }
    if (w.length < 2) return [400, { error: "give ids, or a source and/or schema to remove" }];
    ids = (await env.DB.prepare(`SELECT id FROM examples WHERE ${w.join(" AND ")}`).bind(...v).all()).results.map(r => r.id);
  }
  let removed = 0;
  for (const c of chunks(ids, 90)) {
    const ph = c.map(() => "?").join(",");
    const [, r] = await env.DB.batch([env.DB.prepare(`DELETE FROM corrections WHERE example_id IN (${ph})`).bind(...c), env.DB.prepare(`DELETE FROM examples WHERE project_id = ? AND id IN (${ph})`).bind(pr.id, ...c)]);
    removed += r.meta.changes || 0;
  }
  return [200, { removed }];
}

// ---- recent rows for the routing preview (newest first)
export async function recentRows(env, pr, n = 100) {
  return (await env.DB.prepare("SELECT id, t, schema_id, via, source, answers_json, ms_json, extra_json FROM examples WHERE project_id = ? ORDER BY t DESC LIMIT ?").bind(pr.id, n).all()).results
    .map(r => ({ id: r.id, t: r.t, schema: r.schema_id, via: r.via, source: r.source, answers: J(r.answers_json, {}), ms: J(r.ms_json), usage: (J(r.extra_json, {}) || {}).usage }));
}

// ---- admin import (one-off migration of the Modal volume). Idempotent: every write is an upsert.
export async function importData(env, b) {
  if (b.project) await env.DB.prepare("INSERT OR IGNORE INTO projects (id, workspace_id, name, description, tags_json, keywords_json, tenant, created_at, settings_json) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(b.project.id, b.project.workspace_id, b.project.name || "Default", b.project.description || null, "[]", "[]", b.project.tenant, b.project.created_at || Date.now(), "{}").run();
  const pr = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(b.project_id || (b.project || {}).id).first(); if (!pr) return [404, { error: "unknown project_id" }];
  const mine = id => String(id || "").startsWith(pr.tenant + "-"), bad = [];
  const st = [];
  for (const s of b.question_sets || []) { if (!mine(s.id)) { bad.push(s.id); continue; }
    st.push(env.DB.prepare("INSERT INTO question_sets (id, project_id, questions_json, declared, first_seen, last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET questions_json = excluded.questions_json, declared = excluded.declared, project_id = excluded.project_id")
      .bind(s.id, pr.id, JSON.stringify(s.questions), s.declared ? 1 : 0, s.first_seen ?? null, s.last_seen ?? null)); }
  for (const e of b.examples || []) { if (!mine(e.schema_id) || e.id !== e.schema_id + ":" + e.line) { bad.push(e.id); continue; }
    st.push(env.DB.prepare("INSERT OR REPLACE INTO examples (id, project_id, schema_id, line, t, state_json, source, via, holdout, answers_json, served, ms_json, meta_json, extra_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(e.id, pr.id, e.schema_id, e.line, e.t, JSON.stringify(e.state), e.source, e.via ?? null, e.holdout ? 1 : 0, JSON.stringify(e.answers || {}), e.served ?? null, e.ms ? JSON.stringify(e.ms) : null, e.meta ? JSON.stringify(e.meta) : null, e.extra ? JSON.stringify(e.extra) : null)); }
  for (const c of b.corrections || []) { if (!mine(c.example_id)) { bad.push(c.example_id); continue; }
    st.push(env.DB.prepare(`INSERT INTO corrections (example_id, qid, label_json, "by", t) VALUES (?,?,?,?,?) ON CONFLICT(example_id, qid) DO UPDATE SET label_json = excluded.label_json, "by" = excluded."by", t = excluded.t`)
      .bind(c.example_id, c.qid, c.label === null || c.label === undefined ? null : JSON.stringify(c.label), c.by || null, c.t ?? null)); }
  if (b.routing) { const r = JSON.parse(JSON.stringify(b.routing)); for (const t of Object.values(r.targets || {})) { delete t.auth; delete t.auth_enc; }
    st.push(env.DB.prepare("INSERT INTO routing (project_id, json) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET json = excluded.json").bind(pr.id, JSON.stringify(r))); }
  for (const m of b.models || []) st.push(env.DB.prepare("INSERT OR REPLACE INTO models (project_id, version, status, trained_rows, t, holdout_agreement_json, error, job, trained_on) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(pr.id, m.version, m.status, m.trained_rows ?? null, m.t ?? null, m.holdout_agreement ? JSON.stringify(m.holdout_agreement) : null, m.error ?? null, m.job ?? null, m.trained_on ?? null));
  st.push(env.DB.prepare("UPDATE question_sets SET first_seen = (SELECT MIN(t) FROM examples WHERE schema_id = question_sets.id), last_seen = (SELECT MAX(t) FROM examples WHERE schema_id = question_sets.id) WHERE project_id = ?").bind(pr.id));
  await batch(env, st);
  return [200, { ok: true, project_id: pr.id, question_sets: (b.question_sets || []).length, examples: (b.examples || []).length, corrections: (b.corrections || []).length, routing: !!b.routing, models: (b.models || []).length, skipped: bad }];
}
