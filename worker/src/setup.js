/* Setup v2: per model, which answerer replies to which requests (routes), who is right (oracle) and
   what gets trained (plans); per account, the outside services it has plugged in (connections). Every save is a new version.
   A model with no setup yet gets its old routing settings converted, with the same behaviour. */
import { encrypt, BASES, JEV_URL, OPEN_BASES, baseReady, jevFetch } from "./lib.js";
import { parseLlm, llmWhyNot } from "./upstreams.js";
import { defaultRouting } from "./routing.js";
import { SOURCES, cleanCohort, modelsOf, secs, seeded, minConfOf } from "./data.js";

const J = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch (_) { return d; } };
const clone = x => JSON.parse(JSON.stringify(x));
export const WAKE_WAIT_MS = 90000, WAIT_MS = 30000;   // a sleeping version needs ~15 s (up to a minute) to wake; services get 30 s

// ---- connections (per account)
const jevConn = ws => ({ id: "jev", kind: "jev", name: "Jev", url: JEV_URL, key_owner: ws.jev_mode === "own" && ws.ts_key_enc ? "yours" : "ours", has_key: true, built_in: true });
const connOut = c => ({ id: c.id, kind: c.kind, name: c.name, url: c.url, key_owner: "yours", has_key: !!c.auth_enc, built_in: false });
export const isService = c => c.kind === "systemone";
/** The account's connections, Jev first. Jev-shaped endpoints its models registered before connections existed join the list here. */
export async function connectionsOf(env, ws) {
  await env.DB.prepare("INSERT OR IGNORE INTO connections (id, workspace_id, kind, name, url, auth_enc, created_at) SELECT e.id, p.workspace_id, 'systemone', e.name, e.url, e.auth_enc, e.created_at FROM endpoints e JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = ?").bind(ws.id).run();
  const all = (await env.DB.prepare("SELECT * FROM connections WHERE workspace_id = ? ORDER BY created_at").bind(ws.id).all()).results;
  const rows = all.filter(c => c.kind !== "pin"), pins = all.filter(c => c.kind === "pin").map(c => c.model);
  return { rows, pins, list: [jevConn(ws), ...rows.map(connOut)] };
}
export async function addConnection(env, ws, b) {
  if ((b.kind || "systemone") !== "systemone") return [400, { error: "For now a connection is a service that speaks Jev's API (kind systemone). LLM services come next." }];
  let u; try { u = new URL(String(b.url || "")); } catch (_) { return [400, { error: "url must be the full URL of a service that speaks Jev's API (…/v1/systemone)." }]; }
  if (!/^https?:$/.test(u.protocol)) return [400, { error: "url must start with http:// or https://." }];   // http too: a local service (an offline folder, Ollama) has no TLS
  const id = crypto.getRandomValues(new Uint8Array(4)).reduce((s, x) => s + x.toString(16).padStart(2, "0"), "");
  const auth_enc = b.key ? await encrypt(env, String(b.key).trim().replace(/^Bearer\s+/i, "")) : null, name = String(b.name || u.hostname).trim().slice(0, 60) || u.hostname;
  await env.DB.prepare("INSERT INTO connections (id, workspace_id, kind, name, url, auth_enc, created_at) VALUES (?,?,?,?,?,?,?)").bind(id, ws.id, "systemone", name, u.toString(), auth_enc, Date.now()).run();
  return [200, connOut({ id, kind: "systemone", name, url: u.toString(), auth_enc })];
}
export async function setJev(env, ws, b) {
  const yours = b.key_owner === "yours", key = String(b.key || "").trim().replace(/^Bearer\s+/i, "");
  if (yours && !key && !ws.ts_key_enc) return [400, { error: "Paste your TypeSafe key to use it." }];
  if (yours && key) {   // one tiny request with the new key before it's saved, so a wrong key fails here and not on your app's traffic
    const r = await jevFetch("Bearer " + key, { model: "jev-latest", state: "ping", questions: { ok: { type: "noul", instructions: "Is this the word ping?" } } });
    if (r.status === 401 || r.status === 403) return [400, { error: "TypeSafe rejected that key (HTTP " + r.status + "). Check it and paste it again; nothing was changed." }];
  }
  const enc = yours ? (key ? await encrypt(env, key) : ws.ts_key_enc) : null;
  await env.DB.prepare("UPDATE workspaces SET jev_mode = ?, ts_key_enc = ? WHERE id = ?").bind(yours ? "own" : "understudy", enc, ws.id).run();
  return [200, jevConn({ ...ws, jev_mode: yours ? "own" : "understudy", ts_key_enc: enc })];
}
export async function deleteConnection(env, ws, id) {
  if (id === "jev") return [400, { error: "Jev is built in; switch it between your own key and the server's instead." }];
  const c = await env.DB.prepare("SELECT * FROM connections WHERE id = ? AND workspace_id = ?").bind(id, ws.id).first(); if (!c) return [404, { error: "No such connection." }];
  const users = [];
  for (const p of (await env.DB.prepare("SELECT id, name FROM projects WHERE workspace_id = ?").bind(ws.id).all()).results) {
    const s = await latestSetup(env, p.id); if (s && Object.values(usedAnswerers(s.setup)).some(a => a.kind === "connection" && a.connection === id)) users.push(p.name);
  }
  if (users.length) return [400, { error: `${c.name} is still used by the setup of ${users.join(", ")}. Take it out there first.` }];
  await env.DB.batch([env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(id), env.DB.prepare("DELETE FROM endpoints WHERE id = ?").bind(id)]);
  return [200, { ok: true }];
}

