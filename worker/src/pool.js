/* v4 API: routes, the upstream catalog, one request pool across every route with filters and batch actions,
   and trained models (usable as an upstream on any route). Signed-in; everything is scoped to the account's routes. */
import { json, err, now, short, rand, sha256, baseReady, engineHasBase, familyOf, BASES, OPEN_BASES } from "./lib.js";
import { answerOf, topP, exampleOut, correctionsOf, LABELLED, setsOf, questionsOfRow, addShadow, removeExamples, freshSetup, modelsOf, pollTraining, startTraining, trainEstimate, secs, SOURCES } from "./data.js";
import { pool } from "./lib.js";
import { loadSetup, saveSetup, reground, storageKey, versionKey, connectionsOf, presetsFor } from "./setup.js";
import { answerCtx, ask, whyNot, upstreamName } from "./answer.js";
import { parseLlm, llmWhyNot, openrouterModels, perThousand, geminiModels, searchUpstreams, pinUpstream, addProviderKey } from "./upstreams.js";
import { projectsOf } from "./projects.js";
import { webState } from "./files.js";

const J = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch (_) { return d; } };
const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const r4 = x => Math.round(x * 1e4) / 1e4;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// ---- the catalog
/** Where a request stores an upstream's answers: a route's own model under "model", another route's model under "model:<route>". */
const keyFor = (id, pid) => storageKey(id, pid);
/** The id a stored answers key shows as in the pool (a route's own "model" → "model:<route>"). */
const shownKey = (k, pid) => k === "model" ? "model:" + pid : /^model@\d+$/.test(k) ? `model:${pid}${k.slice(5)}` : k;
export async function catalogOf(env, ws) {
  const margin = +(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1), [conns, projects, models, rows, llmCharges] = await Promise.all([connectionsOf(env, ws),
    env.DB.prepare("SELECT id, name FROM projects WHERE workspace_id = ? ORDER BY created_at").bind(ws.id).all().then(r => r.results),
    env.DB.prepare("SELECT m.* FROM models m JOIN projects p ON p.id = m.project_id WHERE p.workspace_id = ? ORDER BY m.project_id, m.version").bind(ws.id).all().then(r => r.results),
    env.DB.prepare("SELECT e.project_id, e.ms_json, e.extra_json FROM examples e JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = ? ORDER BY e.t DESC LIMIT 2000").bind(ws.id).all().then(r => r.results),
    env.DB.prepare("SELECT c.note, COUNT(*) n, SUM(c.usd) usd FROM charges c JOIN projects p ON p.id = c.project_id WHERE p.workspace_id = ? AND c.note LIKE 'llm:%' GROUP BY c.note").bind(ws.id).all().then(r => r.results)]);
  const msBy = {}, tok = [];
  for (const r of rows) { for (const [k, v] of Object.entries(J(r.ms_json, {}) || {})) (msBy[shownKey(k, r.project_id)] || (msBy[shownKey(k, r.project_id)] = [])).push(v); const u = (J(r.extra_json, {}) || {}).usage; if (u && u.input_tokens) tok.push((+u.input_tokens || 0) + (+u.output_tokens || 0)); }
  const p50 = id => { const m = med(msBy[id] || []); return { p50_ms: m == null ? null : Math.round(m), measured_ms: m != null }; };
  const ours = !(ws.jev_mode === "own" && ws.ts_key_enc), out = [];
  out.push({ id: "jev", answers_key: "jev", name: "Jev", kind: "jev", provider: "Jev", key: ours ? "ours" : "yours", ready: true, why_not: null, jevbench: 63.3,
    ...(ours ? { per_1000_usd: r4((tok.length ? med(tok) : 600) * (+(env.JEV_PRICE_IN || 0.042)) / 1e6 * 1000 * margin), price_basis: tok.length ? "measured" : "list", price_note: null } : { per_1000_usd: null, price_basis: null, price_note: "billed to your TypeSafe account" }), ...p50("jev") });
  const connById = Object.fromEntries(conns.rows.map(c => [c.id, c])), orOwn = conns.rows.some(c => c.kind === "openrouter");
  let orList = []; try { orList = await openrouterModels(env); } catch (_) { /* list prices are optional */ }
  const llms = [...new Set([...conns.pins, ...(env.GEN_API_KEY ? geminiModels(env).map(m => "llm:gemini/" + m) : [])])];
  for (const id of llms) {
    const l = parseLlm(id); if (!l) continue; const why = llmWhyNot(env, connById, l), measured = llmCharges.find(c => c.note === id);
    const listed = l.provider === "openrouter" ? orList.find(m => m.slug === l.model) : null;
    const listPrice = l.provider === "gemini" ? r4((600 * (+(env.GEN_PRICE_IN || 0.10)) + 60 * (+(env.GEN_PRICE_OUT || 0.40))) / 1e6 * 1000 * margin) : listed ? r4(perThousand(listed) * margin) : null;
    const key = l.provider === "gemini" ? "ours" : l.provider === "openrouter" ? (orOwn ? "yours" : env.OPENROUTER_API_KEY ? "ours" : "yours") : "yours";
    out.push({ id, answers_key: id, name: l.provider === "openrouter" ? (listed ? listed.name : l.model) : l.provider === "gemini" ? l.model + " (Gemini)" : l.model + " (" + ((connById[l.conn] || {}).name || "OpenAI-compatible") + ")",
      kind: "llm", provider: l.provider === "openrouter" ? "OpenRouter" : l.provider === "gemini" ? "Gemini" : "OpenAI-compatible", key, ready: !why, why_not: why, pinned: conns.pins.includes(id),
      per_1000_usd: key === "yours" ? null : measured && measured.n >= 5 ? r4(measured.usd / measured.n * 1000 * margin) : listPrice, price_basis: key === "yours" ? null : measured && measured.n >= 5 ? "measured" : listPrice != null ? "list" : null,
      price_note: key === "yours" ? "billed to your " + (l.provider === "openrouter" ? "OpenRouter" : "provider") + " account" : null, ...p50(id) });
  }
  for (const c of conns.rows.filter(c => c.kind === "systemone")) out.push({ id: "endpoint:" + c.id, answers_key: "endpoint:" + c.id, name: c.name, kind: "url", provider: "Service", key: c.auth_enc ? "yours" : "none", ready: true, why_not: null, url: c.url, per_1000_usd: null, price_basis: null, price_note: "billed by that service", ...p50("endpoint:" + c.id) });
  const rate = { T4: 0.59, L4: 0.80, A10G: 1.10 };
  for (const [b, info] of Object.entries(OPEN_BASES)) out.push({ id: "open:" + b, answers_key: "open:" + b, name: `${info.name} (open)`, kind: "open", provider: "Open model", key: "ours", ready: baseReady(env, b),
    why_not: baseReady(env, b) ? null : "its engine isn't deployed on this server yet", repo: info.repo, license: info.license, jevbench: info.jevbench ?? null, note: info.note, trainable: !!BASES[b], runs_in_browser: b === "laya",
    per_1000_usd: null, price_basis: null, per_hour_usd: Math.round(rate[info.gpu] * margin * 100) / 100, wake_usd: Math.round(rate[info.gpu] * margin / 6 * 100) / 100, price_note: `GPU time (${info.gpu}): about $${(rate[info.gpu] * margin / 6).toFixed(2)} each time it wakes, then $${(rate[info.gpu] * margin).toFixed(2)} an hour while it answers`, ...p50("open:" + b) });
  const names = Object.fromEntries(projects.map(p => [p.id, p.name])), used = await usedBy(env, projects);
  for (const p of projects) {
    const ready = models.filter(m => m.project_id === p.id && m.status === "ready"); if (!ready.length) continue;
    const base = { kind: "model", provider: "Dopp", key: "none", ready: true, why_not: null, route: p.id, route_name: names[p.id], per_1000_usd: null, price_basis: null, price_note: "server time isn't metered yet", answers_key: "model:" + p.id, ...p50("model:" + p.id) };
    const top = ready[ready.length - 1];
    out.push({ ...base, id: `model:${p.id}@latest`, name: `${names[p.id]} v${top.version}`, latest: true, version: top.version, base: top.base || "laya", trained_rows: top.trained_rows, holdout_agreement: J(top.holdout_agreement_json), used_by: used[`model:${p.id}`] || [] });
    for (const m of ready.slice(0, -1).reverse()) out.push({ ...base, answers_key: `model:${p.id}@${m.version}`, id: `model:${p.id}@${m.version}`, name: `${names[p.id]} v${m.version}`, latest: false, version: m.version, base: m.base || "laya", trained_rows: m.trained_rows, holdout_agreement: J(m.holdout_agreement_json), used_by: [] });
  }
  const providers = [{ id: "jev", name: "Jev", connected: true, key_owner: ours ? "ours" : "yours" }, { id: "openrouter", name: "OpenRouter", connected: orOwn || !!env.OPENROUTER_API_KEY, key_owner: orOwn ? "yours" : env.OPENROUTER_API_KEY ? "ours" : null },
    { id: "gemini", name: "Gemini", connected: !!env.GEN_API_KEY, key_owner: env.GEN_API_KEY ? "ours" : null }, ...conns.rows.filter(c => c.kind === "openai").map(c => ({ id: "openai:" + c.id, name: c.name, connected: true, key_owner: "yours" }))];
  return { upstreams: out, providers };
}
/** Which routes' setups use each route's model (in any route step, background or oracle). → {"model:<route>": [route ids]} */
async function usedBy(env, projects) {
  const out = {};
  for (const p of projects) {
    const s = await env.DB.prepare("SELECT json FROM setups WHERE project_id = ? ORDER BY version DESC LIMIT 1").bind(p.id).first(); if (!s) continue;
    const txt = s.json;
    for (const q of projects) if (txt.includes(`"model:${q.id}@`) || (q.id === p.id && /"(ask|oracle)":\s*\[?[^\]]*"model"/.test(txt))) (out["model:" + q.id] || (out["model:" + q.id] = [])).push(p.id);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
  return out;
}

// ---- routes (the records are "projects")
async function routeSummary(env, ws, pr, S, cat) {
  const name = id => { if (id === "model" || /^model@\d+$/.test(id)) { const u = cat.upstreams.find(x => x.id === `model:${pr.id}@latest`); return u ? u.name : `${pr.name} (no trained version yet)`; }
    const u = cat.upstreams.find(x => x.id === id || x.answers_key === id); return u ? u.name : id; };
  const r = S.routes[S.routes.length === 1 ? 0 : 0], steps = r.steps.map((s, i) => (s.split ? Object.keys(s.split).map(name).join(" / ") : name(s.ask)) + (i < r.steps.length - 1 ? (s.unsure_below != null ? ` → below ${Math.round(s.unsure_below * 100)}%` : " → if it fails") : ""));
  return { upstream: r.steps[0].ask || Object.keys(r.steps[0].split || {})[0] || null, upstream_name: name(r.steps[0].ask || Object.keys(r.steps[0].split || {})[0] || ""), setup_summary: steps.join(" → ") + (S.routes.length > 1 ? ` (+${S.routes.length - 1} more route${S.routes.length > 2 ? "s" : ""})` : "") };
}
export async function listRoutes(env, ws, origin) {
  const prs = await projectsOf(env, ws); if (!prs.length) return { routes: [], url: origin + "/v1/systemone" };
  const cat = await catalogOf(env, ws), day = secs() - 86400, margin = +(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1), ids = prs.map(p => p.id), ph = ids.map(() => "?").join(",");
  const [counts, costs, keys] = await Promise.all([
    env.DB.prepare(`SELECT project_id, COUNT(*) n, SUM(CASE WHEN t >= ? THEN 1 ELSE 0 END) d FROM examples WHERE project_id IN (${ph}) GROUP BY project_id`).bind(day, ...ids).all().then(r => r.results),
    env.DB.prepare(`SELECT project_id, SUM(usd) usd FROM charges WHERE t >= ? AND COALESCE(billed, 1) = 1 AND project_id IN (${ph}) GROUP BY project_id`).bind(day, ...ids).all().then(r => r.results),
    env.DB.prepare("SELECT id, prefix, project_id, last_used_at, revoked_at, created_at FROM proxy_keys WHERE workspace_id = ? ORDER BY created_at DESC").bind(ws.id).all().then(r => r.results)]);
  const routes = [];
  for (const [i, p] of prs.entries()) {
    const S = (await loadSetup(env, p)).setup, sum = await routeSummary(env, ws, p, S, cat), c = counts.find(x => x.project_id === p.id) || {}, u = cat.upstreams.find(x => x.id === `model:${p.id}@latest`);
    routes.push({ id: p.id, name: p.name, created_at: p.created_at, ...sum, requests_24h: c.d || 0, requests_total: c.n || 0, cost_24h_usd: Math.round(((costs.find(x => x.project_id === p.id) || {}).usd || 0) * margin * 1e6) / 1e6,
      keys: keys.filter(k => k.project_id === p.id || (i === 0 && !k.project_id)).map(k => ({ id: k.id, prefix: k.prefix, last_used_at: k.last_used_at, revoked_at: k.revoked_at, created_at: k.created_at })), latest_model: u ? { id: u.id, name: u.name } : null });
  }
  return { routes, url: origin + "/v1/systemone" };
}
const PRESET_ALIAS = { jev_only: "only", jev_learn: "learn", llm_start: "learn" };
export async function createRoute(env, ws, b, user) {
  const prs = await projectsOf(env, ws), id = short(), name = String(b.name || "").trim().slice(0, 60) || "Route " + (prs.length + 1);
  if (b.upstream) { const cat0 = await catalogOf(env, ws), u = cat0.upstreams.find(x => x.id === b.upstream); if (!u) return [400, { error: "That upstream isn't in your catalog. Pick one from the list." }]; if (!u.ready) return [400, { error: `${u.name} can't answer yet: ${u.why_not}.` }]; }
  if (b.labels && b.labels !== "you" && !(await catalogOf(env, ws)).upstreams.find(x => x.id === b.labels)) return [400, { error: "The labels have to come from you or an upstream in your catalog." }];
  const pr = { id, workspace_id: ws.id, name, description: null, tags_json: "[]", keywords_json: "[]", tenant: ws.id + "_" + id, created_at: now(), settings_json: "{}" };
  await env.DB.prepare("INSERT INTO projects (id, workspace_id, name, description, tags_json, keywords_json, tenant, created_at, settings_json) VALUES (?,?,?,?,?,?,?,?,?)").bind(pr.id, pr.workspace_id, pr.name, null, "[]", "[]", pr.tenant, pr.created_at, "{}").run();
  // who labels: you (your fixes) unless the caller names an upstream from the catalog ({labels: "<upstream id>"})
  const cat = await catalogOf(env, ws), U = b.upstream || "jev", L = b.labels && b.labels !== "you" ? b.labels : null;
  const base = (await loadSetup(env, pr)).setup, nm = id => (cat.upstreams.find(x => x.id === id) || {}).name, presets = presetsFor(base, [], U, nm(U) || "Jev", L, L ? nm(L) : null), want = PRESET_ALIAS[b.preset] || b.preset || "learn", p = presets.find(x => x.id === want) || presets.find(x => x.id === "learn");
  // "<upstream> only" promises that nothing else runs until asked: its plans don't train by themselves (a Train press still works)
  const setup = want === "only" ? { ...p.setup, plans: p.setup.plans.map(x => ({ ...x, auto: null })) } : p.setup;
  const saved = await saveSetup(env, pr, setup, user.email, `Created as "${p.name}"`);
  const key = "us_" + rand(20);
  await env.DB.prepare("INSERT INTO proxy_keys (id, key_hash, workspace_id, prefix, created_at, project_id) VALUES (?,?,?,?,?,?)").bind(short(), await sha256(key), ws.id, key.slice(0, 8), now(), pr.id).run();
  return [200, { route: { id: pr.id, name: pr.name, created_at: pr.created_at }, key, setup: saved }];
}

/** Delete a route and everything recorded on it. A route with requests needs its name typed back ({confirm: name}). */
export async function deleteRoute(env, ws, id, b) {
  const prs = await projectsOf(env, ws), pr = prs.find(p => p.id === id); if (!pr) return [404, { error: "No such route." }];
  const n = (await env.DB.prepare("SELECT COUNT(*) n FROM examples WHERE project_id = ?").bind(id).first()).n;
  if (n && String(b.confirm || "") !== pr.name) return [400, { error: `${pr.name} has ${n} request${n === 1 ? "" : "s"}. Type its name to delete it and ${n === 1 ? "that request" : "them"}.`, requests: n }];
  await env.DB.batch([env.DB.prepare("DELETE FROM corrections WHERE example_id IN (SELECT id FROM examples WHERE project_id = ?)").bind(id), env.DB.prepare("DELETE FROM examples WHERE project_id = ?").bind(id),
    env.DB.prepare("DELETE FROM question_sets WHERE project_id = ?").bind(id), env.DB.prepare("DELETE FROM setups WHERE project_id = ?").bind(id), env.DB.prepare("DELETE FROM routing WHERE project_id = ?").bind(id),
    env.DB.prepare("DELETE FROM request_log WHERE project_id = ?").bind(id), env.DB.prepare("UPDATE proxy_keys SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL").bind(now(), id),
    env.DB.prepare("DELETE FROM projects WHERE id = ? AND workspace_id = ?").bind(id, ws.id)]);
  return [200, { ok: true, removed_requests: n }];
}

// ---- the request pool
/** A filter (from a query string or a POST body) → SQL over examples e (and a check that needs the answers). */
export function filterOf(src) {
  const get = k => { const v = src instanceof URLSearchParams ? src.get(k) : src ? src[k] : null; return v === null || v === undefined || v === "" ? null : v; };
  const all = k => src instanceof URLSearchParams ? src.getAll(k).flatMap(x => x.split(",")).filter(Boolean) : (Array.isArray(src && src[k]) ? src[k] : src && src[k] ? [src[k]] : []).map(String);
  return { route: all("route"), kind: get("kind"), source: get("source"), key: get("key"), answered_by: get("answered_by"), missing: get("missing"), labelled: get("labelled"), labels_from: get("labels_from"),
    disagree: get("disagree"), maxp: get("maxp") == null ? null : +get("maxp"), q: get("q"), since: get("since") == null ? null : +get("since"), until: get("until") == null ? null : +get("until"), holdout: get("holdout"), left_out: get("left_out") };
}
// has an answer from upstream X (a model's answers sit under "model" on its own route, "model:<route>" elsewhere)
function hasSql(x) {
  const m = /^model:([0-9a-f]{8})(?:@(\d+))?$/.exec(x);
  const p = k => `NULLIF(json_extract(e.answers_json, '$."${k.replace(/["\\]/g, "")}"'), '{}') IS NOT NULL`;
  if (m && m[2]) return `((e.project_id = '${m[1]}' AND ${p("model@" + m[2])}) OR ${p(`model:${m[1]}@${m[2]}`)})`;   // one version: its own slot
  return m ? `((e.project_id = '${m[1]}' AND ${p("model")}) OR ${p("model:" + m[1])})` : p(x.startsWith("url:") ? "endpoint:" + x.slice(4) : x);
}
function whereOf(f, routeIds) {
  const w = [], b = [], ids = f.route.length ? f.route.filter(r => routeIds.includes(r)) : routeIds;
  w.push(`e.project_id IN (${ids.map(() => "?").join(",") || "''"})`); b.push(...ids);
  if (f.kind) { w.push("e.schema_id = ?"); b.push(f.kind); }
  if (f.source && SOURCES.includes(f.source)) { w.push("e.source = ?"); b.push(f.source); }
  if (f.key) { w.push("e.via LIKE ?"); b.push("key " + String(f.key).replace(/^key\s+/, "").replace(/[%_]/g, "") + "%"); }
  if (f.answered_by) w.push(hasSql(f.answered_by));
  if (f.missing) w.push("NOT " + hasSql(f.missing));
  if (f.labelled === "1") w.push(LABELLED("e.")); else if (f.labelled === "0") w.push("NOT " + LABELLED("e."));
  if (f.labels_from) { const m = /^model:([0-9a-f]{8})/.exec(f.labels_from); if (m) { w.push("((e.project_id = ? AND e.grounded_by = 'model') OR e.grounded_by = ?)"); b.push(m[1], "model:" + m[1]); } else { w.push("e.grounded_by = ?"); b.push(f.labels_from); } }
  if (f.q) { w.push("e.state_json LIKE ? ESCAPE '\\'"); b.push("%" + String(f.q).replace(/[\\%_]/g, c => "\\" + c) + "%"); }
  if (f.since) { w.push("e.t >= ?"); b.push(f.since); }
  if (f.until) { w.push("e.t <= ?"); b.push(f.until); }
  if (f.holdout === "1" || f.holdout === "0") { w.push("e.holdout = ?"); b.push(+f.holdout); }
  // left out of training: the realism check's or a person's exclusion (a correction on qid __all__ = __skip__; a person's include writes null)
  if (f.left_out === "1" || f.left_out === "0") w.push(`${f.left_out === "0" ? "NOT " : ""}EXISTS (SELECT 1 FROM corrections c WHERE c.example_id = e.id AND c.qid = '__all__' AND c.label_json = '"__skip__"')`);
  return [w.join(" AND "), b];
}
/** The answers-level part of a filter (disagreement, least sure), checked per row. */
function postOf(f, sets) {
  if (!f.disagree && f.maxp == null) return null;
  const [a, b2] = f.disagree ? String(f.disagree).split(",") : [];
  return r => {
    const s = sets[r.schema_id]; if (!s) return false; const ans = J(r.answers_json, {}), q = questionsOfRow(s, r), pick = x => ans[keyFor(x, r.project_id)] || ans[x];
    if (f.disagree) { const A = pick(a), B = pick(b2); if (!A || !B || !Object.keys(q).some(k => A[k] && B[k] && answerOf(q[k], A[k]) !== answerOf(q[k], B[k]))) return false; }
    if (f.maxp != null) { const g = J(r.grounded_json, null) || ans[r.served] || {}; if (!Object.keys(q).some(k => g[k] && topP(g[k]) <= f.maxp)) return false; }
    return true;
  };
}
const routesOf = async (env, ws) => (await projectsOf(env, ws));
async function setsFor(env, prs) { const out = {}; for (const p of prs) for (const s of await setsOf(env, p.id)) out[s.id] = s; return out; }
async function kindNames(env, ws, sets) { const meta = Object.fromEntries((await env.DB.prepare("SELECT schema_id, name FROM schema_meta WHERE workspace_id = ?").bind(ws.id).all()).results.map(x => [x.schema_id, x.name]));
  return id => { const s = sets[id]; if (!s) return id; return meta[id] || (s.plan && s.plan.name) || (s.shape && s.shape.kind === "chunks" ? "Words → " + (Array.isArray(s.shape.criteria) ? s.shape.criteria : Object.keys(s.shape.criteria || {})).slice(0, 3).join(" / ") : Object.keys(s.q).join(", ")); }; }
/** The rows a filter (or explicit ids) selects: [{id, project_id, …light}], capped. */
async function selectRows(env, ws, prs, sets, sel, cap = 5000) {
  const routeIds = prs.map(p => p.id);
  if (Array.isArray(sel.ids)) { const out = []; for (const c of chunk(sel.ids.map(String).slice(0, cap), 90)) out.push(...(await env.DB.prepare(`SELECT e.id, e.project_id, e.schema_id, e.answers_json, e.grounded_json, e.served, e.extra_json FROM examples e WHERE e.id IN (${c.map(() => "?").join(",")})`).bind(...c).all()).results); return out.filter(r => routeIds.includes(r.project_id)); }
  const f = filterOf(sel.filter || {}), [w, b] = whereOf(f, routeIds), post = postOf(f, sets);
  const rows = (await env.DB.prepare(`SELECT e.id, e.project_id, e.schema_id, e.answers_json, e.grounded_json, e.served, e.extra_json FROM examples e WHERE ${w} ORDER BY e.t DESC LIMIT ?`).bind(...b, cap).all()).results;
  return post ? rows.filter(post) : rows;
}
async function reqsOut(env, ws, prs, sets, rows) {
  const names = Object.fromEntries(prs.map(p => [p.id, p.name])), kn = await kindNames(env, ws, sets), corr = {};
  for (const c of chunk(rows.map(r => r.id), 90)) for (const x of (await env.DB.prepare(`SELECT * FROM corrections WHERE label_json IS NOT NULL AND example_id IN (${c.map(() => "?").join(",")})`).bind(...c).all()).results) (corr[x.example_id] || (corr[x.example_id] = {}))[x.qid] = { label: J(x.label_json), by: x.by, t: x.t };
  // how long the caller waited end to end (request_log.e2e_ms), which a fallback makes longer than the answerer's own time
  const waited = {};
  try { for (const c of chunk(rows.filter(r => r.source === "traffic").map(r => r.id), 90)) for (const x of (await env.DB.prepare(`SELECT example_id, e2e_ms FROM request_log WHERE e2e_ms IS NOT NULL AND example_id IN (${c.map(() => "?").join(",")})`).bind(...c).all()).results) waited[x.example_id] = x.e2e_ms; } catch (_) { /* before migration 0025 */ }
  return rows.map(r => { const s = sets[r.schema_id] || { q: {}, shape: { kind: "fixed" } }, o = exampleOut(s, r, corr[r.id] || {}), q = o.question_defs || s.q;
    return { id: r.id, route: r.project_id, route_name: names[r.project_id], kind: r.schema_id, kind_name: kn(r.schema_id), t: r.t, source: r.source, via: r.via, state: o.state, questions: q, v: o.v,
      served: o.served ? shownKey(o.served, r.project_id) : null, ms: Object.fromEntries(Object.entries(o.ms || {}).map(([k, v]) => [shownKey(k, r.project_id), v])), path: o.path, errors: o.errors, waited_ms: waited[r.id] ?? null,
      answers: Object.fromEntries(Object.entries(o.answers || {}).map(([k, v]) => [shownKey(k, r.project_id), v])), labels_from: r.grounded_by ? shownKey(r.grounded_by, r.project_id) : null, labels_pinned: !!r.grounded_pinned,
      labels: o.grounded, corrections: o.corrections, excluded: o.excluded, left_out: o.left_out, holdout: o.holdout, ...(o.pending_label ? { pending_label: o.pending_label } : {}), ...(o.chunks ? { chunks: o.chunks } : {}) }; });
}
export async function listPool(env, ws, qp) {
  const prs = await routesOf(env, ws); for (const p of prs) await freshSetup(env, p);
  const sets = await setsFor(env, prs), f = filterOf(qp), [w, b] = whereOf(f, prs.map(p => p.id)), post = postOf(f, sets);
  const offset = Math.max(0, parseInt(qp.get("offset") || "0") || 0), limit = Math.max(1, Math.min(200, parseInt(qp.get("limit") || "50") || 50));
  let total, rows;
  if (post) { const light = (await env.DB.prepare(`SELECT e.id, e.project_id, e.schema_id, e.answers_json, e.grounded_json, e.served, e.extra_json FROM examples e WHERE ${w} ORDER BY e.t DESC LIMIT 5000`).bind(...b).all()).results.filter(post);
    total = light.length; const ids = light.slice(offset, offset + limit).map(r => r.id), got = {};
    for (const c of chunk(ids, 90)) for (const r of (await env.DB.prepare(`SELECT * FROM examples WHERE id IN (${c.map(() => "?").join(",")})`).bind(...c).all()).results) got[r.id] = r;
    rows = ids.map(id => got[id]).filter(Boolean); }
  else { total = (await env.DB.prepare(`SELECT COUNT(*) n FROM examples e WHERE ${w}`).bind(...b).first()).n; rows = (await env.DB.prepare(`SELECT e.* FROM examples e WHERE ${w} ORDER BY e.t DESC LIMIT ? OFFSET ?`).bind(...b, limit, offset).all()).results; }
  return { total, offset, limit, requests: await reqsOut(env, ws, prs, sets, rows) };
}
export async function facets(env, ws, qp) {
  const prs = await routesOf(env, ws), sets = await setsFor(env, prs), kn = await kindNames(env, ws, sets), f = filterOf(qp), [w, b] = whereOf(f, prs.map(p => p.id)), post = postOf(f, sets);
  const rows = (await env.DB.prepare(`SELECT e.id, e.project_id, e.schema_id, e.source, e.answers_json, e.grounded_json, e.grounded_by, e.served, e.extra_json FROM examples e WHERE ${w} ORDER BY e.t DESC LIMIT 5000`).bind(...b).all()).results.filter(post || (() => true));
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1; }, out = { routes: {}, kinds: {}, sources: {}, answered_by: {}, labels_from: {}, total: rows.length, capped: rows.length >= 5000 };
  for (const r of rows) { inc(out.routes, r.project_id); inc(out.sources, r.source); const k = out.kinds[r.schema_id] || (out.kinds[r.schema_id] = { name: kn(r.schema_id), n: 0 }); k.n++;
    for (const [a, v] of Object.entries(J(r.answers_json, {}) || {})) if (v && Object.keys(v).length) inc(out.answered_by, shownKey(a, r.project_id));
    if (r.grounded_by) inc(out.labels_from, shownKey(r.grounded_by, r.project_id)); }
  out.route_names = Object.fromEntries(prs.map(p => [p.id, p.name]));
  out.left_out = (await env.DB.prepare(`SELECT COUNT(*) n FROM examples e WHERE ${whereOf({ ...f, left_out: "1" }, prs.map(p => p.id))[0]}`).bind(...b).first()).n;
  return out;
}
export async function estimateAsk(env, ws, b) {
  const prs = await routesOf(env, ws), sets = await setsFor(env, prs), rows = await selectRows(env, ws, prs, sets, b), cat = await catalogOf(env, ws), u = cat.upstreams.find(x => x.id === b.upstream);
  if (!u) return [400, { error: "Pick an upstream from your catalog." }];
  const have = rows.filter(r => { const a = J(r.answers_json, {}); const k = keyFor(u.id, r.project_id); return a[k] && Object.keys(a[k]).length; }).length, to_ask = rows.length - have;
  return [200, { n: rows.length, already_answered: have, to_ask, est_usd: u.per_1000_usd != null ? r4(to_ask * u.per_1000_usd / 1000) : null, price_basis: u.price_basis, price_note: u.price_note,
    est_minutes: Math.max(1, Math.round(to_ask * ((u.p50_ms || (u.kind === "llm" ? 2500 : u.kind === "model" ? 800 : 400)) / 1000) / 6 / 60)), key: u.key, ready: u.ready, why_not: u.why_not, ids: rows.length <= 5000 ? rows.map(r => r.id) : undefined }];
}
/** Ask one upstream on ≤ 25 requests; answers land on each request (and become its labels when its route's oracle says so). */
export async function askMany(env, ws, b) {
  const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 25) : []; if (!ids.length) return [400, { error: "ids: 1 to 25 request ids" }];
  const prs = await routesOf(env, ws), byId = Object.fromEntries(prs.map(p => [p.id, p])), sets = await setsFor(env, prs);
  const rows = (await env.DB.prepare(`SELECT * FROM examples WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results.filter(r => byId[r.project_id]);
  const ctxs = {}, ctxOf = async pid => ctxs[pid] || (ctxs[pid] = (async () => { const pr = byId[pid], S = (await loadSetup(env, pr)).setup; return { S, A: await answerCtx(env, pr, ws, S) }; })());
  const failed = []; let asked = 0;
  await pool(rows, 6, async r => {
    const { S, A } = await ctxOf(r.project_id), w = whyNot(A, b.upstream); if (w) { failed.push({ id: r.id, error: `${upstreamName(A, b.upstream)} can't answer: ${w}` }); return; }
    const res = await ask(A, b.upstream, { model: "jev-latest", state: J(r.state_json), questions: questionsOfRow(sets[r.schema_id], r) }, "batch");
    if (!res.ok) { failed.push({ id: r.id, error: `HTTP ${res.code}: ${String(res.raw || "").slice(0, 200)}` }); return; }
    const k = keyFor(b.upstream, r.project_id), vk = versionKey(b.upstream, r.project_id, res.version), ro = S.routes.find(x => x.id === r.route) || S.routes[S.routes.length - 1];
    await addShadow(env, r.id, { [k]: res.answers, ...(vk ? { [vk]: res.answers } : {}) }, { [k]: res.ms, ...(vk ? { [vk]: res.ms } : {}) }, ro.oracle, r.project_id); asked++;
  });
  return [200, { asked, failed }];
}
/** Pin labels to one upstream's answers (from: null unpins, back to each route's oracle). */
export async function pinLabels(env, ws, b) {
  const prs = await routesOf(env, ws), sets = await setsFor(env, prs), rows = await selectRows(env, ws, prs, sets, b, 10000), byP = {};
  for (const r of rows) (byP[r.project_id] || (byP[r.project_id] = [])).push(r.id);
  let labelled = 0;
  for (const [pid, ids] of Object.entries(byP)) for (const c of chunk(ids, 90)) {
    const ph = c.map(() => "?").join(",");
    if (b.from == null) { labelled += (await env.DB.prepare(`UPDATE examples SET grounded_pinned = 0 WHERE id IN (${ph})`).bind(...c).run()).meta.changes || 0; continue; }
    const k = keyFor(String(b.from), pid), path = `$."${k.replace(/["\\]/g, "")}"`;
    labelled += (await env.DB.prepare(`UPDATE examples SET grounded_json = json_extract(answers_json, ?), grounded_by = ?, grounded_pinned = 1 WHERE id IN (${ph}) AND NULLIF(json_extract(answers_json, ?), '{}') IS NOT NULL`).bind(path, k, ...c, path).run()).meta.changes || 0;
  }
  if (b.from == null) for (const pid of Object.keys(byP)) { const pr = prs.find(p => p.id === pid); await reground(env, pr, (await loadSetup(env, pr)).setup); }
  return [200, { labelled, missing: rows.length - labelled }];
}
export async function removeMany(env, ws, b) {
  const prs = await routesOf(env, ws), ids = Array.isArray(b.ids) ? b.ids.map(String) : []; if (!ids.length) return [400, { error: "ids required" }];
  let removed = 0; for (const p of prs) { const mine = ids.filter(id => id.startsWith(p.tenant + "-")); if (mine.length) removed += (await removeExamples(env, p, { ids: mine }))[1].removed || 0; }
  return [200, { removed }];
}
export async function exportPool(env, ws, qp) {
  const prs = await routesOf(env, ws), sets = await setsFor(env, prs), f = filterOf(qp), [w, b] = whereOf(f, prs.map(p => p.id)), post = postOf(f, sets);
  let rows = (await env.DB.prepare(`SELECT e.* FROM examples e WHERE ${w} ORDER BY e.t DESC LIMIT 10000`).bind(...b).all()).results; if (post) rows = rows.filter(post);
  const lines = (await reqsOut(env, ws, prs, sets, rows)).map(r => JSON.stringify({ route: r.route_name, kind: r.kind_name, t: r.t, state: r.state, questions: r.questions,
    labels: r.labels ? Object.fromEntries(Object.entries(r.labels).map(([k, v]) => [k, v.answer])) : null, labels_from: r.labels_from, answers: Object.fromEntries(Object.entries(r.answers).map(([u, a]) => [u, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { answer: v.answer, p: v.p }]))])) }));
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="understudy-requests.jsonl"` } });
}

// ---- models
export async function listModels(env, ws) {
  const prs = await routesOf(env, ws), cat = await catalogOf(env, ws), out = [], training = [];
  for (const p of prs) { const ms = await pollTraining(env, p, await modelsOf(env, p.id));
    for (const m of ms) { const row = { id: `model:${p.id}@${m.version}`, name: `${p.name} v${m.version}`, route: p.id, route_name: p.name, version: m.version, base: m.base || "laya", plan: m.plan || "main", status: m.status, t: m.t, trained_rows: m.trained_rows,
      holdout_agreement: J(m.holdout_agreement_json), cohort: J(m.cohort_json), ...webState(m), error: m.error || null, log: m.log || null,
        download: m.status === "ready" && downloadable(m.base) ? `/api/p/${p.id}/model/download?version=${m.version}` : null };
      if (m.status === "training") training.push(row); else if (m.status === "ready") { const u = cat.upstreams.find(x => x.id === `model:${p.id}@latest`); out.push({ ...row, latest: !!u && u.version === m.version, used_by: u && u.version === m.version ? u.used_by : [] }); } } }
  out.sort((a, b) => (b.t || 0) - (a.t || 0));
  return { models: out, training };
}
// the Laya engine serves GET /checkpoint/{route}/{version} (engines/modal_engine.py); the others don't yet
export const downloadable = base => familyOf(base || "laya") === "laya";
/** What each base's engine can do, for choosing one: where a trained version runs, and how it reads a question. GLiNER turns
    each question id into a task name (engines/modal_gliner.py), so question ids that change per request are new tasks every time;
    Laya and Kev read the question's own text. Every base takes noul, choice and score questions. */
const FIT = {
  laya: { runs: ["server", "browser", "download"], reads: "text", family: "Laya: a small decision model that reads the question's text; English" },
  "laya-multilingual": { runs: ["server", "browser", "download"], reads: "text", family: "Laya on mmBERT: the same head, 100+ languages, longer inputs" },
  "kev-0.8b": { runs: ["server"], reads: "text", family: "Kev: a small language model that reads the question's text" },
  "kev-4b": { runs: ["server"], reads: "text", family: "Kev: a language model that reads the question's text; slower and larger" },
  "gliner-decide": { runs: ["server"], reads: "id", family: "GLiNER: one classifier head per question id" },
  "gliner-small": { runs: ["server"], reads: "id", family: "GLiNER: one classifier head per question id; phone-sized" },
  tiny: { runs: ["download"], reads: "fixed", family: "Tiny: a 35 MB model (bge-small, int8) that reads the request's text and knows the questions and options it was trained on; runs on a Raspberry Pi, a laptop or a server with Python" },
};
export const bases = env => Object.entries(BASES).map(([id, name]) => ({ id, name, size: name.split(" ").pop(), runs_in_browser: familyOf(id) === "laya", downloads: downloadable(id), ready: baseReady(env, id),
  runs: (FIT[id] || { runs: ["server"] }).runs, reads: (FIT[id] || {}).reads || null, about: (FIT[id] || {}).family || null,
  ...(baseReady(env, id) ? {} : { why_not: "its engine isn't deployed on this server yet" }) }));
/** Train (or estimate) a model on a route from a selection (filter or ids) of that route's requests. */
export async function trainFrom(env, ws, b, dryRun) {
  const prs = await routesOf(env, ws), pr = prs.find(p => p.id === b.route); if (!pr) return [400, { error: "Pick the route the model is for." }];
  const sets = await setsFor(env, [pr]), sel = Array.isArray(b.ids) ? { ids: b.ids } : { filter: { ...(b.filter || {}), route: [pr.id] } };
  if (sel.filter && Array.isArray((b.filter || {}).route) && b.filter.route.some(r => r !== pr.id)) return [400, { error: "A model trains on one route's requests for now; filter to that route." }];
  const rows = await selectRows(env, ws, [pr], sets, sel, 20000), keep = new Set(rows.map(r => r.id));
  if (!keep.size) return [400, { error: "No requests match." }];
  if (Array.isArray(b.ids) && b.ids.length > keep.size) return [400, { error: "Some of these requests are on other routes; a model trains on one route's requests for now." }];
  const base = BASES[b.base] ? b.base : "laya", epochs = Math.max(1, Math.min(8, +b.epochs || 2)), plan = { id: "main", oracle: b.labels_from ? [String(b.labels_from)] : null, include_left_out: !!b.include_left_out };
  try {
    const cohort = { selection: Array.isArray(b.ids) ? { ids: keep.size } : filterOf(b.filter || {}), requests: keep.size, ...(b.include_left_out ? { include_left_out: true } : {}) };
    if (dryRun) { const est = await trainEstimate(env, pr, base, epochs, null, { keep, plan });
      return [200, (await engineHasBase(env, base)) ? est : { ...est, ready: false, why_not: `${BASES[base]} isn't on the training engine yet` }]; }
    return [200, await startTraining(env, pr, base, false, epochs, false, cohort, plan, keep)];
  } catch (e) { if (e.status) return [e.status, e.body || { error: e.message }]; throw e; }
}

