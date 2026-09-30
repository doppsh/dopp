/* Analytics: GET /api/analytics?route=<id>&days=7|30 for the signed-in account.
   Three latencies, never mixed: end to end (Worker receives the request -> reply handed back, request_log.e2e_ms, from migration 0025),
   upstream call (waiting on answerers before the reply: request_log.upstream_ms, or the stored path's step times for older rows), and
   Dopp overhead (end to end minus upstream). Older rows only have `ms` (key check to reply), shown as "handler time".
   Counts and costs are SQL over the whole window; percentiles, fallbacks, confidence and agreement come from the newest SAMPLE rows. */
import { json, err } from "./lib.js";
import { projectsOf } from "./projects.js";
import { loadSetup, resolveAnswerer } from "./setup.js";
import { rowsOf, ctxOf, upstreamName } from "./answer.js";
import { marginOf } from "./ledger.js";

const SAMPLE = 5000, AGREE_SAMPLE = 2000, DAY = 86400, TRAFFIC_KINDS = ["jev", "llm", "serving"];
const J = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
/** Time waited on answerers before the reply: the steps run one after another, a timed-out step counts its wait. A cache hit waited 0. */
export function upstreamMs(path) {
  if (!path || typeof path !== "object") return null;
  if (path.cached) return 0;
  const st = (path.steps || []).filter(s => typeof s.ms === "number");
  return st.length ? Math.round(st.reduce((a, s) => a + s.ms, 0)) : null;
}
const pct = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null;   // nearest rank
function dist(xs) { const s = xs.filter(x => typeof x === "number" && isFinite(x)).sort((a, b) => a - b); return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99) }; }
const top = a => !a || typeof a !== "object" ? null : a.choice != null ? String(a.choice) : a.noul != null ? String(+a.noul >= 0.5) : a.probabilities ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null : null;
const dayOf = t => new Date(Math.floor(t / DAY) * DAY * 1000).toISOString().slice(0, 10);
const r4 = x => Math.round(x * 1e4) / 1e4;