// ---- answerers: canonical ids for what an account and a model have (the id is also where its answers are stored on a request)
export const connAnswererId = cid => cid === "jev" ? "jev" : "endpoint:" + cid;
export const planAnswererId = pid => pid === "main" ? "model" : "plan:" + pid;
/** Every answerer id a setup refers to, resolved: explicit entries first, canonical ids otherwise. */
export function resolveAnswerer(setup, id) {
  const a = (setup.answerers || {})[id]; if (a) return a;
  if (id === YOU) return { kind: "person" };   // labels come from your fixes; nobody is asked
  if (id === "jev") return { kind: "connection", connection: "jev" };
  if (id.startsWith("endpoint:")) return { kind: "connection", connection: id.slice(9) };
  if (id.startsWith("url:")) return { kind: "connection", connection: id.slice(4) };
  if (id.startsWith("llm:")) return parseLlm(id) ? { kind: "llm", id } : null;
  if (id.startsWith("open:")) return OPEN_BASES[id.slice(5)] ? { kind: "open", base: id.slice(5) } : null;
  const other = /^model:([0-9a-f]{8})@(latest|\d+)$/.exec(id); if (other) return { kind: "version", project: other[1], plan: "main", version: other[2] === "latest" ? "latest" : +other[2] };
  if (id === "model") return { kind: "version", plan: "main", version: "latest" };
  if (id.startsWith("plan:")) return { kind: "version", plan: id.slice(5), version: "latest" };
  const pin = /^model@(\d+)$/.exec(id); if (pin) return { kind: "version", plan: "main", version: +pin[1] };
  return null;
}
const refsOf = s => [...s.routes.flatMap(r => [...r.steps.flatMap(st => st.split ? Object.keys(st.split) : [st.ask]), ...r.background.map(b => b.ask), ...r.oracle]), ...s.plans.flatMap(p => p.oracle || []), s.checker].filter(Boolean);
export const usedAnswerers = s => Object.fromEntries([...new Set(refsOf(s))].map(id => [id, resolveAnswerer(s, id)]).filter(([, a]) => a));

// ---- defaults, presets and the old routing converted
const everything = () => ({ kinds: [], keys: [], sources: [] });
// Tiny by default: it trains on this machine's CPU (engines/tiny_local.py), where Laya, GLiNER and Kev need GPUs on Modal
const mainPlan = () => ({ id: "main", name: "Main", base: "tiny", epochs: 2, cohort: null, oracle: null, auto: { first_at: 100, every: 100, until_agreement: true } });
// Who is right (the labels a model learns from) defaults to you: your fixes on the Requests page. An LLM or any upstream is one pick away.
export const YOU = "you";
const route = (o = {}) => ({ id: "all", name: "Everything", match: everything(), allow_header: false, steps: [{ ask: "jev", wait_ms: WAIT_MS }], background: [], oracle: [YOU], fill_pct: 0, cache_s: null, ...o });
const withAnswerers = s => ({ ...s, answerers: usedAnswerers(s) });
/** A new model: Jev replies, the latest version practises in the background, you label (your fixes), a plan trains by itself. */
export const defaultSetup = () => withAnswerers({ answerers: {}, routes: [route({ background: [{ ask: "model", pct: 100 }] })], plans: [mainPlan()], checker: "jev", keep_awake: false });
/** The routing settings a model had before setups, as a setup that behaves the same. */
export function fromRouting(cfg) {
  const on = Object.fromEntries(Object.entries(cfg.targets || {}).filter(([, v]) => v && v.on)), has = k => !!on[k];
  const rule = t => (cfg.rules || []).find(r => r.on && r.type === t) || null;
  const answerers = {};
  for (const [k, v] of Object.entries(on)) answerers[k] = k === "model" ? { kind: "version", plan: "main", version: v.version && v.version !== "latest" ? +v.version : "latest" } : { kind: "connection", connection: k === "jev" ? "jev" : k.slice(9) };
  const sp = rule("split"), w = Object.entries((sp && sp.weights) || {}).filter(([k, x]) => has(k) && x > 0);
  const first = w.length === 1 ? w[0][0] : w.length ? null : has("jev") ? "jev" : Object.keys(on)[0] || "jev";
  const fb = rule("fallback"), g = rule("confidence_gate");
  const fbTo = fb && has(fb.to) && fb.to !== first ? fb.to : null, gAsk = g && has(g.ask) && g.ask !== first ? g.ask : null;
  // the old path waited up to 90 s for the first answer unless a fallback to someone else was set (then its timeout, but never less than a wake for the model)
  const step1 = { ...(first ? { ask: first } : { split: Object.fromEntries(w) }), wait_ms: fbTo ? Math.max(first === "model" ? WAKE_WAIT_MS : 0, fb.timeout_ms ?? 800) : WAKE_WAIT_MS, ...(gAsk ? { unsure_below: g.below } : {}) };
  const second = fbTo || gAsk;
  const r = route({ allow_header: !!rule("header"), steps: [step1, ...(second ? [{ ask: second, wait_ms: WAKE_WAIT_MS }] : [])],
    background: (cfg.rules || []).filter(x => x.on && x.type === "shadow" && has(x.target) && x.pct > 0).map(x => ({ ask: x.target, pct: x.pct })),
    oracle: [has("jev") ? "jev" : Object.keys(on).find(k => k !== "model") || "jev"], cache_s: rule("cache") ? rule("cache").ttl_s : null });
  return { answerers, routes: [r], plans: [mainPlan()], checker: "jev", keep_awake: !!cfg.keep_awake };
}
/** Starting points around one upstream U (Jev unless the route already answers with something else), labelled by L (you, unless
    the route already labels with something else), built from what this route has (its plans and checker stay as they are). */
