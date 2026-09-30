/* Per-project routing, from the original Python proxy: which target (jev | model | endpoint:<id>) answers a call, what else runs
   alongside (shadows finish after the response via ctx.waitUntil), the cache rule, and the replay preview. Stored in D1 `routing`; endpoint keys
   stay encrypted in `endpoints.auth_enc` and are never part of the routing JSON. */
import { predict, containerOf } from "./lib.js";
import { chargeServing } from "./ledger.js";
import { hostingOf } from "./billing.js";
import { secs, sha1, ensureSet, noteWording, record, newExampleId, addShadow, topP, sourceOf, SOURCES, modelsOf, currentVersion, seeded, autoTrain, schemaIdFor, kindIdsFor, minConfOf } from "./data.js";
import { loadSetup, routeOf, storageKey, versionKey, WAKE_WAIT_MS } from "./setup.js";
import { ctxOf, rowsOf, ask, whyNot, upstreamName } from "./answer.js";
import { resolveAnswerer } from "./setup.js";
import { isChunks } from "./shape.js";
import { suggestFor, describeFromTraffic } from "./gen.js";

export const TYPES = ["header", "split", "confidence_gate", "fallback", "shadow", "cache"];
const COST = { jev: 0.042 / 1e6, model: 0.003 / 1000, endpoint: 0 }, LATENCY = { jev: 300, model: 120, endpoint: 300 }, JEV_TOKENS = 200;
export const defaultRouting = () => ({ targets: { jev: { on: true }, model: { on: true, version: "latest" } },
  rules: [{ id: "r1", type: "header", on: false }, { id: "r2", type: "split", on: true, weights: { jev: 100 } }, { id: "r3", type: "shadow", on: true, target: "model", pct: 100 },
          { id: "r4", type: "fallback", on: true, to: "jev", timeout_ms: 800 }, { id: "r5", type: "cache", on: false, ttl_s: 3600 }] });
