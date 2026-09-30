/* "Describe it": plain words → a setup, written by the generator (Gemini), checked by the same validation a save gets,
   with a one-line reason per block. Nothing is saved: the page shows it as a draft with the replay preview, and the person saves it. */
import { generator, hasGen } from "./gen.js";
import { loadSetup, setupContext, validateSetup, canonical } from "./setup.js";
import { catalogOf } from "./pool.js";

const SHAPE = `A setup is JSON: {"routes": [Route], "plans": [Plan], "checker": UpstreamId, "keep_awake": bool}.
Route = {"id": "short-id", "name": "…", "match": {"kinds": [kind ids], "keys": [key prefixes], "sources": ["traffic"|"typed"|"pasted"|"public"|"generated"]},
  "allow_header": bool (callers may pick the upstream per request), "steps": [{"ask": UpstreamId, "wait_ms": int, "unsure_below": 0..1 (optional)} | {"split": {UpstreamId: percent}, "wait_ms": int}],
  "background": [{"ask": UpstreamId, "pct": 0..100}], "oracle": [UpstreamId, …] (whose answers are the labels, first that answered wins),
  "fill_pct": 0..100 (if oracle[0] didn't answer, ask it afterwards on this % of requests), "cache_s": null | seconds}.
Routes are tried in order; the first whose match fits takes the request; empty lists match everything; the LAST route must match everything.
Steps are tried in order: move to the next step when an answer fails, is slower than wait_ms, or its least sure question is below unsure_below.
A trained model needs ~90000 wait_ms (it may be asleep); services ~30000.
Plan = {"id": "main", "name": "…", "base": BaseId, "epochs": 1..8, "cohort": null, "oracle": null | [UpstreamId] (labels override for training), "auto": null | {"first_at": int>=20, "every": int>=20, "until_agreement": bool}}.`;

/** → [status, {setup, reasons, note}] */
export async function describeSetup(env, ws, pr, text) {
  if (!hasGen(env)) return [503, { error: "Describing a setup needs a writer: set GEN_API_KEY (any OpenAI-compatible chat API; Gemini's works) and restart." }];
  const t = String(text || "").trim().slice(0, 2000); if (!t) return [400, { error: "Say what this route should do." }];
  const cur = await loadSetup(env, pr), ctx = await setupContext(env, pr, ws, cur.setup), cat = await catalogOf(env, ws);
  const ups = [...ctx.answerers.map(a => ({ id: a.id, name: a.name, ready: a.ready, why_not: a.why_not, per_1000_usd: a.per_1000_usd, p50_ms: a.p50_ms })),
    ...cat.upstreams.filter(u => !ctx.answerers.some(a => a.id === u.id)).map(u => ({ id: u.id, name: u.name, ready: u.ready, why_not: u.why_not, per_1000_usd: u.per_1000_usd, p50_ms: u.p50_ms }))];
  const facts = { route: pr.name, current_setup: cur.setup, upstreams: ups, kinds_of_requests: ctx.kinds.map(k => ({ id: k.id, name: k.name, requests: k.requests })), keys: ctx.keys, sources: ctx.sources, bases: ctx.bases };
  const system = `You configure Dopp, a router for decision APIs. ${SHAPE}
Use ONLY upstream ids, kind ids, key prefixes and base ids from the facts, and only upstreams with "ready": true for steps. Keep parts of the current setup the person didn't ask to change.
Reply with {"setup": Setup, "reasons": [{"block": "route <name>" | "labels" | "plan <name>" | "checks", "why": "one plain sentence for the route's owner: say what changes and why, by upstream NAME (never an id), citing the facts (volumes, prices, speed) when they matter"}], "note": "anything you couldn't do, or null"}.`;
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = JSON.stringify({ request: t, facts, ...(last ? { your_last_answer_was_rejected_because: last } : {}) });
    const out = await generator(env, system, user, { max_tokens: 3000, temperature: 0.2, pid: pr.id, note: "describe a setup" });
    // a route's model labelling its own route's requests trains it on itself: only when the person asked for exactly that
    const selfOk = /\b(label|oracle|right|truth|ground)/i.test(t) && /\bmodel\b/i.test(t) && !/\bjev\b/i.test(t.split(/label|oracle|right|truth|ground/i).pop() || "");
    const draft = out && out.setup && !selfOk ? { ...canonical(out.setup, pr.id), routes: (canonical(out.setup, pr.id).routes || []).map(r => { const o = (r.oracle || []).filter(x => x !== "model" && !/^model@\d+$/.test(x)); return { ...r, oracle: o.length ? o : cur.setup.routes[cur.setup.routes.length - 1].oracle }; }) } : out && out.setup;
    const [bad, clean] = validateSetup(draft, ctx._ids);
    if (!bad) return [200, { setup: clean, reasons: Array.isArray(out.reasons) ? out.reasons.slice(0, 12).map(r => ({ block: String(r.block || "").slice(0, 60), why: String(r.why || "").slice(0, 300) })) : [], note: out.note ? String(out.note).slice(0, 300) : null }];
    last = bad;
  }
  return [422, { error: "Couldn't turn that into a setup that works: " + last + ". Try saying it differently, or edit the setup by hand." }];
}