export function presetsFor(cur, kinds, U = null, uName = null, L = null, lName = null) {
  const r0 = cur.routes && cur.routes[0], first = r0 && r0.steps && r0.steps[0] && r0.steps[0].ask;
  U = U || (first && first !== "model" && !String(first).startsWith("plan:") ? first : null) || "jev"; uName = uName || nameFor(U);
  L = L || (r0 && r0.oracle && r0.oracle[0]) || YOU; lName = lName || nameFor(L);
  const labels = L === YOU ? "You label them: fix any answer on Requests and it becomes the label." : `${lName}'s answers are the labels.`;
  const keep = s => withAnswerers({ ...s, plans: cur.plans, checker: cur.checker, keep_awake: cur.keep_awake }), M = planAnswererId(cur.plans[0].id), on = o => route({ steps: [{ ask: U, wait_ms: WAIT_MS }], oracle: [L], ...o });
  const fill = L === YOU ? {} : { fill_pct: 5 }, fillSay = L === YOU ? "" : ` ${lName} also labels 5% of the rest.`;
  const out = [
    { id: "learn", name: `${uName}, and learn`, summary: `${uName} answers every request; your latest model answers too, in the background, so you can see how close it is. ${labels}`, setup: keep({ routes: [on({ background: [{ ask: M, pct: 100 }] })] }) },
    { id: "only", name: `${uName} only`, summary: `Straight to ${uName}, nothing else asked. Every request is still logged. ${labels}`, setup: keep({ routes: [on()] }) },
    { id: "model_first", name: `Your model first, ${uName} when unsure`, summary: `Your latest model answers; below 70% sure, or if it doesn't answer in time, ${uName} does.${fillSay} ${labels}`, setup: keep({ routes: [on({ steps: [{ ask: M, wait_ms: WAKE_WAIT_MS, unsure_below: 0.7 }, { ask: U, wait_ms: WAIT_MS }], ...fill })] }), needs: "a trained version" },
    { id: "model_only", name: "Your model only", summary: `Only your latest model answers.${L === YOU ? "" : ` ${lName} labels 5% of requests afterwards so you can keep checking it.`} ${labels}`, setup: keep({ routes: [on({ steps: [{ ask: M, wait_ms: WAKE_WAIT_MS }], ...fill })] }), needs: "a trained version" },
  ];
  if (kinds.length > 1) out.push({ id: "per_kind", name: "One route per kind of request", summary: `Each kind of request gets its own route (${uName} answers, your latest model in the background), so you can change one without the others. ${labels}`,
    setup: keep({ routes: [...kinds.map((k, i) => on({ id: "k" + (i + 1), name: k.name, match: { ...everything(), kinds: [k.id] }, background: [{ ask: M, pct: 100 }] })), on({ name: "Everything else", background: [{ ask: M, pct: 100 }] })] }) });
  return out;
}
const nameFor = id => id === YOU ? "You" : id === "jev" ? "Jev" : String(id).replace(/^llm:[a-z]+\//, "").replace(/^endpoint:.*/, "your service");

// ---- the proxy's per-isolate cache of a key's context (index.js keyContext): the setup in force, models, connections.
// A save clears this isolate's entries for the route at once; other isolates pick it up when theirs expire, within KEY_CTX_MS.
// No shared stamp is read on the request path (that would be a read per request); the UI says "within about N s" from this number.
export const KEY_CTX_MS = 10000, keyCtx = new Map();
export function forgetKeyContext(pid) { for (const [h, e] of keyCtx) if (e.v && e.v.pr && e.v.pr.id === pid) keyCtx.delete(h); }
// ---- storage: newest version is in force
/** Who saved a setup, for people: a guest account (made by an agent or by the first request) is "your agent". */
const whoSaved = by => /@guests\.dopp\.sh$/.test(String(by || "")) ? "your agent" : by;
export async function latestSetup(env, pid) {
  const r = await env.DB.prepare("SELECT * FROM setups WHERE project_id = ? ORDER BY version DESC LIMIT 1").bind(pid).first();
  return r && { setup: J(r.json), version: r.version, saved_at: r.t, saved_by: whoSaved(r.by), note: r.note };
}
/** The setup in force; a model without one gets its routing settings converted and saved as v1 (by "converted"). */
export async function loadSetup(env, pr) {
  const got = await latestSetup(env, pr.id); if (got) return got;
  const row = await env.DB.prepare("SELECT json FROM routing WHERE project_id = ?").bind(pr.id).first();
  const s = row ? fromRouting(J(row.json, defaultRouting())) : defaultSetup();
  await env.DB.prepare("INSERT OR IGNORE INTO setups (project_id, version, json, t, \"by\", note) VALUES (?,?,?,?,?,?)").bind(pr.id, 1, JSON.stringify(s), secs(), "Dopp", row ? "Converted from the routing settings on Use" : "The starting setup").run();
  return latestSetup(env, pr.id);
}
export async function saveSetup(env, pr, setup, by, note) {
  const cur = await loadSetup(env, pr);
  await env.DB.prepare("INSERT INTO setups (project_id, version, json, t, \"by\", note) VALUES (?,?,?,?,?,?)").bind(pr.id, cur.version + 1, JSON.stringify(setup), secs(), by || null, note ? String(note).slice(0, 200) : null).run();
  return latestSetup(env, pr.id);
}
export const setupHistory = async (env, pid) => (await env.DB.prepare("SELECT version, t, \"by\", note FROM setups WHERE project_id = ? ORDER BY version DESC LIMIT 100").bind(pid).all()).results.map(r => ({ version: r.version, saved_at: r.t, saved_by: whoSaved(r.by), note: r.note }));
export async function setupVersion(env, pid, v) { const r = await env.DB.prepare("SELECT * FROM setups WHERE project_id = ? AND version = ?").bind(pid, v).first(); return r && { setup: J(r.json), version: r.version, saved_at: r.t, saved_by: whoSaved(r.by), note: r.note }; }

// ---- validation: → [error in plain words, clean setup]
const num = x => typeof x === "number" && isFinite(x);
const idOk = x => typeof x === "string" && /^[\w-]{1,40}$/.test(x);
/** A route's own model under its catalog id ("model:<route>@latest|n") is the same upstream as "model" / "model@n": one spelling, so answers,
    labels and pickers line up. */
export function canonical(b, pid) {
  if (!pid || !b || typeof b !== "object") return b;
  const c = id => { const m = typeof id === "string" && /^model:([0-9a-f]{8})@(latest|\d+)$/.exec(id); return m && m[1] === pid ? (m[2] === "latest" ? "model" : "model@" + m[2]) : id; };
  return { ...b, checker: c(b.checker), routes: (b.routes || []).map(r => ({ ...r, steps: (r.steps || []).map(s => s.split ? { ...s, split: Object.fromEntries(Object.entries(s.split).map(([k, v]) => [c(k), v])) } : { ...s, ask: c(s.ask) }),
    background: (r.background || []).map(g => ({ ...g, ask: c(g.ask) })), oracle: (r.oracle || []).map(c) })), plans: (b.plans || []).map(p => ({ ...p, oracle: p.oracle ? p.oracle.map(c) : p.oracle })) };
}
export function validateSetup(b, ctx) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return ["setup must be an object", null];
  b = canonical(b, ctx.pid);
  const known = id => { const a = typeof id === "string" && resolveAnswerer(b, id); if (!a) return null;
    if (a.kind === "person") return a;   // you, as a labeller (steps, splits, background and the checker refuse it below)
    if (a.kind === "connection") return ctx.connections.has(a.connection) ? a : null;
    if (a.kind === "llm") return ctx.llmOk(id) ? a : null;
    if (a.kind === "open") return ctx.openOk(a.base) ? a : null;
    if (a.kind === "version" && a.project) return ctx.projects.has(a.project) ? a : null;
    if (a.kind === "version") return (b.plans || []).some(p => p.id === a.plan) && (a.version === "latest" || (Number.isInteger(a.version) && a.version > 0)) ? a : null; return null; };
  const bad = (id, where) => `${where} asks "${id}", which isn't one of your connections or versions. Pick it again from the list.`;
  const plans = [], pids = new Set();
  if (!Array.isArray(b.plans) || !b.plans.length) return ["a setup needs at least one training plan", null];
  for (const p of b.plans) {
    if (!p || !idOk(p.id) || pids.has(p.id)) return ["each training plan needs its own id", null]; pids.add(p.id);
    if (!BASES[p.base]) return [`plan ${p.name || p.id}: base must be one of ${Object.values(BASES).join(", ")}`, null];
    const epochs = p.epochs == null ? 2 : +p.epochs; if (!Number.isInteger(epochs) || epochs < 1 || epochs > 8) return [`plan ${p.name || p.id}: epochs must be 1 to 8`, null];
    let auto = null; if (p.auto) { const f = +p.auto.first_at, e = +p.auto.every; if (!Number.isInteger(f) || f < 20 || !Number.isInteger(e) || e < 20) return [`plan ${p.name || p.id}: train automatically at 20 labelled requests or more, and every 20 or more after that`, null]; auto = { first_at: f, every: e, until_agreement: !!p.auto.until_agreement }; }
    plans.push({ id: p.id, name: String(p.name || p.id).slice(0, 60), base: p.base, epochs, cohort: cleanCohort(p.cohort), oracle: null, auto, _oracle: p.oracle });
  }
  const b2 = { ...b, plans }, known2 = id => { const a = known(id); return !!a && (a.kind !== "version" || !!a.project || pids.has(a.plan)); };
  for (const p of plans) { const o = p._oracle; delete p._oracle; if (o != null) { if (!Array.isArray(o) || !o.length || o.length > 5) return [`plan ${p.name}: its labels override needs 1 to 5 answerers (or none)`, null]; for (const id of o) if (!known2(id)) return [bad(id, `plan ${p.name}`), null]; p.oracle = [...new Set(o)]; } }
  if (!Array.isArray(b.routes) || !b.routes.length) return ["a setup needs at least one route", null];
  const routes = [], rids = new Set();
  for (const r of b.routes) {
    if (!r || !idOk(r.id) || rids.has(r.id)) return ["each route needs its own id", null]; rids.add(r.id);
    const name = String(r.name || r.id).slice(0, 60), m = r.match || {}, list = v => Array.isArray(v) ? [...new Set(v.map(String))].slice(0, 50) : [];
    const match = { kinds: list(m.kinds), keys: list(m.keys).map(k => k.replace(/^key\s+/, "")), sources: list(m.sources) };
    if (match.kinds.some(k => !ctx.kinds.has(k))) return [`route ${name}: one of its kinds of requests isn't this model's`, null];
    if (match.sources.some(s => !SOURCES.includes(s))) return [`route ${name}: where requests came from must be among ${SOURCES.join(", ")}`, null];
    if (!Array.isArray(r.steps) || !r.steps.length || r.steps.length > 6) return [`route ${name} needs 1 to 6 steps (who answers, in order)`, null];
    const steps = [];
    for (const [i, st] of r.steps.entries()) {
      const where = `route ${name}, step ${i + 1}`, wait = st.wait_ms == null ? WAIT_MS : +st.wait_ms;
      if (!Number.isInteger(wait) || wait < 100 || wait > 120000) return [`${where}: wait between 0.1 and 120 seconds`, null];
      if (st.unsure_below != null && !(num(st.unsure_below) && st.unsure_below > 0 && st.unsure_below <= 1)) return [`${where}: "unsure below" must be between 0 and 100%`, null];
      const x = { wait_ms: wait, ...(st.unsure_below != null ? { unsure_below: st.unsure_below } : {}) };
      if (st.split && typeof st.split === "object" && Object.keys(st.split).length) {
        const w = Object.entries(st.split).filter(([, v]) => +v > 0); for (const [id] of w) if (!known2(id) || id === YOU) return [bad(id, where), null];
        if (!w.length || Math.round(w.reduce((s, [, v]) => s + +v, 0) * 1e6) / 1e6 !== 100) return [`${where}: the split has to add up to 100%`, null];
        x.split = Object.fromEntries(w.map(([k, v]) => [k, +v]));
      } else { if (!known2(st.ask) || st.ask === YOU) return [st.ask === YOU ? `${where}: you can't answer requests; pick yourself under who is right` : bad(st.ask, where), null]; x.ask = st.ask; }
      steps.push(x);
    }
    const background = [];
    for (const g of Array.isArray(r.background) ? r.background.slice(0, 10) : []) { if (!known2(g.ask) || g.ask === YOU) return [bad(g.ask, `route ${name}, background`), null]; const pct = +g.pct; if (!num(pct) || pct < 0 || pct > 100) return [`route ${name}: background % must be 0 to 100`, null]; if (pct > 0) background.push({ ask: g.ask, pct }); }
    if (!Array.isArray(r.oracle) || !r.oracle.length || r.oracle.length > 5) return [`route ${name}: pick who is right (you, or 1 to 5 answerers in order)`, null];
    for (const id of r.oracle) if (!known2(id)) return [bad(id, `route ${name}, who is right`), null];
    const fill = r.fill_pct == null ? 0 : +r.fill_pct; if (!num(fill) || fill < 0 || fill > 100) return [`route ${name}: "ask it later" must be 0 to 100%`, null];
    const cache = r.cache_s == null || r.cache_s === "" ? null : +r.cache_s; if (cache !== null && (!Number.isInteger(cache) || cache < 1 || cache > 86400)) return [`route ${name}: reuse identical replies for 1 s to 24 h, or not at all`, null];
    routes.push({ id: r.id, name, match, allow_header: !!r.allow_header, steps, background, oracle: [...new Set(r.oracle)], fill_pct: fill, cache_s: cache });
  }
  const last = routes[routes.length - 1]; if (last.match.kinds.length || last.match.keys.length || last.match.sources.length) return [`The last route ("${last.name}") has to take every request, so none goes unanswered. Add a route for everything at the end.`, null];
  const checker = b.checker || routes[0].oracle.find(id => id !== YOU) || "jev", ca = known2(checker) && resolveAnswerer(b2, checker);
  if (!ca || ca.kind === "version" || ca.kind === "open" || ca.kind === "person") return ["checks (realism, dataset fit) need Jev, an LLM or a service, not a model", null];
  const clean = { answerers: {}, routes, plans, checker, keep_awake: !!b.keep_awake };
  for (const id of new Set(refsOf(clean))) clean.answerers[id] = resolveAnswerer(b2, id);
  return [null, clean];
}

