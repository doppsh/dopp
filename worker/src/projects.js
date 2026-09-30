/* Projects: a workspace's units of work. Each has a tenant id (`<ws>` for the first, `<ws>_<pid>` after that) that prefixes its question-set ids.
   Routes: /api/projects and /api/p/:id/*. Data lives in D1 (data.js); the engine is only called to train, predict and download checkpoints. */
import { downloadable } from "./pool.js";
import { json, err, now, short, rand, sha256, body, encrypt, engineFetch, passthrough, EngineError, engine } from "./lib.js";
import { hasGen, nameFromQuestions, generate, planFor, parse, findDatasets, useDataset, ingestAll } from "./gen.js";
import { tally, modelView, setView, stats, listExamples, listRequests, cleanCohort, correct, startTraining, ensureSet, validQuestions, recentRows, currentVersion, modelsOf, removeExamples, trainEstimate, labelPending } from "./data.js";
import { creditsOf } from "./ledger.js";
import { requireCredit, canTrain } from "./billing.js";
import { loadRouting, saveRouting, publicRouting, validate, preview, systemone, servingOf, noteAwake, PING } from "./routing.js";
import { predict, familyOf, isKev, containerOf } from "./lib.js";
import { chargeServing } from "./ledger.js";
import { pendingCopy } from "./files.js";
import { forgetKeyContext, KEY_CTX_MS, loadSetup, saveSetup, setupHistory, setupVersion, setupContext, validateSetup, previewSetup, reground, connectionsOf } from "./setup.js";

// GET /setup: the setup in force plus everything the Setup page shows around it (answerers with measured time/price, connections, kinds, keys, …)
async function setupPayload(env, pr, ws) { const cur = await loadSetup(env, pr), ctx = await setupContext(env, pr, ws, cur.setup); delete ctx._ids; return { ...cur, ...ctx, applies_within_s: Math.round(KEY_CTX_MS / 1000) }; }