export async function loadRouting(env, pid) { const r = await env.DB.prepare("SELECT json FROM routing WHERE project_id = ?").bind(pid).first(); return r ? [JSON.parse(r.json), true] : [defaultRouting(), false]; }
export const saveRouting = (env, pid, cfg) => env.DB.prepare("INSERT INTO routing (project_id, json) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET json = excluded.json").bind(pid, JSON.stringify(cfg)).run();
const endpointsOf = async (env, pid) => Object.fromEntries((await env.DB.prepare("SELECT * FROM endpoints WHERE project_id = ?").bind(pid).all()).results.map(e => [e.id, e]));
// What GET returns: no auth anywhere; endpoint targets carry has_auth.
export function publicRouting(cfg, eps, custom) {
  const targets = Object.fromEntries(Object.entries(cfg.targets).map(([k, v]) => { const t = { ...v }; delete t.auth; delete t.auth_enc; if (k.startsWith("endpoint:")) t.has_auth = !!(eps[k.slice(9)] || {}).auth_enc; return [k, t]; }));
  return { targets, rules: cfg.rules, custom, keep_awake: !!cfg.keep_awake };
}
/** The tiniest request any version can answer; used to wake a model or keep it awake. */
export const PING = { state: "ping", questions: { awake: { type: "noul", instructions: "Is this text the word ping?" } } };
/** Every model whose setup says keep_awake: ping its latest version so the container never sleeps (T4 time is billed while on). */
export async function keepAwake(env) {
  const rows = (await env.DB.prepare(`SELECT s.project_id FROM setups s WHERE s.version = (SELECT MAX(version) FROM setups x WHERE x.project_id = s.project_id) AND s.json LIKE '%"keep_awake":true%'`).all()).results;
  for (const r of rows) {
    try {
      const ms = await modelsOf(env, r.project_id), v = currentVersion(ms); if (!v) continue;
      const m = ms.find(x => x.version === v); await predict(env, { project: r.project_id, version: v, items: [PING], dedicated: true }, m && m.base); await noteAwake(env, r.project_id);
      await chargeServing(env, r.project_id, containerOf((m && m.base) || "laya", r.project_id, v), "T4", 600, "keep awake");   // kept up on purpose: billed
    } catch (e) { console.log("keep-awake " + r.project_id + ": " + e.message); }
  }
  return rows.length;
}
export const kind = t => t.startsWith("endpoint:") ? "endpoint" : t;
const num = x => typeof x === "number" && isFinite(x);
// → [error, cfg]
export function validate(b) {
  const targets = b && b.targets, rules = b && b.rules;
  if (!targets || typeof targets !== "object" || Array.isArray(targets) || !Array.isArray(rules)) return ["targets (object) and rules (list) are required", null];
  const out = {}, keep_awake = b.keep_awake === true;
  for (const [k, v0] of Object.entries(targets)) {
    if (!v0 || typeof v0 !== "object" || typeof v0.on !== "boolean") return [`target ${k} needs on: true|false`, null];
    const v = { ...v0 }; delete v.auth; delete v.auth_enc; delete v.has_auth;
    if (k === "model" && (v.version ?? "latest") !== "latest" && !(Number.isInteger(v.version) && v.version > 0)) return ['model.version must be "latest" or a positive integer', null];
    if (k.startsWith("endpoint:")) { if (!String(v.url || "").startsWith("https://")) return [`${k} needs an https url`, null]; }
    else if (k !== "jev" && k !== "model") return [`unknown target ${k} (jev, model, endpoint:<id>)`, null];
    out[k] = v;
  }
  const ids = new Set(), rs = [];
  for (const r0 of rules) {
    if (!r0 || typeof r0 !== "object" || !TYPES.includes(r0.type)) return [`each rule needs a type in ${JSON.stringify([...TYPES].sort())}`, null];
    if (!r0.id || ids.has(r0.id)) return ["each rule needs a unique id", null];
    const r = { ...r0 }; if (r.on === undefined) r.on = true; ids.add(r.id); rs.push(r); if (!r.on) continue;
    const t = r.type, on = new Set(Object.keys(out).filter(k => out[k].on));
    if (t === "split") { const w = r.weights || {};
      if (Object.keys(w).some(k => !out[k]) || Object.values(w).some(x => !num(x) || x < 0)) return ["split weights must be non-negative numbers over known targets", null];
      if (Math.round(Object.entries(w).filter(([k]) => on.has(k)).reduce((s, [, x]) => s + x, 0) * 1e6) / 1e6 !== 100) return ["split weights over targets that are on must sum to 100", null]; }
    if (t === "confidence_gate" && (!num(r.below) || !(r.below > 0 && r.below <= 1) || !out[r.ask])) return ["confidence_gate needs below in (0, 1] and ask: a known target", null];
    if (t === "fallback" && (!out[r.to] || !Number.isInteger(r.timeout_ms ?? 800) || (r.timeout_ms ?? 800) <= 0)) return ["fallback needs to: a known target and timeout_ms > 0", null];
    if (t === "shadow" && (!out[r.target] || !num(r.pct) || r.pct < 0 || r.pct > 100)) return ["shadow needs target: a known target and pct 0..100", null];
    if (t === "cache" && (!num(r.ttl_s) || r.ttl_s <= 0)) return ["cache needs ttl_s > 0", null];
  }
  return [null, { targets: out, rules: rs, keep_awake }];
}
export const rule = (cfg, t) => cfg.rules.find(r => r.on && r.type === t) || null;
const rulesOf = (cfg, t) => cfg.rules.filter(r => r.on && r.type === t);
// (served target, rule id) before gates and fallbacks. avail: targets that can answer now.
export function pick(cfg, avail, rnd, xtarget) {
  const h = rule(cfg, "header"); if (h && xtarget && avail.includes(xtarget)) return [xtarget, h.id];
  const s = rule(cfg, "split");
  if (s) { const w = Object.entries(s.weights || {}).filter(([k, v]) => avail.includes(k) && v > 0);
    if (w.length) { let x = rnd() * w.reduce((a, [, v]) => a + v, 0); for (const [k, v] of w) { x -= v; if (x < 0) return [k, s.id]; } return [w[w.length - 1][0], s.id]; } }
  return [avail.includes("jev") ? "jev" : avail[0] || "jev", "default"];
}
export const shadows = (cfg, avail, served, rnd) => rulesOf(cfg, "shadow").filter(r => avail.includes(r.target) && r.target !== served && rnd() * 100 < r.pct).map(r => r.target);
export const minConf = answers => { const v = Object.values(answers || {}); return v.length ? Math.min(...v.map(topP)) : 1; };