/** "Check a few labels first" (Train drawer): of the requests a training would use, up to 8 worth a look — the least sure labels
    first, then one per kind and answer so the spread is covered — and how many labels are below the bar. Guidance, not a gate.
    Requests left out of training (unless include_left_out) and ones a person already labelled are skipped. */
export const CHECK_BELOW = 0.7;
export async function checkLabels(env, ws, b) {
  const prs = await routesOf(env, ws), pr = prs.find(p => p.id === b.route); if (!pr) return [400, { error: "Pick the route the model is for." }];
  const sets = await setsFor(env, [pr]), sel = Array.isArray(b.ids) ? { ids: b.ids } : { filter: { ...(b.filter || {}), route: [pr.id] } };
  const rows = await selectRows(env, ws, [pr], sets, sel, 20000), corr = await correctionsOf(env, pr.id);
  const cand = [];
  for (const r of rows) {
    const s = sets[r.schema_id], g = J(r.grounded_json, null), cs = corr[r.id] || {}; if (!s || !g) continue;
    const ex = cs.__all__ || {}; if (ex.label === "__skip__" && !(b.include_left_out && ex.by === "realism-check")) continue;
    const q = questionsOfRow(s, r), ks = Object.keys(q).filter(k => g[k]); if (!ks.length) continue;
    const fixed = ks.every(k => cs[k] && cs[k].label != null);   // a person already picked every label
    const conf = Math.min(...ks.map(k => topP(g[k]))), k0 = ks.reduce((a, k) => topP(g[k]) < topP(g[a]) ? k : a, ks[0]);
    cand.push({ id: r.id, conf, fixed, bucket: r.schema_id + "\u0000" + k0 + "\u0000" + answerOf(q[k0], g[k0]) });
  }
  const open = cand.filter(c => !c.fixed).sort((a, b) => a.conf - b.conf), pick = [], seen = new Set(), add = c => { if (pick.length < 8 && !pick.includes(c)) { pick.push(c); seen.add(c.bucket); } };
  for (const c of open.filter(c => c.conf < CHECK_BELOW).slice(0, 4)) add(c);   // the least sure first
  for (const c of open) if (!seen.has(c.bucket)) add(c);                            // then one per kind and answer
  for (const c of open) add(c);
  const full = {}; for (const c of chunk(pick.map(x => x.id), 90)) for (const r of (await env.DB.prepare(`SELECT * FROM examples WHERE id IN (${c.map(() => "?").join(",")})`).bind(...c).all()).results) full[r.id] = r;
  return [200, { labelled: cand.length, below: cand.filter(c => !c.fixed && c.conf < CHECK_BELOW).length, below_at: CHECK_BELOW, fixed_by_person: cand.filter(c => c.fixed).length,
    requests: await reqsOut(env, ws, [pr], sets, pick.map(x => full[x.id]).filter(Boolean)) }];
}