// ---- what the Setup page shows next to the setup
const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
export const matches = (r, x) => (!r.match.kinds.length || (x.schemas || [x.schema]).some(k => r.match.kinds.includes(k))) && (!r.match.keys.length || r.match.keys.some(k => String(x.via || "") === "key " + k || String(x.via || "").startsWith("key " + k))) && (!r.match.sources.length || r.match.sources.includes(x.source));
export const routeOf = (s, x) => s.routes.find(r => matches(r, x)) || s.routes[s.routes.length - 1];
function kindName(set, meta) {
  if (meta && meta.name) return meta.name; const plan = J(set.plan_json); if (plan && plan.name) return plan.name;
  const sh = J(set.shape_json, { kind: "fixed" }); if (sh.kind === "chunks") { const c = Array.isArray(sh.criteria) ? sh.criteria : Object.keys(sh.criteria || {}); return "Words → " + (c.length > 4 ? c.slice(0, 3).join(" / ") + ` +${c.length - 3}` : c.join(" / ")); }
  return Object.keys(J(set.questions_json, {})).join(", ");
}
/** Everything GET /setup returns around the setup itself. */
export async function setupContext(env, pr, ws, cur) {
  const JEV_PER_TOKEN = (+(env.JEV_PRICE_IN || 0.042)) / 1e6, margin = +(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1);
  const [conns, ms, sets, meta, keys, src, rows] = await Promise.all([connectionsOf(env, ws), modelsOf(env, pr.id),
    env.DB.prepare("SELECT q.*, (SELECT COUNT(*) FROM examples e WHERE e.schema_id = q.id) n FROM question_sets q WHERE q.project_id = ?").bind(pr.id).all().then(r => r.results),
    env.DB.prepare("SELECT schema_id, name FROM schema_meta WHERE workspace_id = ?").bind(ws.id).all().then(r => Object.fromEntries(r.results.map(x => [x.schema_id, x]))),
    env.DB.prepare("SELECT k.prefix, (SELECT COUNT(*) FROM examples e WHERE e.project_id = ?1 AND e.via = 'key ' || k.prefix) n FROM proxy_keys k WHERE k.project_id = ?1 AND k.revoked_at IS NULL ORDER BY k.created_at DESC").bind(pr.id).all().then(r => r.results),
    env.DB.prepare("SELECT source, COUNT(*) n FROM examples WHERE project_id = ? GROUP BY source").bind(pr.id).all().then(r => r.results),
    env.DB.prepare("SELECT schema_id, via, source, t, ms_json, answers_json, extra_json FROM examples WHERE project_id = ? ORDER BY t DESC LIMIT 500").bind(pr.id).all().then(r => r.results)]);
  const kinds = sets.filter(s => s.n > 0 || s.declared).map(s => ({ id: s.id, name: kindName(s, meta[s.id]), requests: s.n })).sort((a, b) => b.requests - a.requests);
  const ready = ms.filter(m => m.status === "ready"), latest = ready[ready.length - 1];
  // measured from this model's own last 500 requests: typical time per answerer, and Jev's price from its token counts
  const msBy = {}, tok = []; for (const r of rows) { for (const [k, v] of Object.entries(J(r.ms_json, {}) || {})) (msBy[k] || (msBy[k] = [])).push(v); const u = (J(r.extra_json, {}) || {}).usage; if (u && u.input_tokens) tok.push((+u.input_tokens || 0) + (+u.output_tokens || 0)); }
  const view = [{ id: YOU, name: "You (your fixes on Requests)", kind: "person", ready: true, why_not: null, labels_only: true }];   // only ever a labeller
  for (const c of conns.list.filter(c => c.kind === "jev" || c.kind === "systemone")) { const id = connAnswererId(c.id), p50 = med(msBy[id] || []);
    const price = c.kind === "jev" ? (c.key_owner === "ours" ? { per_1000_usd: Math.round((tok.length ? med(tok) : 600) * JEV_PER_TOKEN * 1000 * margin * 1e4) / 1e4, measured: tok.length > 0 } : { per_1000_usd: null, price_note: "billed to your TypeSafe account" }) : { per_1000_usd: null, price_note: "billed by that service" };
    view.push({ id, name: c.name, kind: "connection", connection: c.id, connection_kind: c.kind, ready: true, why_not: null, p50_ms: p50 == null ? null : Math.round(p50), measured_ms: p50 != null, ...price }); }
  for (const p of cur.plans) { const id = planAnswererId(p.id), mine = p.id === "main" ? ready : [], v = mine[mine.length - 1];   // versions made before plans existed belong to the first plan
    const p50 = med(msBy[id] || []);
    view.push({ id, name: v ? `${pr.name} v${v.version}` : `${pr.name} (latest version)`, kind: "version", plan: p.id, version: "latest", resolves_to: v ? v.version : null, base: v ? v.base || "laya" : p.base, ready: !!v, why_not: v ? null : "no trained version yet", p50_ms: p50 == null ? null : Math.round(p50), measured_ms: p50 != null, per_1000_usd: null, price_note: "server time isn't metered yet" }); }
  for (const m of ready) view.push({ id: "model@" + m.version, name: `${pr.name} v${m.version}`, kind: "version", plan: "main", version: m.version, base: m.base || "laya", pinned: true, ready: true, why_not: null, p50_ms: null, measured_ms: false, per_1000_usd: null, price_note: "server time isn't metered yet" });
  // the rest of the account's catalog: LLMs and every other route's models can answer here too
  const { catalogOf } = await import("./pool.js"), cat = await catalogOf(env, ws);
  for (const u of cat.upstreams) if (u.kind === "llm" || u.kind === "open" || (u.kind === "model" && u.route !== pr.id)) view.push({ id: u.id, name: u.name, kind: u.kind === "model" ? "version" : u.kind, provider: u.provider, ready: u.ready, why_not: u.why_not, p50_ms: u.p50_ms, measured_ms: u.measured_ms, per_1000_usd: u.per_1000_usd, price_basis: u.price_basis, price_note: u.price_note, ...(u.kind === "model" ? { route: u.route, route_name: u.route_name, version: u.version } : {}) });
  const connById = Object.fromEntries(conns.rows.map(c => [c.id, c])), wsProjects = (await env.DB.prepare("SELECT id FROM projects WHERE workspace_id = ?").bind(ws.id).all()).results.map(r => r.id);
  const day = secs() - 86400, r24 = {}; for (const r of rows) if (r.t >= day) { const ro = routeOf(cur, { schema: r.schema_id, via: r.via, source: r.source }); r24[ro.id] = (r24[ro.id] || 0) + 1; }
  return { answerers: view, connections: conns.list, kinds, keys: keys.map(k => ({ prefix: k.prefix, requests: k.n })), sources: Object.fromEntries(src.map(r => [r.source, r.n])),
    bases: Object.entries(BASES).map(([id, name]) => ({ id, name })), routes_24h: r24, latest_version: latest ? latest.version : null, presets: presetsFor(cur, kinds), _ids: { pid: pr.id, connections: new Set(conns.list.map(c => c.id)), kinds: new Set(sets.map(s => s.id)), projects: new Set(wsProjects), llmOk: id => !llmWhyNot(env, connById, parseLlm(id)), openOk: b => !!OPEN_BASES[b] && baseReady(env, b) } };
}