export function preview(cfg, rows, avail) {
  const rnd = seeded(0), by = {}, sh = {}, costs = [], lat = [], sample = [], g = rule(cfg, "confidence_gate");
  for (const r of rows) {
    let [served, rid] = pick(cfg, avail, rnd); const ran = [served];
    if (g && avail.includes(g.ask) && g.ask !== served && minConf(r.answers[served] || r.answers.jev) < g.below) { served = g.ask; rid = g.id; ran.push(served); }
    for (const t of shadows(cfg, avail, served, rnd)) { sh[t] = (sh[t] || 0) + 1; if (!ran.includes(t)) ran.push(t); }
    by[served] = (by[served] || 0) + 1;
    costs.push(ran.reduce((s, t) => s + (t === "jev" ? COST.jev * (((r.usage || {}).input_tokens) || JEV_TOKENS) : COST[kind(t)]), 0));
    lat.push(ran.slice(0, ran.length > 1 && g && rid === g.id ? 2 : 1).reduce((s, t) => s + (((r.ms || {})[t]) || LATENCY[kind(t)]), 0));
    if (sample.length < 20) sample.push({ id: r.id, served, rule: rid });
  }
  const n = rows.length, l = lat.slice().sort((a, b) => a - b), med = !l.length ? null : l.length % 2 ? l[(l.length - 1) / 2] : (l[l.length / 2 - 1] + l[l.length / 2]) / 2;
  return { n, by_target: by, shadow_by_target: sh, est_cost_per_1000: n ? Math.round(costs.reduce((a, b) => a + b, 0) / n * 1000 * 1e4) / 1e4 : 0, est_p50_ms: med === null ? null : Math.round(med), sample };
}
// Targets that can answer: on, the model only with a ready version (the pinned one if pinned), endpoints only if still registered.
export function available(cfg, ready, eps) {
  return Object.entries(cfg.targets).filter(([k, v]) => v.on && (k !== "model" || (v.version && v.version !== "latest" ? ready.includes(v.version) : ready.length)) && (!k.startsWith("endpoint:") || (eps[k.slice(9)] && v.url))).map(([k]) => k);
}

// ---- serving
// The model's container stays up IDLE_S after its last answer (Modal scaledown_window on Predict) and takes ~WAKE_S to
// come back; "awake" is remembered here so the Use page can say which it is, and the wake button can warm it on purpose.
export const WAKE_S = 90, IDLE_S = 120, WAKE_TYPICAL_S = 40;   // shared box: sleeps 2 min after the last request (Modal scaledown_window on Shared); measured cold start 40 s, warm 0.7 s
/** Remembers the model is awake for IDLE_S. Serving is metered per container awake window in answer.js ask() (ledger.js chargeServing:
    a wake pays the idle window, an awake container pays only the time it adds), skipped for models with a hosting subscription. */
export async function noteAwake(env, pid) {
  const now = secs();
  await cachePut(env, "awake:" + pid, { t: now, until: now + IDLE_S }, IDLE_S);
}
export async function servingOf(env, pid) { const a = await cacheGet(env, "awake:" + pid); return { awake: !!a, since: a ? a.t : null, wake_seconds: WAKE_TYPICAL_S, idle_minutes: IDLE_S / 60 }; }
const timeout = (p, s) => Promise.race([p, new Promise(r => setTimeout(() => r({ ok: false, code: 504, raw: '{"error": "timed out"}', ms: Math.round(s * 1000), timedOut: true }), s * 1000))]);
async function cacheGet(env, k) { const r = await env.DB.prepare("SELECT value_json FROM cache WHERE key = ? AND expires > ?").bind(k, secs()).first(); return r && JSON.parse(r.value_json); }
const cachePut = (env, k, v, ttl) => env.DB.batch([env.DB.prepare("INSERT OR REPLACE INTO cache (key, value_json, expires) VALUES (?,?,?)").bind(k, JSON.stringify(v), secs() + ttl), env.DB.prepare("DELETE FROM cache WHERE expires < ?").bind(secs())]);

const answererName = upstreamName;
// every upstream id a route names (steps, splits, background)
const route_ids = r => [...(r.steps || []).flatMap(st => [st.ask, ...Object.keys(st.split || {})]), ...(r.background || []).map(g => g.ask), ...(r.oracle || [])].filter(Boolean);
/** {project id → hostingOf} for the models on our GPUs those ids stand for. Only for answerers that could answer right now (a trained
    version exists, an open base is deployed): a route whose "model" has no version yet costs nothing here. The answer is kept per
    account for HOSTING_MS in this isolate, like the key context: a balance that changed a few seconds ago can't veto a request. */
