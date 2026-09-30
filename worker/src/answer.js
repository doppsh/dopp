/* Asking any upstream: Jev, an LLM, a service that speaks Jev's API, or a trained model of any of the account's
   routes. One call shape for replies, background answers, labelling, batch asks and checks. */
import { familyOf, decrypt, upstreamOf, jevFetch, predict, EngineError, UA, baseReady, containerOf, OPEN_BASES, openName } from "./lib.js";
import { chargeServing } from "./ledger.js";
import { resolveAnswerer, connectionsOf, loadSetup } from "./setup.js";
import { llmAsk, llmWhyNot, parseLlm } from "./upstreams.js";

/** What asking needs: the account (whose keys), its connections, the setup, every route's models and names. */
export async function answerCtx(env, pr, ws, setup, ms = null) { return ctxOf(env, pr, ws, setup, await rowsOf(env, ws), ms); }
/** The account's rows asking reads (the proxy reads the same rows in its one batch, index.js keyContext). */
export async function rowsOf(env, ws) {
  const [conns, projects, models] = await Promise.all([connectionsOf(env, ws),
    env.DB.prepare("SELECT id, name FROM projects WHERE workspace_id = ?").bind(ws.id).all().then(r => r.results),
    env.DB.prepare("SELECT m.* FROM models m JOIN projects p ON p.id = m.project_id WHERE p.workspace_id = ? ORDER BY m.project_id, m.version").bind(ws.id).all().then(r => r.results)]);
  return { conns: conns.rows, projects, models };
}
// ctx.later(promise), when set, runs bookkeeping (charges) after the reply instead of before it
export function ctxOf(env, pr, ws, setup, { conns, projects, models }, ms = null) {
  const byProject = {}; for (const m of models) (byProject[m.project_id] || (byProject[m.project_id] = [])).push(m);
  return { env, pr, ws, setup, conns: Object.fromEntries(conns.map(c => [c.id, c])), ms: ms || byProject[pr.id] || [], byProject, names: Object.fromEntries(projects.map(p => [p.id, p.name])) };
}
const bill = (ctx, p) => ctx.later ? ctx.later(p) : p;
/** The version a model upstream stands for right now (its plan's latest ready one, or the pinned one), or null. */
export function versionFor(ctx, a) {
  const pid = a.project || ctx.pr.id, mine = pid === ctx.pr.id ? ctx.ms : ctx.byProject[pid] || [];
  const ready = mine.filter(m => m.status === "ready" && (a.project ? true : (m.plan || "main") === a.plan));
  return a.version === "latest" ? ready[ready.length - 1] || null : ready.find(m => m.version === a.version) || null;
}
// ctx.hosting (routing.js systemone): {project id → billing.js hostingOf} for models on our GPUs; absent = not checked here
const hostingFor = (ctx, a) => ctx.hosting && (a.kind === "version" || a.kind === "open") ? ctx.hosting[a.kind === "version" && a.project ? a.project : ctx.pr.id] || null : null;
const included = (ctx, a) => { const h = hostingFor(ctx, a); return !!(h && h.subscribed); };   // a hosting subscription includes serving
/** → null if it can answer now, else why not (plain words). */
export function whyNot(ctx, id) {
  const a = resolveAnswerer(ctx.setup, id); if (!a) return "it isn't an upstream this account has";
  if (a.kind === "person") return "you label by hand (fix an answer on Requests); nobody is asked";
  const h = hostingFor(ctx, a); if (h && !h.allowed) return "hosting is paused: " + h.why;
  if (a.kind === "llm") return llmWhyNot(ctx.env, ctx.conns, parseLlm(a.id));
  if (a.kind === "open") return baseReady(ctx.env, a.base) ? null : "its engine isn't deployed on this server yet";
  if (a.kind === "connection") return a.connection === "jev" || ctx.conns[a.connection] ? null : "that connection was removed";
  if (a.project && !ctx.names[a.project]) return "that route isn't in this account";
  const v = versionFor(ctx, a); if (!v) return "there's no trained version yet";
  // Tiny versions run where they're downloaded (python serve.py), not on this server
  return familyOf(v.base) === "tiny" ? `${ctx.names[a.project || ctx.pr.id] || "this model"} v${v.version} is a Tiny model: it runs where you download it, not on this server` : null;
}
/** What a person reads for an upstream id. */
export function upstreamName(ctx, id) {
  const a = resolveAnswerer(ctx.setup, id); if (!a) return id;
  if (a.kind === "person") return "You";
  if (a.kind === "open") return `${openName(a.base)} (open)`;
  if (a.kind === "llm") { const l = parseLlm(a.id); return l ? l.model + (l.provider === "openrouter" ? "" : l.provider === "gemini" ? " (Gemini)" : " (" + ((ctx.conns[l.conn] || {}).name || "OpenAI-compatible") + ")") : id; }
  if (a.kind === "connection") return a.connection === "jev" ? "Jev" : (ctx.conns[a.connection] || {}).name || "a removed service";
  const m = versionFor(ctx, a), name = ctx.names[a.project || ctx.pr.id] || "a model";
  return m ? `${name} v${m.version}` : `${name} (no trained version yet)`;
}
const fail = (code, msg, ms) => ({ ok: false, code, raw: JSON.stringify({ error: msg }), ms });
/** Ask one upstream. → {ok, answers, ms, resp, version?} | {ok:false, code, raw, ms} */
export async function ask(ctx, id, body, note = "traffic") {
  const t0 = Date.now(), ms = () => Date.now() - t0, a = resolveAnswerer(ctx.setup, id), env = ctx.env;
  const why = whyNot(ctx, id); if (why) return fail(409, `${upstreamName(ctx, id)} can't answer: ${why}`, 0);
  try {
    if (a.kind === "llm") { const r = await llmAsk(env, ctx.conns, a.id, body, { pid: ctx.pr.id, note }); return { ...r, ms: ms() }; }
    if (a.kind === "open") {   // an open base model, untrained: the engine's version 0, one shared pool per engine
      const out = await predict(env, { project: "open", version: 0, items: [{ state: body.state, questions: body.questions }] }, a.base);
      if (!included(ctx, a)) await bill(ctx, chargeServing(env, ctx.pr.id, containerOf(a.base, "open", 0), (OPEN_BASES[a.base] || {}).gpu || "T4"));
      const answers = (out.answers || [])[0]; if (!answers) return fail(502, "the model returned no answers", ms());
      return { ok: true, answers, ms: ms(), resp: { answers, usage: { input_tokens: 0, output_tokens: 0 } } };
    }
    if (a.kind === "version") {
      const m = versionFor(ctx, a), pid = a.project || ctx.pr.id;
      const out = await predict(env, { project: pid, version: m.version, items: [{ state: body.state, questions: body.questions }] }, m.base || "laya");
      // GPU time the model's container runs. Laya/Kev versions answer from the shared box (Modal scaledown 120 s) unless the setup keeps a
      // dedicated container awake (600 s); GLiNER versions have their own 600 s container.
      const idle = familyOf(m.base) === "gliner" || (ctx.setup && ctx.setup.keep_awake) ? 600 : 120;
      if (!included(ctx, a)) await bill(ctx, chargeServing(env, ctx.pr.id, containerOf(m.base || "laya", pid, m.version), "T4", idle));
      const answers = (out.answers || [])[0]; if (!answers) return fail(502, "the model returned no answers", ms());
      return { ok: true, answers, ms: ms(), version: m.version, resp: { answers, usage: { input_tokens: 0, output_tokens: 0 } } };
    }
    let r;
    const jevModel = /^jev/.test(String(body.model || "")) ? body.model : "jev-latest";   // a caller's `model` naming another upstream isn't Jev's model name
    if (a.connection === "jev") r = await jevFetch(await upstreamOf(env, ctx.ws), { model: jevModel, state: body.state, questions: body.questions }, null, { env, ws: ctx.ws, pid: ctx.pr.id, note, later: ctx.later });
    else { const c = ctx.conns[a.connection]; r = await fetch(c.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA, ...(c.auth_enc ? { authorization: "Bearer " + await decrypt(env, c.auth_enc) } : {}) }, body: JSON.stringify({ model: jevModel, state: body.state, questions: body.questions }), signal: AbortSignal.timeout(30000) }); }
    const raw = await r.text(); if (r.status !== 200) return { ok: false, code: r.status, raw, ms: ms() };
    const resp = JSON.parse(raw); if (!resp || !resp.answers) return fail(502, "the reply had no answers", ms());
    return { ok: true, answers: resp.answers, ms: ms(), resp };
  } catch (e) { return fail(e instanceof EngineError ? e.status : 502, `${upstreamName(ctx, id)} failed: ${String(e.text || e.message).slice(0, 300)}`, ms()); }
}
/** A judgement the product makes for itself about a route's data (realism of generated requests, dataset fit): asked of the setup's
    checker, never recorded, no routing. → answers, or throws an EngineError whose body says who failed and why. */
export async function checkDecide(env, ws, pr, state, questions, note = "decision") {
  const S = (await loadSetup(env, pr)).setup, ctx = await answerCtx(env, pr, ws, S);
  const r = await ask(ctx, S.checker, { model: "jev-latest", state, questions }, note);
  if (!r.ok) throw new EngineError(r.code || 502, JSON.stringify({ error: `The checker (${upstreamName(ctx, S.checker)}) couldn't answer: HTTP ${r.code} ${String(r.raw || "").slice(0, 200)}` }));
  return r.answers || {};
}