// ---- the last 100 requests replayed through a setup on paper (nothing is sent anywhere)
export function previewSetup(setup, rows, ctx) {
  const rnd = seeded(0), by = {}, bg = {}, cost = [], lat = [], LAT = { jev: 300, systemone: 300, version: 120 };
  const readyIds = new Set(ctx.answerers.filter(a => a.ready).map(a => a.id)), jevTok = ctx.jevPerToken;
  const kindOf = id => { const a = resolveAnswerer(setup, id); return !a ? null : a.kind === "version" ? "version" : a.connection === "jev" ? "jev" : "systemone"; };
  const readyAns = id => { const a = resolveAnswerer(setup, id); return !!a && (a.kind === "connection" ? readyIds.has(connAnswererId(a.connection)) : readyIds.has(planAnswererId(a.plan)) || readyIds.has("model@" + a.version)); };
  for (const r of rows) {
    const ro = routeOf(setup, r), ran = []; let served = null, t = 0;
    for (const [i, st] of ro.steps.entries()) {
      let id = st.ask; if (st.split) { const w = Object.entries(st.split).filter(([k]) => readyAns(k)); let x = rnd() * w.reduce((s, [, v]) => s + v, 0); id = null; for (const [k, v] of w) { x -= v; if (x < 0) { id = k; break; } } if (!id && w.length) id = w[w.length - 1][0]; }
      if (!id || !readyAns(id)) continue;
      const stored = (r.answers || {})[id === "model" || id.startsWith("model@") ? "model" : id], ms = ((r.ms || {})[id]) ?? LAT[kindOf(id)] ?? 300;
      ran.push(id); t += Math.min(ms, st.wait_ms); served = id;
      const last = i === ro.steps.length - 1, slow = ms > st.wait_ms, unsure = st.unsure_below != null && stored && minConfOf(stored) < st.unsure_below;
      if (last || !(slow || unsure)) break;
    }
    for (const g of ro.background) if (readyAns(g.ask) && !ran.includes(g.ask) && rnd() * 100 < g.pct) { bg[g.ask] = (bg[g.ask] || 0) + 1; ran.push(g.ask); }
    if (ro.fill_pct && readyAns(ro.oracle[0]) && !ran.includes(ro.oracle[0]) && rnd() * 100 < ro.fill_pct) { bg[ro.oracle[0]] = (bg[ro.oracle[0]] || 0) + 1; ran.push(ro.oracle[0]); }
    if (served) by[served] = (by[served] || 0) + 1; else by["nobody"] = (by["nobody"] || 0) + 1;
    cost.push(ran.reduce((s, id) => s + (kindOf(id) === "jev" && ctx.jevOurs ? jevTok * (((r.usage || {}).input_tokens) || 600) : 0), 0)); lat.push(t);
  }
  const n = rows.length, m = med(lat);
  return { n, by_answerer: by, background_by_answerer: bg, est_cost_per_1000: n ? Math.round(cost.reduce((a, b) => a + b, 0) / n * 1000 * ctx.margin * 1e4) / 1e4 : 0, est_p50_ms: m == null ? null : Math.round(m) };
}