const HOSTING_MS = 10000, hostingCache = new Map();
async function hostingFor(env, A, ws, ids) {
  const pids = new Set(), probe = { ...A, hosting: null };   // whyNot without a hosting verdict: is there anything to check at all?
  for (const id of ids) { const a = resolveAnswerer(A.setup, id); if (a && (a.kind === "version" || a.kind === "open") && !whyNot(probe, id)) pids.add(a.kind === "version" && a.project ? a.project : A.pr.id); }
  if (!pids.size) return {};
  const wsId = ws.workspace_id || ws.id;
  return Object.fromEntries(await Promise.all([...pids].map(async pid => {
    const k = wsId + "/" + pid, hit = hostingCache.get(k); if (hit && hit.until > Date.now()) return [pid, hit.v];
    const v = await hostingOf(env, wsId, pid); if (hostingCache.size > 500) hostingCache.clear(); hostingCache.set(k, { v, until: Date.now() + HOSTING_MS }); return [pid, v];
  })));
}
const why = (A, st) => st.reason === "slow" ? `no answer within ${Math.round(st.wait / 1000)} s` + (resolveAnswerer(A.setup, st.ask)?.kind === "version" ? " (it may have been asleep)" : "")
  : st.reason === "error" ? `HTTP ${st.code}` : st.reason === "unsure" ? `only ${Math.round(st.conf * 100)}% sure (below ${Math.round(st.below * 100)}%)` : st.why || "it couldn't answer";