/** A setup proposed from the route's own traffic (its kinds of requests, volumes, how sure its current labeller is, what each upstream costs). */
export async function proposeSetup(env, ws, pr) {
  const rows = (await env.DB.prepare("SELECT schema_id, grounded_json FROM examples WHERE project_id = ? AND grounded_json IS NOT NULL ORDER BY t DESC LIMIT 300").bind(pr.id).all()).results;
  if (rows.length < 10) return [409, { error: `A proposal needs at least 10 labelled requests on this route; it has ${rows.length}.` }];
  const conf = [], unsure = {}; for (const r of rows) { let min = 1; for (const a of Object.values(JSON.parse(r.grounded_json) || {})) { const p = a.type === "noul" ? Math.max(+a.noul, 1 - +a.noul) : Math.max(0, ...Object.values(a.probabilities || {})); min = Math.min(min, p); } conf.push(min); if (min < 0.7) unsure[r.schema_id] = (unsure[r.schema_id] || 0) + 1; }
  const sure = Math.round(100 * conf.filter(x => x >= 0.7).length / conf.length);
  const cur = (await loadSetup(env, pr)).setup;
  const [c, o] = await describeSetup(env, ws, pr, `Propose the setup this route should run, from its traffic: the labeller was at least 70% sure on ${sure}% of the last ${rows.length} labelled requests (unsure ones by kind of request: ${JSON.stringify(unsure)}). Favour a trained model first with a fallback when one is ready and good, a route per kind of request when kinds behave differently, and the cheapest ready upstream that keeps labels trustworthy. Never make this route's own model the labeller (oracle) of its own route. Don't change training plans or keep-awake. Explain each choice with these numbers.`);
  if (c !== 200) return [c, o];
  // a proposal never spends on its own: plans (training) and keep-awake stay as they are; a route's model never labels its own training data
  const own = id => id === "model" || /^model@\d+$/.test(id) || id.startsWith("model:" + pr.id + "@");
  const setup = { ...o.setup, plans: cur.plans, keep_awake: cur.keep_awake, routes: o.setup.routes.map(r => { const oracle = r.oracle.filter(x => !own(x)); return { ...r, oracle: oracle.length ? oracle : cur.routes[cur.routes.length - 1].oracle }; }) };
  const reasons = o.reasons.filter(r => !/^plan\b/i.test(r.block) && !/keep.?awake/i.test(r.why));
  const ctx = await setupContext(env, pr, ws, cur), [bad, clean] = validateSetup(setup, ctx._ids);
  return bad ? [422, { error: "The proposal didn't hold together: " + bad }] : [200, { ...o, setup: clean, reasons }];
}