export async function projectsOf(env, ws) {
  let rows = (await env.DB.prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at").bind(ws.id).all()).results;
  // bootstrap, only for accounts from before routes: their keys (made without a route) become route "Default". A new account starts with none.
  if (!rows.length && (await env.DB.prepare("SELECT 1 FROM proxy_keys WHERE workspace_id = ? AND project_id IS NULL LIMIT 1").bind(ws.id).first())) {
    await env.DB.prepare("INSERT OR IGNORE INTO projects (id, workspace_id, name, description, tags_json, keywords_json, tenant, created_at, settings_json) VALUES (?,?,?,?,?,?,?,?,?)").bind(short(), ws.id, "Default", null, "[]", "[]", ws.id, now(), "{}").run();
    rows = (await env.DB.prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at").bind(ws.id).all()).results;
    await env.DB.prepare("UPDATE proxy_keys SET project_id = ? WHERE workspace_id = ? AND project_id IS NULL").bind(rows[0].id, ws.id).run();
  }
  return rows;
}
const view = p => ({ id: p.id, name: p.name, description: p.description, tags: JSON.parse(p.tags_json || "[]"), keywords: JSON.parse(p.keywords_json || "[]"), tenant: p.tenant, created_at: p.created_at });
// keys with project_id NULL (made by the legacy /api/keys before bootstrap) belong to the first project
const keysOf = (env, ws, p, first) => env.DB.prepare("SELECT id, prefix, created_at, revoked_at, last_used_at FROM proxy_keys WHERE workspace_id = ? AND (project_id = ? OR (? AND project_id IS NULL)) ORDER BY created_at DESC").bind(ws.id, p.id, first ? 1 : 0).all().then(r => r.results);
const endpointsOf = async (env, pid) => Object.fromEntries((await env.DB.prepare("SELECT * FROM endpoints WHERE project_id = ?").bind(pid).all()).results.map(e => [e.id, e]));
const schemaMeta = async (env, ws) => Object.fromEntries((await env.DB.prepare("SELECT schema_id, name, archived_at FROM schema_meta WHERE workspace_id = ?").bind(ws.id).all()).results.map(x => [x.schema_id, x]));
async function routingView(env, pr) { const [[cfg, custom], eps] = await Promise.all([loadRouting(env, pr.id), endpointsOf(env, pr.id)]); return publicRouting(cfg, eps, custom); }
// GET /api/p/:id and /api/demo: the question-set list with readiness, agreement and the project's model group
// a set with no examples that nobody declared (e.g. left by a connectivity test) is noise: not listed
export async function setList(env, ws, pr, opts) { const T = await tally(env, pr); const [mv, meta] = await Promise.all([modelView(env, pr, T), schemaMeta(env, ws)]); return { T, mv, sets: T.sets.filter(s => s.declared || T.by[s.id].n > 0).map(s => setView(T.by[s.id], mv, meta, opts)).sort((a, b) => b.readiness.calls - a.readiness.calls) }; }
async function saveNaming(env, p, n, { rename } = {}) {
  await env.DB.prepare("UPDATE projects SET name = ?, description = COALESCE(?, description), tags_json = ?, keywords_json = ? WHERE id = ?")
    .bind(rename && n.name ? n.name : p.name, n.description, JSON.stringify(n.tags || []), JSON.stringify(n.keywords || []), p.id).run();
}

async function declare(env, ws, p, questions, user, ctx) {
  const bad = validQuestions(questions); if (bad) throw Object.assign(new Error(bad), { status: 400 });
  const s = await ensureSet(env, p, questions, { declared: true }), d = { id: s.id, created: s.created };
  // the generator's name/tags/keywords are nice-to-have: fill them in after the response, never on the critical path
  if (hasGen(env)) {
    const later = (async () => {
      try { const naming = await nameFromQuestions(env, questions);
        if (naming.name) await env.DB.prepare("INSERT INTO schema_meta (workspace_id, schema_id, name, archived_at) VALUES (?,?,?,NULL) ON CONFLICT(workspace_id, schema_id) DO UPDATE SET name = COALESCE(schema_meta.name, excluded.name)").bind(ws.id, d.id, naming.name).run();
        if (!JSON.parse(p.keywords_json || "[]").length) await saveNaming(env, p, naming, { rename: /^Project \d+$/.test(p.name) });
      } catch (_) { /* naming is optional */ }
    })();
    if (ctx) ctx.waitUntil(later);
  }
  return d;
}

export async function projectsApi(req, env, ctx, url, user, ws) {
  const p = url.pathname;
  if (p === "/api/credits" && req.method === "GET") {   // the account's usage: every model's credits, summed, with the same lines and margin
    const rows = await projectsOf(env, ws); const per = await Promise.all(rows.map(r => creditsOf(env, r.id)));
    const lines = {}; for (const c of per) for (const l of c.lines) { const x = lines[l.kind] || (lines[l.kind] = { kind: l.kind, calls: 0, units: 0, usd: 0 }); x.calls += l.calls; x.units += l.units; x.usd += l.usd; }
    return json({ used: Math.round(per.reduce((s, c) => s + c.used, 0) * 1e6) / 1e6, by_project: rows.map((r, i) => ({ id: r.id, name: r.name, used: per[i].used })), lines: Object.values(lines).map(l => ({ ...l, usd: Math.round(l.usd * 1e6) / 1e6 })), margin: per[0] ? per[0].margin : +(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1), on_us: { calls: per.reduce((s, c) => s + c.on_us.calls, 0), usd: Math.round(per.reduce((s, c) => s + c.on_us.usd, 0) * 1e6) / 1e6, what: per[0] ? per[0].on_us.what : null }, unmetered: [] });
  }
  if (p === "/api/projects" && req.method === "GET") {
    const rows = await projectsOf(env, ws);
    return json(await Promise.all(rows.map(async (r, i) => {
      const [keys, n, model] = await Promise.all([keysOf(env, ws, r, i === 0), env.DB.prepare("SELECT COUNT(*) n FROM examples WHERE project_id = ?").bind(r.id).first(), modelView(env, r)]);
      return { ...view(r), keys: keys.filter(k => !k.revoked_at).length, examples: n.n, model: { version: model.version, status: model.status } };
    })));
  }
  if (p === "/api/projects" && req.method === "POST") {
    const b = await body(req); const rows = await projectsOf(env, ws);
    const id = short(); const pr = { id, workspace_id: ws.id, name: String(b.name || "").trim().slice(0, 60) || "Project " + (rows.length + 1), description: null, tags_json: "[]", keywords_json: "[]", tenant: ws.id + "_" + id, created_at: now(), settings_json: "{}" };
    await env.DB.prepare("INSERT INTO projects (id, workspace_id, name, description, tags_json, keywords_json, tenant, created_at, settings_json) VALUES (?,?,?,?,?,?,?,?,?)").bind(pr.id, pr.workspace_id, pr.name, null, "[]", "[]", pr.tenant, pr.created_at, "{}").run();
    let declared = null;
    if (b.questions) {   // auto-name only when the user didn't: saveNaming renames "Project N" but never a chosen name
      try { declared = await declare(env, ws, pr, b.questions, user, ctx); } catch (e) { return err(e.message, e.status || 500); }
    }
    const fresh = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
    return json({ ...view(fresh), ...(declared ? { question_set: declared } : {}) });
  }

  const m = p.match(/^\/api\/p\/([0-9a-f]{8})(\/.*)?$/); if (!m) return null;
  const all = await projectsOf(env, ws); const idx = all.findIndex(r => r.id === m[1]); if (idx < 0) return err("No such project in your workspace.", 404);
  const pr = all[idx], T = pr.tenant, rest = m[2] || "", mine = s => String(s || "").startsWith(T + "-"), M = req.method;

  if (rest === "" && M === "GET") {
    const [keys, { mv, sets }, routing, st, eps] = await Promise.all([keysOf(env, ws, pr, idx === 0), setList(env, ws, pr), routingView(env, pr), stats(env, pr),
      connectionsOf(env, ws).then(c => c.rows)]);   // every service the account has connected can answer this model (Try it lists them)
    // kinds of requests get a human name from the generator once they have real requests; done in the background, once per kind
    if (hasGen(env)) for (const s of sets) if (!s.plan && s.readiness.calls > 0) ctx.waitUntil(import("./synth.js").then(m => import("./data.js").then(d => d.setOf(env, pr, s.id)).then(set => set && m.plan(env, ws, pr, set))).catch(e => console.log("plan " + s.id + ": " + e.message)));
    if (mv.version && mv.base !== "tiny") mv.serving = await servingOf(env, pr.id);   // Tiny runs where it's downloaded, never hosted
    return json({ project: view(pr), keys, question_sets: sets, model: mv, routing, stats: st, endpoints: eps.map(x => ({ id: x.id, target: "endpoint:" + x.id, name: x.name, url: x.url, has_key: !!x.auth_enc, created_at: x.created_at })),
      proxy_url: url.origin + "/v1/systemone" });
  }
  if (rest === "" && M === "POST") {
    const b = await body(req);
    await env.DB.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?").bind("name" in b ? (String(b.name || "").trim().slice(0, 60) || pr.name) : pr.name, "description" in b ? (b.description ? String(b.description).slice(0, 500) : null) : pr.description, pr.id).run();
    return json(view(await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(pr.id).first()));
  }
  if (rest === "/keys" && M === "POST") {
    const key = "us_" + rand(20); const id = short();
    await env.DB.prepare("INSERT INTO proxy_keys (id, key_hash, workspace_id, prefix, created_at, project_id) VALUES (?,?,?,?,?,?)").bind(id, await sha256(key), ws.id, key.slice(0, 8), now(), pr.id).run();
    return json({ id, key, prefix: key.slice(0, 8) });   // the only time the full key is ever returned
  }
  if (rest === "/keys" && M === "GET") return json(await keysOf(env, ws, pr, idx === 0));
  if (rest === "/setup-link" && M === "POST") {   // Connect an agent: one curl writes a fresh key into .env; the key is minted at redemption, so nobody sees it
    const token = rand(16);
    await env.DB.prepare("INSERT INTO setup_links (token, project_id, workspace_id, created_at) VALUES (?,?,?,?)").bind(token, pr.id, ws.id, now()).run();
    const link = url.origin + "/setup/" + token;
    const site = env.SELF_URL || url.origin;   // this server's address (https://dopp.sh on the hosted service)
    return json({ token, link, expires_in_s: 900, line: `curl -sf ${link} >> .env`, prompt: `Switch this codebase's Jev (TypeSafe /v1/systemone) calls to go through Dopp, a proxy I set up at ${site}. It forwards each request to TypeSafe unchanged and keeps a log of those requests so I can train my own model on them; it receives nothing else from this repo. Steps: (1) read ${site}/skill.md, which explains what Dopp is and the exact change; (2) make sure .env is in .gitignore; (3) run "curl -sf ${link} >> .env" once. It appends DOPP_BASE_URL and DOPP_KEY to .env; the link is one-time and expires in 15 minutes, and appending keeps the key out of this conversation. (4) Change the base URL to ${site} and read the bearer token from DOPP_KEY. Nothing else changes: same request body, same response.` });
  }
  if (rest === "/keys/revoke" && M === "POST") {
    const { id } = await body(req);
    const r = await env.DB.prepare("UPDATE proxy_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND (project_id = ? OR (? AND project_id IS NULL))").bind(now(), id, ws.id, pr.id, idx === 0 ? 1 : 0).run();
    return r.meta.changes ? json({ ok: true }) : err("No such key in this project.", 404);
  }
  if (rest === "/question-sets" && M === "POST") return json(await declare(env, ws, pr, (await body(req)).questions, user, ctx));
  if (rest === "/examples" && M === "GET") return json(await listExamples(env, pr, url.searchParams));
  if (rest === "/requests" && M === "GET") return json(await listRequests(env, pr, url.searchParams));
  if (rest === "/examples/remove" && M === "POST") { const b = await body(req); if (b.schema && !mine(b.schema)) return err("schema must be one of this project's question-sets.", 403); const [c, o] = await removeExamples(env, pr, b); return json(o, c); }
  if (rest === "/examples/stats" && M === "GET") return json(await stats(env, pr, url.searchParams.get("schema") || null));
  if (rest === "/examples/correct" && M === "POST") {
    const b = await body(req); if (!mine(b.id)) return err("Not an example of this project.", 403);
    const [code, out] = await correct(env, pr, b, user.email); return json(out, code);
  }
  if (rest === "/try" && M === "POST") {   // the playground: one request, answered by the answerer you pick (plus any to compare), logged like every other request
    const b = await body(req);
    if (b.state === undefined || b.state === null || b.state === "") return err("state is required.");
    if (!b.questions || typeof b.questions !== "object" || !Object.keys(b.questions).length) return err("questions is required.");
    const compare = Array.isArray(b.compare) ? b.compare.map(String).slice(0, 6) : [];
    return systemone(env, ctx, pr, ws, { model: "jev-latest", state: b.state, questions: b.questions }, { via: "try", source: "typed", only: b.target ? String(b.target) : null, compare });
  }
  if (rest === "/examples/typed" && M === "POST") {
    const b = await body(req);
    if (b.state === undefined || b.state === null || b.state === "") return err("state is required.");
    if (!b.questions || typeof b.questions !== "object" || !Object.keys(b.questions).length) return err("questions is required.");
    return systemone(env, ctx, pr, ws, { model: b.model || "jev-latest", state: b.state, questions: b.questions }, { via: "playground", source: "typed", xtarget: b.target ? String(b.target) : null });
  }
  if (rest === "/examples/paste" && M === "POST") { await requireCredit(env, ws);
    const b = await body(req); if (!mine(b.schema)) return err("schema must be one of this project's question-sets.", 403);
    const states = (Array.isArray(b.states) ? b.states : []).filter(s => s !== null && s !== undefined && s !== "");
    if (!states.length) return err("states is empty."); if (states.length > 1000) return err("Paste at most 1,000 examples at a time.");
    return json(await ingestAll(env, ws, T, b.schema, states, "pasted", "paste", b.meta));
  }
  if (rest === "/examples/parse" && M === "POST") return parse(env, ws, await body(req), pr.id);
  if (rest === "/examples/label-pending" && M === "POST") { await requireCredit(env, ws); const b = await body(req); if (b.schema && !mine(b.schema)) return err("schema must be one of this project's question-sets.", 403); return json(await labelPending(env, ws, pr, b.schema || null)); }
  if (rest === "/examples/plan" && M === "POST") { const b = await body(req); if (!mine(b.schema)) return err("schema must be one of this project's question-sets.", 403); return planFor(env, ws, T, b); }
  if (rest === "/model/estimate" && M === "GET") { let c = null; try { c = cleanCohort(JSON.parse(url.searchParams.get("cohort") || "null")); } catch (_) { return err("cohort must be JSON"); } return json(await trainEstimate(env, pr, url.searchParams.get("base") || "laya", Math.max(1, Math.min(8, +url.searchParams.get("epochs") || 2)), c)); }
  if (rest === "/examples/generate" && M === "POST") { await requireCredit(env, ws); const b = await body(req); if (b.schema && !mine(b.schema)) return err("schema must be one of this project's question-sets.", 403); return generate(env, ws, T, b); }
  if (rest === "/datasets/find" && M === "GET") {
    const s = url.searchParams.get("schema"); if (s && !mine(s)) return err("schema must be one of this project's question-sets.", 403);
    return findDatasets(env, ws, pr, T, s, n => saveNaming(env, pr, n, { rename: false }), url.searchParams.get("q"));
  }
  if (rest === "/datasets/use" && M === "POST") { await requireCredit(env, ws); const b = await body(req); if (b.schema && !mine(b.schema)) return err("schema must be one of this project's question-sets.", 403); return useDataset(env, ws, T, b); }
  if (rest === "/credits" && M === "GET") return json(await creditsOf(env, pr.id));
  if (rest === "/model" && M === "GET") { const mv = await modelView(env, pr); if (mv.version && mv.base !== "tiny") mv.serving = await servingOf(env, pr.id); return json(mv); }
  if (rest === "/model/export-web" && M === "POST") {   // (re)make a version's browser copy; the engine reports back when done or failed
    const b = await body(req), ms = await modelsOf(env, pr.id), v = +b.version || currentVersion(ms), m = ms.find(x => x.version === v && x.status === "ready");
    if (!m) return err("no such trained version", 404); if (familyOf(m.base) !== "laya") return err("Only Laya versions can run in the browser yet", 400); if (!env.SELF_URL) return err("SELF_URL is not configured", 503);
    // preparing from now (a working private copy stays in use until the new one is back); files.js says what web_url holds
    await env.DB.prepare("UPDATE models SET web_error = NULL, web_url = CASE WHEN web_url LIKE 'private:%' THEN web_url ELSE ? END WHERE project_id = ? AND version = ?").bind(pendingCopy(), pr.id, v).run();
    let r; try { r = await engine(env, "/export/" + pr.id + "/" + v, { method: "POST", body: JSON.stringify({ web_upload_url: env.SELF_URL }) }, m.base); }
    catch (e) { await env.DB.prepare("UPDATE models SET web_error = ? WHERE project_id = ? AND version = ?").bind("couldn't start: " + String(e.message || e).slice(0, 200), pr.id, v).run(); throw e; }
    return json({ ok: true, job: r.job, version: v });
  }
  if (rest === "/model/wake" && M === "POST") {   // one tiny request to the current version, so the next real request finds it awake
    const ms = await modelsOf(env, pr.id), v = currentVersion(ms); if (!v) return err("no trained model yet", 404);
    const m = ms.find(x => x.version === v); const t0 = Date.now();
    try { await predict(env, { project: pr.id, version: v, items: [PING] }, m && m.base); await chargeServing(env, pr.id, containerOf((m && m.base) || "laya", pr.id, v), "T4", 600, "wake on request"); } catch (e) { if (e instanceof EngineError) return err("Couldn't wake v" + v + ": " + String(e.text || e.message).slice(0, 200), 502); throw e; }
    await noteAwake(env, pr.id); return json({ ok: true, version: v, seconds: Math.round((Date.now() - t0) / 1000) });
  }
  if (rest === "/model/train" && M === "POST") { await requireCredit(env, ws);
    const b = await body(req);
    const capped = await canTrain(env, ws, pr); if (capped) return err(capped, 402);   // billing.js: the hosted-model cap on free credit
    const S = (await loadSetup(env, pr)).setup, plan = S.plans.find(x => x.id === b.plan) || S.plans[0];   // a run belongs to a plan (its labels override, its versions)
    try { return json(await startTraining(env, pr, b.base || plan.base, !!b.smoke, Math.max(1, Math.min(8, +b.epochs || plan.epochs || 2)), false, b.cohort !== undefined ? cleanCohort(b.cohort) : plan.cohort, plan)); } catch (e) { if (e instanceof EngineError) throw e; if (e.status) return json(e.body || { error: e.message }, e.status); throw e; }
  }
  if (rest === "/model/download" && M === "GET") {
    const ms = await modelsOf(env, pr.id), v = parseInt(url.searchParams.get("version") || "") || currentVersion(ms); if (!v) return err("No trained model yet.", 404);
    const m = ms.find(x => x.version === v); if (!m) return err("No such version.", 404);
    if (!downloadable(m.base)) return err(`${pr.name} v${v} can't be downloaded yet: its base's engine doesn't hand back checkpoints.`, 409);
    const r = await engineFetch(env, `/checkpoint/${pr.id}/${v}`, {}, m.base); if (!r.ok) return passthrough(r);
    const h = new Headers({ "content-type": r.headers.get("content-type") || "application/x-tar", "content-disposition": `attachment; filename="${pr.name.replace(/[^\w.-]+/g, "_")}-v${v}.tar"` });
    if (r.headers.get("content-length")) h.set("content-length", r.headers.get("content-length"));
    return new Response(r.body, { status: 200, headers: h });
  }
  if (rest === "/setup" && M === "GET") return json(await setupPayload(env, pr, ws));
  if (rest === "/setup" && M === "PUT") {
    const b = await body(req), cur = await loadSetup(env, pr), ctx = await setupContext(env, pr, ws, cur.setup);
    const [bad, clean] = validateSetup(b.setup, ctx._ids); if (bad) return err(bad, 400);
    await saveSetup(env, pr, clean, user.email, b.note); forgetKeyContext(pr.id); await reground(env, pr, clean);   // a changed oracle re-picks past requests' grounded answers
    return json(await setupPayload(env, pr, ws));
  }
  if (rest === "/setup/describe" && M === "POST") { const { describeSetup } = await import("./describe.js"); const [c, o] = await describeSetup(env, ws, pr, (await body(req)).text); return json(o, c); }
  if (rest === "/setup/propose" && M === "POST") { const { proposeSetup } = await import("./describe.js"); const [c, o] = await proposeSetup(env, ws, pr); return json(o, c); }
  if (rest === "/setup/history" && M === "GET") return json({ versions: await setupHistory(env, pr.id) });
  const sv = rest.match(/^\/setup\/v\/(\d+)$/);
  if (sv && M === "GET") { const s = await setupVersion(env, pr.id, +sv[1]); return s ? json(s) : err("No such setup version.", 404); }
  if (rest === "/setup/preview" && M === "POST") {
    const b = await body(req), cur = await loadSetup(env, pr), ctx0 = await setupContext(env, pr, ws, cur.setup);
    const [bad, clean] = validateSetup(b.setup || cur.setup, ctx0._ids); if (bad) return err(bad, 400);
    const ctx = await setupContext(env, pr, ws, clean);
    return json(previewSetup(clean, await recentRows(env, pr, 100), { answerers: ctx.answerers, jevPerToken: (+(env.JEV_PRICE_IN || 0.042)) / 1e6, jevOurs: !(ws.jev_mode === "own" && ws.ts_key_enc), margin: +(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1) }));
  }
  if (rest === "/routing" && M === "GET") return json(await routingView(env, pr));
  if (rest === "/routing" && M === "PUT") {
    const b = await body(req); const targets = {}, eps = await endpointsOf(env, pr.id);
    for (const [k, v] of Object.entries(b.targets || {})) {
      const t = { ...(v || {}) }; delete t.auth; delete t.auth_enc; delete t.has_auth;
      if (k.startsWith("endpoint:")) { const ep = eps[k.slice(9)]; if (!ep) return err("Unknown endpoint " + k + ". Add it with POST /api/p/" + pr.id + "/endpoints first.", 400); Object.assign(t, { url: ep.url, name: ep.name }); }
      targets[k] = t;
    }
    const [bad, cfg] = validate({ targets, rules: b.rules || [] }); if (bad) return err(bad, 400);
    await saveRouting(env, pr.id, cfg); return json(publicRouting(cfg, eps, true));
  }
  if (rest === "/routing/preview" && M === "POST") {
    const b = await body(req), [[old], ms] = await Promise.all([loadRouting(env, pr.id), modelsOf(env, pr.id)]);
    const [bad, cfg] = validate({ targets: b.targets || old.targets, rules: b.rules && b.rules.length ? b.rules : old.rules }); if (bad) return err(bad, 400);
    const avail = Object.keys(cfg.targets).filter(k => cfg.targets[k].on && (k !== "model" || ms.some(m => m.status === "ready")));
    return json(preview(cfg, await recentRows(env, pr, 100), avail));
  }
  if (rest === "/endpoints" && M === "POST") {
    const b = await body(req); let u; try { u = new URL(String(b.url || "")); } catch (_) { return err("url must be a full https URL of a Jev-compatible /v1/systemone."); }
    if (!/^https?:$/.test(u.protocol)) return err("url must start with http:// or https://.");
    const id = short(); const auth_enc = b.key ? await encrypt(env, String(b.key).trim().replace(/^Bearer\s+/i, "")) : null; const name = String(b.name || u.hostname).slice(0, 60);
    await env.DB.prepare("INSERT INTO endpoints (id, project_id, name, url, auth_enc, created_at) VALUES (?,?,?,?,?,?)").bind(id, pr.id, name, u.toString(), auth_enc, now()).run();
    return json({ id, target: "endpoint:" + id, name, url: u.toString(), has_key: !!auth_enc });
  }
  if (rest === "/endpoints" && M === "GET") return json((await env.DB.prepare("SELECT id, name, url, auth_enc, created_at FROM endpoints WHERE project_id = ? ORDER BY created_at").bind(pr.id).all()).results.map(x => ({ id: x.id, target: "endpoint:" + x.id, name: x.name, url: x.url, has_key: !!x.auth_enc, created_at: x.created_at })));
  if (rest === "/endpoints/delete" && M === "POST") { const { id } = await body(req); await env.DB.prepare("DELETE FROM endpoints WHERE id = ? AND project_id = ?").bind(id, pr.id).run(); return json({ ok: true }); }
  if (rest === "/switch" && M === "POST") {   // legacy: per-set switch, honoured only until routing is saved
    const b = await body(req); if (!mine(b.schema)) return err("Not this project's question-set.", 403);
    if (!currentVersion(await modelsOf(env, pr.id))) return err("no trained model yet", 400);
    const st = JSON.parse(pr.settings_json || "{}"); st.switched = { ...(st.switched || {}), [b.schema]: !!b.on };
    await env.DB.prepare("UPDATE projects SET settings_json = ? WHERE id = ?").bind(JSON.stringify(st), pr.id).run(); return json({ ok: true });
  }
  return err("Not found.", 404);
}