// One request for a model: its setup's first matching route decides who answers (steps in order: move on when an answer fails,
// is too slow, or is less sure than the step allows), who else answers in the background, and whose answer is the grounded one.
// Everything that ran lands on one recorded request, with the path it took. opts: {via, source, key, xtarget, noRecord, test, only, compare, meta,
// pre: {setup, conns, projects, models} already read (the proxy reads them in one batch, index.js keyContext)}.
// Latency: nothing is written before the first upstream call or between the answer and the reply; the request is saved right after the reply.
export async function systemone(env, ctx, pr, ws, body, opts = {}) {
  const questions = body.questions, state = body.state, out = (code, raw) => new Response(typeof raw === "string" ? raw : JSON.stringify(raw), { status: code, headers: { "content-type": "application/json" } });
  const [[sid, legacySid], [S, rows]] = await Promise.all([kindIdsFor(pr.tenant, questions), opts.pre ? [opts.pre.setup, opts.pre] : Promise.all([loadSetup(env, pr).then(x => x.setup), rowsOf(env, ws)])]);
  if (env.__mark) env.__mark("pre"); const A = { ...ctxOf(env, pr, ws, S, rows), later: p => ctx.waitUntil(Promise.resolve(p).catch(e => console.log("after reply: " + e.message))) }, ms = A.ms;
  const source = SOURCES.includes(opts.source) ? opts.source : sourceOf({ via: opts.via }), route = routeOf(S, { schema: sid, schemas: [sid, legacySid], via: opts.via, source });
  // hosting: a model on our GPUs (a trained version or an open base) answers only while the account has spendable credit or a
  // subscription for that model (billing.js hostingOf); otherwise whyNot skips it and the next step answers
  A.hosting = await hostingFor(env, A, ws, [...route_ids(route), ...(opts.compare || []), ...(opts.only ? [opts.only] : []), ...(opts.xtarget ? [opts.xtarget] : [])]); if (env.__mark) env.__mark("hosting");
  // Try it: the answerer picked there answers alone (the others it compares with run in the background); a caller may pick one by header when the route allows it
  let steps = route.steps;
  if (opts.only) { const w = whyNot(A, opts.only); if (w) return out(409, { error: `${answererName(A, opts.only)} can't answer: ${w}.` }); steps = [{ ask: opts.only, wait_ms: WAKE_WAIT_MS }]; }
  else if (route.allow_header && opts.xtarget && !whyNot(A, opts.xtarget)) steps = [{ ask: opts.xtarget, wait_ms: Math.max(steps[0].wait_ms, WAKE_WAIT_MS) }, ...steps.slice(1)];
  const ck = route.cache_s && !opts.noRecord ? await sha1(JSON.stringify([sid, state, questions])) : null;
  if (ck) { const hit = await cacheGet(env, ck); if (hit) return out(200, { ...hit[1], understudy: { served: hit[0], route: route.id, path: { route: route.id, steps: [], background: [], served: hit[0], cached: true }, shadow: [], recorded: false } }); }
  const runs = {}, got = {};
  const go = id => runs[id] || (runs[id] = (() => { const x = { settled: false }; x.p = ask(A, id, body, opts.noRecord ? "test" : "traffic").then(r => { x.settled = true; x.r = r; return r; }); return x; })());
  const get = async (id, wait) => (got[id] = await timeout(go(id).p, wait / 1000));
  const path = { route: route.id, steps: [], background: [], served: null };
  let res = null, served = null, best = null, lastFail = null;
  for (const [i, st] of steps.entries()) {
    let id = st.ask;
    if (st.split) { const w = Object.entries(st.split).filter(([k]) => !whyNot(A, k)); let x = Math.random() * w.reduce((s, [, v]) => s + v, 0); id = null; for (const [k, v] of w) { x -= v; if (x < 0) { id = k; break; } } if (!id && w.length) id = w[w.length - 1][0]; }
    const w0 = id ? whyNot(A, id) : "nobody in the split can answer now";
    if (w0) { path.steps.push({ ask: id, ok: false, reason: "skipped", why: w0 }); continue; }
    const r = await get(id, st.wait_ms), conf = r.ok ? minConfOf(r.answers) : null; if (env.__mark) env.__mark("answer:" + id);
    const reason = !r.ok ? (r.timedOut ? "slow" : "error") : st.unsure_below != null && conf < st.unsure_below && i < steps.length - 1 ? "unsure" : null;
    path.steps.push({ ask: id, ok: r.ok, ms: r.ms, ...(r.version ? { v: r.version } : {}), conf: conf == null ? null : Math.round(conf * 1000) / 1000, wait: st.wait_ms, ...(r.ok ? {} : { code: r.code }), ...(reason ? { reason } : {}), ...(reason === "unsure" ? { below: st.unsure_below } : {}) });
    if (r.ok && !reason) { res = r; served = id; break; }
    if (r.ok) best = best || { r, id }; else lastFail = r;
  }
  if (!res && best) { res = best.r; served = best.id; }   // everyone after an unsure answer failed: the unsure answer is better than none
  // nobody answered: say who failed and why, in the caller's terms. An upstream refusing *its* key isn't the caller's Understudy key being wrong.
  if (!res) {
    if (!opts.noRecord) ctx.waitUntil(ensureSet(env, pr, questions).catch(() => {}));   // the kind of request is still noted, as before, off the reply's path
    const tried = path.steps.map(s => `${answererName(A, s.ask)}: ${s.why || why(A, s)}`).join("; "), up = lastFail && (() => { try { const j = JSON.parse(lastFail.raw); return j.error || (j.detail && (j.detail.message || j.detail)) || null; } catch (_) { return String(lastFail.raw || "").slice(0, 200); } })();
    const keyIssue = lastFail && (lastFail.code === 401 || lastFail.code === 403);
    return out(!lastFail ? 503 : keyIssue ? 502 : lastFail.code, { error: (keyIssue ? `An upstream rejected its API key (${tried}). Your Dopp key is fine; update that upstream's key on the Upstreams page.` : `No upstream on this route could answer (${tried}).`) + (up && !/^\s*</.test(String(up)) ? ` It said: ${(typeof up === "string" ? up : JSON.stringify(up)).slice(0, 200)}` : ""), route: route.id, path });
  }
  path.served = served;
  if (resolveAnswerer(S, served)?.kind === "version") ctx.waitUntil(noteAwake(env, pr.id).catch(() => {}));
  if (!opts.noRecord) {
    const bg = new Set([...route.background.filter(g => Math.random() * 100 < g.pct).map(g => g.ask), ...(opts.compare || [])]);
    if (route.fill_pct && Math.random() * 100 < route.fill_pct) bg.add(route.oracle[0]);
    for (const id of bg) if (!runs[id] && !whyNot(A, id)) { go(id); path.background.push(id); }
  }
  const later = Object.keys(runs).filter(id => !got[id] || (!got[id].ok && !runs[id].settled)), done = Object.fromEntries(Object.entries(got).filter(([id]) => !later.includes(id)));
  const resp = { ...res.resp };
  // TypeSafe's own client refuses a choice or score answer without a confidence; Jev and Laya send one, other answerers may not:
  // fill in the top probability so any answerer reads the same to the caller
  if (resp.answers && typeof resp.answers === "object") resp.answers = Object.fromEntries(Object.entries(resp.answers).map(([k, a]) => [k, a && (a.type === "choice" || a.type === "score") && a.confidence == null && a.probabilities ? { ...a, confidence: Math.max(0, ...Object.values(a.probabilities).map(Number).filter(Number.isFinite)) } : a]));
  resp.model = served === "jev" ? resp.model : res.version ? `understudy/${pr.tenant}-v${res.version}` : served;
  if (ck) ctx.waitUntil(cachePut(env, ck, [served, resp], route.cache_s).catch(e => console.log("cache put failed: " + e.message)));
  const first = path.steps[0], fallback = first && served !== first.ask && first.reason ? { from: first.ask, reason: why(A, first) } : null;
  if (env.__mark) env.__mark("built"); const paused = Object.values(A.hosting).find(h => !h.allowed);
  const block = { served, route: route.id, path, shadow: Object.keys(runs).filter(id => id !== served), recorded: !opts.noRecord, ...(fallback ? { fallback } : {}), ...(paused ? { hosting: "paused: " + paused.why } : {}) };
  if (!opts.noRecord) {
    const key = id => storageKey(id, pr.id), ok = Object.fromEntries(Object.entries(done).filter(([, r]) => r.ok)), answers = Object.fromEntries(Object.entries(ok).map(([id, r]) => [key(id), r.answers]));
    for (const [id, r] of Object.entries(ok)) { const vk = versionKey(id, pr.id, r.version); if (vk) answers[vk] = r.answers; }   // each version also keeps its own answers
    const errors = Object.fromEntries(Object.entries(done).filter(([, r]) => !r.ok).map(([id, r]) => [key(id), r.code])), jevRun = ok.jev;
    const id = block.example = newExampleId(sid);   // made now so the reply carries it; the request is saved under it right after
    ctx.waitUntil((async () => {   // after the reply, in order: the kind of request, its wording, the request; then naming, suggestions, background answers, auto-train
      const set = await ensureSet(env, pr, questions);
      if (Object.keys(answers).length) await noteWording(env, set, questions);
      const rec = await record(env, pr, set.id, { id, state, source, via: opts.via, answers, served: key(served), ms: Object.fromEntries(Object.entries(done).map(([id, r]) => [key(id), r.ms])), route: route.id, oracle: route.oracle,
        extra: { v: res.version || currentVersion(ms) || null, route: route.id, path, usage: jevRun ? jevRun.resp.usage || null : null, ...(Object.keys(errors).length ? { errors } : {}), ...(fallback ? { fallback } : {}), ...(isChunks(set) ? { questions } : {}) }, meta: opts.meta });
      const side = [];
      if (rec.line === 0) side.push(describeFromTraffic(env, pr, set, state).catch(e => console.log("naming failed: " + e.message)));   // first request: name/keywords from what the client actually sends
      if (rec.line === 2 && !set.suggestions) side.push(suggestFor(env, ws, pr, set.id).catch(e => console.log("suggest failed: " + e.message)));   // third real request: look for datasets like this, once
      await (async () => {
        if (later.length) {   // background answers (and slow steps) finish after the reply, then land on the same request; one may become its grounded answer
          const fin = Object.fromEntries(await Promise.all(later.map(async id => [id, await timeout(runs[id].p, 25)])));   // waitUntil gets ~30 s: a slower one is recorded as timed out
          const okl = Object.fromEntries(Object.entries(fin).filter(([, r]) => r.ok).flatMap(([id, r]) => [[key(id), r.answers], ...(versionKey(id, pr.id, r.version) ? [[versionKey(id, pr.id, r.version), r.answers]] : [])]));
          await addShadow(env, rec.id, okl, Object.fromEntries(Object.entries(fin).map(([id, r]) => [key(id), r.ms])), route.oracle, pr.id);
        }
        await autoTrain(env, pr);
      })().catch(e => console.log(`background/auto-train for ${rec.id} failed: ${e.message}`));
      await Promise.all(side);
    })().catch(e => console.log(`saving request ${id} failed: ${e.message}`)));
  }
  return out(200, { ...resp, understudy: block });
}