export async function analyticsApi(env, url, ws) {
  const days = url.searchParams.get("days") === "30" ? 30 : 7, rid = url.searchParams.get("route") || null;
  const all = await projectsOf(env, ws), prs = rid ? all.filter(p => p.id === rid) : all;
  if (rid && !prs.length) return err("That route isn't in this account.", 404);
  const until = Date.now() / 1000, since = Math.floor(until / DAY - days + 1) * DAY;   // whole days, today included
  const out = { days, route: rid, since, until, sample_limit: SAMPLE, routes: all.map(p => ({ id: p.id, name: p.name })) };
  if (!prs.length) return json({ ...out, total: 0, empty: true });
  const ids = prs.map(p => p.id), IN = `project_id IN (${ids.map(() => "?").join(",")})`, q = (sql, ...b) => env.DB.prepare(sql).bind(...ids, ...b);
  const cols = "project_id, t, status, served, ms, path_json, fallback_json";
  const [daily, statuses, recentErr, charges, ex] = (await env.DB.batch([
    q(`SELECT CAST(t / ${DAY} AS INTEGER) d, served, status = 200 ok, COUNT(*) n FROM request_log WHERE ${IN} AND t >= ? GROUP BY d, served, ok`, since),
    q(`SELECT status, COUNT(*) n FROM request_log WHERE ${IN} AND t >= ? GROUP BY status`, since),
    q(`SELECT status, error FROM request_log WHERE ${IN} AND t >= ? AND status != 200 ORDER BY t DESC LIMIT 200`, since),
    q(`SELECT CAST(t / ${DAY} AS INTEGER) d, kind, SUM(usd) usd FROM charges WHERE ${IN} AND t >= ? AND billed = 1 GROUP BY d, kind`, since),
    q(`SELECT id, project_id, served, answers_json, grounded_json, grounded_by, json_extract(extra_json, '$.v') v FROM examples WHERE ${IN} AND t >= ? AND source = 'traffic' AND served IS NOT NULL AND (grounded_json IS NOT NULL OR id IN (SELECT example_id FROM corrections WHERE label_json IS NOT NULL)) ORDER BY t DESC LIMIT ${AGREE_SAMPLE}`, since)])).map(r => r.results);
  // your fixes on those requests: a fix is the label for its question
  const fixes = {};
  for (let i = 0; i < ex.length; i += 90) { const part = ex.slice(i, i + 90).map(e => e.id);
    for (const c of (await env.DB.prepare(`SELECT example_id, qid, label_json FROM corrections WHERE label_json IS NOT NULL AND example_id IN (${part.map(() => "?").join(",")})`).bind(...part).all()).results) (fixes[c.example_id] || (fixes[c.example_id] = {}))[c.qid] = J(c.label_json); }
  // the timing columns arrive with migration 0025; before it is applied the page still works on the older columns
  let rows, timed = true;
  try { rows = (await q(`SELECT ${cols}, e2e_ms, upstream_ms FROM request_log WHERE ${IN} AND t >= ? ORDER BY t DESC LIMIT ${SAMPLE}`, since).all()).results; }
  catch (e) { if (!/column/i.test(e.message)) throw e; timed = false; rows = (await q(`SELECT ${cols} FROM request_log WHERE ${IN} AND t >= ? ORDER BY t DESC LIMIT ${SAMPLE}`, since).all()).results; }
  const e2eSince = timed ? (await q(`SELECT MIN(t) t FROM request_log WHERE ${IN} AND e2e_ms IS NOT NULL`).first())?.t ?? null : null;

  // who answered, in plain words: one name per answerer across routes ("Jev", "support-triage v3", "GLiNER (open)")
  const base = await rowsOf(env, ws), ctx = {};
  for (const pr of prs) ctx[pr.id] = ctxOf(env, pr, ws, (await loadSetup(env, pr)).setup, base);
  const nameOf = (pid, id, v) => {
    if (!id) return "nobody";
    const c = ctx[pid], a = c && resolveAnswerer(c.setup, id);
    if (a && a.kind === "version") { const n = c.names[a.project || pid] || "a model", ver = v ?? (typeof a.version === "number" ? a.version : null); return ver ? `${n} v${ver}` : `${n} (version not recorded)`; }
    return c ? upstreamName(c, id) : id;
  };

  const total = statuses.reduce((s, r) => s + r.n, 0), okN = (statuses.find(r => r.status === 200) || {}).n || 0;
  // requests per day, by who answered (failed requests under "failed")
  const days_ = {}; for (let d = since / DAY; d <= Math.floor(until / DAY); d++) days_[d] = { day: dayOf(d * DAY), total: 0, failed: 0, by: {} };
  for (const r of daily) { const x = days_[r.d]; if (!x) continue; x.total += r.n; if (!r.ok) x.failed += r.n; }
  // who answered, per day: from the sample, because only the stored path says which version answered ("support-triage v3", not "the latest")

  // per request, from the sample: latencies by who answered, fallbacks, the unsure gate, confidence
  const by = {}, all_ = { e2e: [], upstream: [], overhead: [], handler: [] }, reasons = { slow: 0, error: 0, unsure: 0, skipped: 0 }, conf = Array(10).fill(0);
  let fb = 0, gate = 0, withPath = 0, nConf = 0;
  const slot = name => by[name] || (by[name] = { name, sample: 0, e2e: [], upstream: [], overhead: [], handler: [], call: [] });
  for (const r of rows) {
    const path = J(r.path_json), steps = (path && path.steps) || [], servedStep = path && steps.find(s => s.ask === path.served && s.ok);
    const name = r.status === 200 ? nameOf(r.project_id, r.served, servedStep && servedStep.v) : "failed (HTTP " + r.status + ")", x = slot(name);
    const up = r.upstream_ms ?? upstreamMs(path), e2e = r.e2e_ms ?? null;
    x.sample++; x.handler.push(r.ms); if (r.status === 200) { const dd = days_[Math.floor(r.t / DAY)]; if (dd) dd.by[name] = (dd.by[name] || 0) + 1; } all_.handler.push(r.ms);
    if (up != null) { x.upstream.push(up); all_.upstream.push(up); }
    if (e2e != null) { x.e2e.push(e2e); all_.e2e.push(e2e); if (up != null) { x.overhead.push(e2e - up); all_.overhead.push(e2e - up); } }
    for (const s of steps) if (s.ok && typeof s.ms === "number") slot(nameOf(r.project_id, s.ask, s.v)).call.push(s.ms);   // each answerer's own call, wherever it ran in the path
    if (r.status !== 200 || !path) continue;
    withPath++;
    const before = steps.slice(0, Math.max(0, steps.findIndex(s => s === servedStep)));
    if (r.fallback_json || before.length) fb++;
    for (const s of before) if (reasons[s.reason] != null) reasons[s.reason]++;
    if (steps.some(s => s.reason === "unsure")) gate++;
    if (servedStep && typeof servedStep.conf === "number") { conf[Math.min(9, Math.floor(servedStep.conf * 10))]++; nConf++; }
  }
  // agreement with the labels: where a request has a label (your fix, else the route's labeller's answer), the share of questions whose
  // top answer from the answerer that replied matched it. The labeller isn't scored against its own answer.
  const agree = {};
  for (const e of ex) {
    const a = J(e.answers_json, {}), mine = a[e.served], gr = J(e.grounded_json, {}) || {}, fx = fixes[e.id] || {}; if (!mine) continue;
    const labelOf = qid => fx[qid] != null && fx[qid] !== "__skip__" ? String(fx[qid]) : e.grounded_by !== e.served && gr[qid] ? top(gr[qid]) : null;
    const qs = Object.keys(mine).filter(qid => labelOf(qid) != null); if (!qs.length) continue;
    const n = nameOf(e.project_id, e.served, e.v), g = agree[n] || (agree[n] = { requests: 0, questions: 0, same: 0 });
    g.requests++; for (const qid of qs) { g.questions++; g.same += top(mine[qid]) === labelOf(qid) ? 1 : 0; }
  }
  // cost: what the account was charged (with margin) per day, by kind; per 1,000 requests from the per-request kinds
  const m = marginOf(env), costDays = {}; let traffic = 0, spent = 0;
  for (const c of charges) { const k = dayOf(c.d * DAY), usd = c.usd * m; (costDays[k] = costDays[k] || {})[c.kind] = r4(((costDays[k] || {})[c.kind] || 0) + usd); spent += usd; if (TRAFFIC_KINDS.includes(c.kind)) traffic += usd; }

  const shareBase = rows.filter(r => r.status === 200).length;
  const answerers = Object.values(by).filter(x => x.sample || x.call.length).map(x => ({ name: x.name, failed: x.name.startsWith("failed"), requests: x.sample, share: shareBase && !x.name.startsWith("failed") ? r4(x.sample / shareBase) : null,
    e2e: dist(x.e2e), upstream: dist(x.upstream), overhead: dist(x.overhead), handler: dist(x.handler), call: dist(x.call),
    agreement: agree[x.name] ? { requests: agree[x.name].requests, questions: agree[x.name].questions, rate: agree[x.name].questions ? r4(agree[x.name].same / agree[x.name].questions) : null } : null }))
    .sort((a, b) => a.failed - b.failed || b.requests - a.requests);
  const lastErr = {}; for (const r of recentErr) if (!(r.status in lastErr)) lastErr[r.status] = r.error;
  return json({ ...out, total, empty: !total, sample: rows.length, capped: rows.length === SAMPLE && total > SAMPLE, sample_since: rows.length ? rows[rows.length - 1].t : null,
    e2e_recorded_since: e2eSince, timing_columns: timed,
    daily: Object.values(days_),
    latency: { e2e: dist(all_.e2e), upstream: dist(all_.upstream), overhead: dist(all_.overhead), handler: dist(all_.handler) },
    answerers,
    fallbacks: { requests: fb, of: withPath, rate: withPath ? r4(fb / withPath) : null, reasons, unsure_gate: { requests: gate, rate: withPath ? r4(gate / withPath) : null } },
    confidence: { n: nConf, buckets: conf },
    errors: { requests: total - okN, rate: total ? r4((total - okN) / total) : null, by_status: statuses.filter(r => r.status !== 200).sort((a, b) => b.n - a.n).map(r => ({ status: r.status, requests: r.n, last_error: lastErr[r.status] || null })) },
    cost: { margin: m, daily: Object.entries(costDays).sort().map(([day, kinds]) => ({ day, kinds })), total_usd: r4(spent), traffic_usd: r4(traffic), per_1000: total ? r4(traffic / total * 1000) : null, traffic_kinds: TRAFFIC_KINDS } });
}