// ---- grounded answers: the first of a route's oracle that answered (a person's fix still wins on top, from corrections)
/** Where an answerer's answers are stored on a request: the main plan's versions (latest or pinned) all under "model", as before. */
export function storageKey(id, pid = null) {
  if (/^model(@\d+)?$/.test(id)) return "model";
  const m = /^model:([0-9a-f]{8})@/.exec(id); if (m) return m[1] === pid ? "model" : "model:" + m[1];   // another route's model: one key per route
  return id.startsWith("url:") ? "endpoint:" + id.slice(4) : id;
}
const path = k => '$."' + k.replace(/"/g, "") + '"';
/** A version's own slot, kept next to the shared one so versions can be compared: "model@3" on its route, "model:<route>@3" elsewhere. */
export const versionKey = (id, pid, version) => { const k = storageKey(id, pid); return version && /^model(:[0-9a-f]{8})?$/.test(k) ? `${k}@${version}` : null; };
/** SQL that sets grounded_json / grounded_by from answers_json for one oracle list. → [sql fragment, binds] */
export function groundSql(oracle, pid = null) {
  const keys = [...new Set(oracle.map(id => storageKey(id, pid)))], x = k => "NULLIF(json_extract(answers_json, ?), '{}')";
  return [`grounded_json = COALESCE(${keys.map(x).join(", ")}, NULL), grounded_by = CASE ${keys.map(k => `WHEN ${x(k)} IS NOT NULL THEN ?`).join(" ")} ELSE NULL END`,
    [...keys.map(path), ...keys.flatMap(k => [path(k), k])]];
}
/** The grounded answer of one request's answers under an oracle list: [answerer id, answers] or [null, null]. */
export function groundOf(oracle, answers, pid = null) {
  for (const id of oracle) { const k = storageKey(id, pid), a = (answers || {})[k]; if (a && Object.keys(a).length) return [k, a]; }
  return [null, null];
}
export const oracleOf = (setup, routeId) => (setup.routes.find(r => r.id === routeId) || setup.routes[setup.routes.length - 1]).oracle;
/** Requests recorded before setups existed (or by a worker still on the old code) have no route: give them the route they would
    match now and its grounded answer. Cheap when there's nothing to do; ≤ 5,000 rows per call. */
export async function catchUp(env, pr, setup) {
  for (let i = 0; i < 5; i++) {
    const rows = (await env.DB.prepare("SELECT id, schema_id, via, source, answers_json FROM examples WHERE project_id = ? AND route IS NULL LIMIT 1000").bind(pr.id).all()).results;
    if (!rows.length) return;
    const st = rows.map(r => { const ro = routeOf(setup, { schema: r.schema_id, via: r.via, source: r.source }), [by, a] = groundOf(ro.oracle, J(r.answers_json, {}), pr.id);
      return env.DB.prepare("UPDATE examples SET route = ?, grounded_json = ?, grounded_by = ? WHERE id = ?").bind(ro.id, a ? JSON.stringify(a) : null, by, r.id); });
    for (let k = 0; k < st.length; k += 100) await env.DB.batch(st.slice(k, k + 100));
    if (rows.length < 1000) return;
  }
}
/** After a save: every past request of the model re-picks its grounded answer under its route's (new) oracle. A route that no longer
    exists hands its requests to the last route's oracle. */
export async function reground(env, pr, setup) {
  const ids = setup.routes.map(r => r.id), st = [];
  // labels someone pinned from the request pool ("use X's answers") stay as they are
  for (const r of setup.routes) { const [s, b] = groundSql(r.oracle, pr.id); st.push(env.DB.prepare(`UPDATE examples SET ${s} WHERE project_id = ? AND route = ? AND grounded_pinned = 0`).bind(...b, pr.id, r.id)); }
  const [s, b] = groundSql(setup.routes[setup.routes.length - 1].oracle, pr.id);
  st.push(env.DB.prepare(`UPDATE examples SET ${s} WHERE project_id = ? AND grounded_pinned = 0 AND route IS NOT NULL AND route NOT IN (${ids.map(() => "?").join(",")})`).bind(...b, pr.id, ...ids));
  await env.DB.batch(st);
}