// ---- routing of /api/* for v4
export async function poolApi(req, env, ctx, url, user, ws) {
  const p = url.pathname, M = req.method, body = () => req.json().catch(() => ({})), out = ([c, o]) => json(o, c);
  if (p === "/api/upstreams" && M === "GET") return json(await catalogOf(env, ws));
  if (p === "/api/upstreams/search" && M === "GET") { try { return json({ models: await searchUpstreams(env, url.searchParams.get("provider") || "openrouter", url.searchParams.get("q")) }); } catch (e) { return err(e.message, e.status || 502); } }
  if (p === "/api/upstreams/pin" && M === "POST") return out(await pinUpstream(env, ws, String((await body()).id || ""), true));
  if (p === "/api/upstreams/unpin" && M === "POST") return out(await pinUpstream(env, ws, String((await body()).id || ""), false));
  if (p === "/api/providers" && M === "POST") return out(await addProviderKey(env, ws, await body()));
  if (p === "/api/routes" && M === "GET") return json(await listRoutes(env, ws, url.origin));
  if (p === "/api/routes" && M === "POST") return out(await createRoute(env, ws, await body(), user));
  const rm = p.match(/^\/api\/routes\/([0-9a-f]{8})(\/delete)?$/);
  if (rm && M === "POST" && !rm[2]) { const b = await body(), name = String(b.name || "").trim().slice(0, 60); if (!name) return err("Give the route a name.");
    const r = await env.DB.prepare("UPDATE projects SET name = ? WHERE id = ? AND workspace_id = ?").bind(name, rm[1], ws.id).run(); return r.meta.changes ? json({ ok: true, name }) : err("No such route.", 404); }
  if (rm && M === "POST" && rm[2]) return out(await deleteRoute(env, ws, rm[1], await body()));
  if (p === "/api/requests" && M === "GET") return json(await listPool(env, ws, url.searchParams));
  if (p === "/api/requests/facets" && M === "GET") return json(await facets(env, ws, url.searchParams));
  if (p === "/api/requests/estimate" && M === "POST") return out(await estimateAsk(env, ws, await body()));
  if (p === "/api/requests/ask" && M === "POST") return out(await askMany(env, ws, await body()));
  if (p === "/api/requests/labels" && M === "POST") return out(await pinLabels(env, ws, await body()));
  if (p === "/api/requests/remove" && M === "POST") return out(await removeMany(env, ws, await body()));
  if (p === "/api/requests/export" && M === "GET") return exportPool(env, ws, url.searchParams);
  if (p === "/api/models" && M === "GET") return json(await listModels(env, ws));
  if (p === "/api/models/bases" && M === "GET") return json(await Promise.all(bases(env).map(async b => b.ready && !(await engineHasBase(env, b.id)) ? { ...b, ready: false, why_not: "it isn't on the training engine yet" } : b)));
  if (p === "/api/models/estimate" && M === "POST") return out(await trainFrom(env, ws, await body(), true));
  if (p === "/api/models/check-labels" && M === "POST") return out(await checkLabels(env, ws, await body()));
  if (p === "/api/models/train" && M === "POST") return out(await trainFrom(env, ws, await body(), false));
  return null;
}
