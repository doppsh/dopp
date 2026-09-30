/* Dopp's Worker: the proxy apps call (/v1/systemone, with a us_ key), the operator's sign-in (auth.js) and the API the dashboard
   uses (/api/*). The dashboard itself (../dashboard/dist) is served by the assets binding.
   Routes and their data live in projects.js and pool.js; D1 access in data.js; routing and serving in routing.js; the generator,
   paste parsing and datasets in gen.js; shared helpers in lib.js. The engines (Modal) only train, predict and serve, behind a shared secret. */
import { json, err, now, sha256, rand, short, cookie, encrypt, asResponse } from "./lib.js";
import { projectsApi, projectsOf } from "./projects.js";
import { systemone, keepAwake } from "./routing.js";
import { passwordSignIn } from "./auth.js";
import { billingApi, blockedError, serverInfo } from "./billing.js";
import { configure } from "./lib.js";

// requests per minute per proxy key (setting requests_per_minute_per_key); counted in this Worker instance's memory
const perKey = new Map();
function overRate(keyId, limit) {
  const m = Math.floor(Date.now() / 60000), x = perKey.get(keyId);
  if (!x || x.m !== m) { perKey.set(keyId, { m, n: 1 }); if (perKey.size > 20000) perKey.clear(); return false; }
  return ++x.n > limit;
}
import { connectionsOf, addConnection, setJev, deleteConnection, loadSetup, KEY_CTX_MS, keyCtx } from "./setup.js";
import { poolApi } from "./pool.js";
import { onboardingApi } from "./onboarding.js";
import { analyticsApi, upstreamMs } from "./analytics.js";
import { setupRedeem } from "./agent.js";
import { addProviderKey } from "./upstreams.js";
import { serveWeb, webPath, privateCopy } from "./files.js";

async function currentUser(req, env) {
  const sid = cookie(req, "us_session"); if (!sid) return null;
  const s = await env.DB.prepare("SELECT s.user_id, s.expires_at, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?").bind(sid).first();
  if (!s || s.expires_at < now()) return null;
  return { id: s.user_id, email: s.email };
}
async function workspaceOf(user, env) {
  let ws = await env.DB.prepare("SELECT * FROM workspaces WHERE user_id = ? ORDER BY created_at LIMIT 1").bind(user.id).first();
  if (!ws) {
    ws = { id: short(), user_id: user.id, name: "My workspace", jev_mode: "understudy", ts_key_enc: null, created_at: now() };
    await env.DB.prepare("INSERT INTO workspaces (id, user_id, name, jev_mode, created_at) VALUES (?,?,?,?,?)").bind(ws.id, ws.user_id, ws.name, ws.jev_mode, ws.created_at).run();
  }
  return ws;
}
// The proxy's context for a key: the key, its route, the account, the route's setup, the account's models, connections and route names,
// read in ONE D1 round trip (a batch; D1 runs it as one transaction). Kept in this isolate for KEY_CTX_MS so a client's back-to-back
// requests skip even that; so a newly trained version, a changed connection or a revoked key takes effect within KEY_CTX_MS (10 s); a saved setup
// clears this isolate's entry at once (setup.js forgetKeyContext) and reaches the others within the same 10 s.
// Unknown keys aren't kept: a key made a moment ago works at once.
const AGENT_LINKS = { link: '</docs.md>; rel="service-doc", </openapi.json>; rel="service-desc", </skill.md>; rel="describedby"; type="text/markdown", </llms.txt>; rel="alternate"; type="text/markdown"' };
const DOCS = new Set(["/docs.md", "/openapi.json", "/skill.md", "/llms.txt"]);
const withOrigin = (text, url) => text.replaceAll("http://localhost:8787", url.origin);
async function keyContext(env, hash) {
  const hit = keyCtx.get(hash); if (hit && hit.until > Date.now()) return hit.v;
  // read-only, so it runs on the nearest D1 read replica (read replication is on for this database)
  const db = env.DB.withSession ? env.DB.withSession("first-unconstrained") : env.DB;
  const q = sql => db.prepare(sql).bind(hash), W = "(SELECT workspace_id FROM proxy_keys WHERE key_hash = ?1)";
  const t1 = Date.now(), res = await db.batch([
    q("SELECT id, prefix, workspace_id, project_id, revoked_at FROM proxy_keys WHERE key_hash = ?1"),
    q("SELECT p.* FROM projects p JOIN proxy_keys k ON k.project_id = p.id WHERE k.key_hash = ?1"),
    q(`SELECT * FROM workspaces WHERE id = ${W}`),
    q("SELECT s.project_id, s.json FROM setups s JOIN proxy_keys k ON k.project_id = s.project_id WHERE k.key_hash = ?1 ORDER BY s.version DESC LIMIT 1"),
    q(`SELECT m.* FROM models m JOIN projects p ON p.id = m.project_id WHERE p.workspace_id = ${W} ORDER BY m.project_id, m.version`),
    q(`SELECT * FROM connections WHERE workspace_id = ${W} AND COALESCE(kind, '') != 'pin' ORDER BY created_at`),
    q(`SELECT id, name FROM projects WHERE workspace_id = ${W}`)]);
  const m0 = res[0].meta || {}; console.log(`keyctx d1 ${Date.now() - t1}ms served_by=${m0.served_by_region || "?"} primary=${m0.served_by_primary}`);
  const [k, p, w, st, ms, cs, ps] = res.map(r => r.results);
  const key = k[0]; if (!key) return null;
  // a key without a route belongs to the account's first; a route that never saved a setup gets its first one (both rare, both a read more)
  const pr = p[0] || (await projectsOf(env, { id: key.workspace_id }))[0], setup = st[0] && pr && st[0].project_id === pr.id ? JSON.parse(st[0].json) : pr ? (await loadSetup(env, pr)).setup : null;
  const v = { k: key, pr, ws: w[0], pre: { setup, models: ms, conns: cs, projects: ps } };
  if (keyCtx.size > 500) keyCtx.clear();
  keyCtx.set(hash, { v, until: Date.now() + KEY_CTX_MS }); return v;
}

export default {
  // every 5 minutes: ping the models whose owners asked to keep them awake (Use page switch)
  async scheduled(event, env, ctx) { ctx.waitUntil(keepAwake(env).catch(e => console.log("keep-awake: " + e.message))); },
  async fetch(req, env, ctx) {
    const tRecv = Date.now();   // analytics: "end to end" starts when the Worker has the request, before settings and the key check
    const url = new URL(req.url); const p = /^\/v1\/.+\/$/.test(url.pathname) ? url.pathname.replace(/\/+$/, "") : url.pathname;   // /v1/systemone/ is /v1/systemone
    try {
      configure(env);
      const marks = [["settings", Date.now() - tRecv]], mark = n => marks.push([n, Date.now() - tRecv]); env.__mark = mark;   // proxy timing marks, logged per request
      // ---- sign-in: the operator's password (auth.js); there is no sign-up
      // what kind of server this is, for pages shown before sign-in (whether it has credits and billing)
      if (p === "/auth/server" && req.method === "GET") return json(serverInfo(env), 200, { "cache-control": "no-store" });
      if (p === "/auth/password" && req.method === "POST") return passwordSignIn(req, env);
      if (p === "/auth/signout" && req.method === "POST") {
        const sid = cookie(req, "us_session"); if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
        return json({ ok: true }, 200, { "set-cookie": "us_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
      }

      // ---- the engine hands back a version's browser weights after training (shared secret, no user)
      const w = p.match(/^\/engine\/web\/([0-9a-f]{8})\/v(\d+)\/(.+)$/);
      if (w && (req.method === "PUT" || req.method === "POST")) {
        if (!env.MODAL_SECRET || req.headers.get("x-understudy-secret") !== env.MODAL_SECRET) return err("engine secret required", 401);
        const [, pid, v, name] = w;
        if (name === "failed") { const b = await req.json().catch(() => ({})); await env.DB.prepare("UPDATE models SET web_error = ? WHERE project_id = ? AND version = ?").bind(String(b.error || "export failed").slice(0, 300), pid, +v).run(); return json({ ok: true }); }
        if (name === "done") {   // all files are up: the version can now run in the browser (at its own build path when the engine sent one)
          const b = await req.json().catch(() => ({})), build = /^[\w-]{1,40}$/.test(String(b.build || "")) ? String(b.build) + "/" : "";
          await env.DB.prepare("UPDATE models SET web_url = ?, web_error = NULL WHERE project_id = ? AND version = ?").bind(privateCopy(build), pid, +v).run();
          return json({ ok: true, web_url: webPath(pid, +v, build) });   // served by serveWeb below
        }
        if (!env.PRIVATE) return err("no private bucket bound", 503);
        if (!/^[\w./-]+$/.test(name) || name.includes("..")) return err("bad file name", 400);
        // into the private bucket only (files.js): a customer's trained model never goes where the public can read it
        await env.PRIVATE.put("web/" + pid + "/v" + v + "/" + name, req.body, { httpMetadata: { contentType: name.endsWith(".json") ? "application/json" : "application/octet-stream" } });
        return json({ ok: true });
      }
      // ---- ...and serves them to the route's owner (signed in) or the route's own us_ key, nobody else (files.js)
      const wf = p.match(/^\/api\/p\/([0-9a-f]{8})\/web\/v(\d+)\/(.+)$/);
      if (wf && (req.method === "GET" || req.method === "HEAD")) return serveWeb(req, env, wf[1], +wf[2], wf[3]);

      // ---- a one-time "Connect an agent" link the operator made: a fresh key for that route, as .env lines
      const setupM = p.match(/^\/setup\/([a-f0-9]{32})$/);
      if (setupM && req.method === "GET") return setupRedeem(env, url.origin, setupM[1]);

      // ---- the proxy apps call
      if (p === "/v1/systemone" && req.method === "POST") {
        const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
        if (!bearer) return err("Send your Dopp key as the bearer: Authorization: Bearer us_… (make one on a route's page).", 401);
        // only keys made on this server get in; anything else never reaches an upstream, so nobody else can spend this server's keys
        if (!bearer.startsWith("us_")) return err("That isn't a Dopp key. Send a key made on a route's page on this server (it starts with us_).", 401);
        // key → route → account
        const bearerHash = await sha256(bearer);
        const cached = keyCtx.has(bearerHash); const kc = await keyContext(env, bearerHash); mark(cached ? "key(cached)" : "key(d1)");
        if (!kc) return err("This Dopp key isn't valid on this server.", 401);
        const { k, pr, pre } = kc; let ws = kc.ws;   // ws: whose keys pay for the answerers
        // x-jev-key: the caller's own TypeSafe key, forwarded to Jev for this request (TypeSafe bills it) and never stored
        const passKey = (req.headers.get("x-jev-key") || "").trim();
        if (passKey) ws = { ...ws, jev_pass: passKey };
        const t0 = Date.now(), test = (req.headers.get("x-dopp-test") || req.headers.get("x-understudy-test")) === "1";   // x-dopp-test: 1 (or the older x-understudy-test) = a connectivity check from the snippet we hand out; answered by Jev, never saved as an example
        // every request through a key is logged, answered or not, so the request log shows what really happened
        const logged = async (resp) => {
          try {
            let served = null, example = null, fallback = null, error = null, path = null;
            const j = await resp.clone().json().catch(() => null), u = j && j.understudy;
            if (resp.status === 200) { served = u ? u.served : null; example = u ? u.example || null : null; fallback = u && u.fallback ? JSON.stringify(u.fallback) : null; path = u && u.path ? JSON.stringify(u.path) : null; }
            else error = (j && (j.error || j.message)) ? String(j.error || j.message).slice(0, 300) : "HTTP " + resp.status;
            // ms: from the key check to the reply (kept as before); e2e_ms: from the Worker receiving it; upstream_ms: waiting on answerers (analytics.js)
            const tEnd = Date.now(), upstream = upstreamMs((u && u.path) || (j && j.path)); mark("reply"); console.log("timing " + marks.map(([n, t]) => n + "=" + t).join(" ") + " upstream=" + upstream); const row = [short() + short(), pr.id, t0 / 1000, "key " + k.prefix, resp.status, error, served, tEnd - t0, example, fallback, path];
            const insert = () => env.DB.prepare("INSERT INTO request_log (id, project_id, t, via, status, error, served, ms, example_id, fallback_json, path_json, e2e_ms, upstream_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...row, tEnd - tRecv, upstream).run()
              .catch(e => /column/i.test(e.message) ? env.DB.prepare("INSERT INTO request_log (id, project_id, t, via, status, error, served, ms, example_id, fallback_json, path_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...row).run() : Promise.reject(e));   // before migration 0025 is applied
            if (pr && !test) ctx.waitUntil(insert().catch(e => console.log("request_log: " + e.message)));
          } catch (e) { console.log("request_log: " + e.message); }
          return resp;
        };
        if (k.revoked_at) return logged(err("This proxy key was revoked.", 401));
        if (ws && ws.blocked) return logged(err(blockedError().message, 403));
        const rpm = +env.REQUESTS_PER_MINUTE_PER_KEY || 120;
        if (overRate(k.id, rpm)) return logged(err(`Too many requests for this key: at most ${rpm} a minute. Try again in a few seconds.`, 429));
        ctx.waitUntil(env.DB.prepare("UPDATE proxy_keys SET last_used_at = ? WHERE id = ?").bind(now(), k.id).run().catch(() => {}));
        if (p === "/v1/systemone" && req.method === "GET") return json({ ok: true });
        const target = req.headers.get("x-dopp-target") || req.headers.get("x-understudy-target");   // the older name still works
        let body; try { body = await req.json(); } catch (_) { return logged(err("Body must be JSON.", 400)); }
        if (!body || typeof body !== "object") return logged(err("Body must be a JSON object with state and questions.", 400));
        if (!body.model) body.model = "jev-latest";
        if (body.state === undefined || body.state === null || body.state === "") return logged(err("state is required: the text or JSON to decide about.", 400));
        if (!body.questions || typeof body.questions !== "object" || !Object.keys(body.questions).length) return logged(err("questions is required: an object of question id to question.", 400));
        // like OpenRouter, a caller may name the upstream in `model` (an upstream id from the catalog); the route decides whether callers may choose
        const picked = target || (/^(llm:|model:|endpoint:|url:)/.test(String(body.model)) ? String(body.model) : null);
        // RESPONSE_META=off (or the header x-dopp-meta: off) drops Dopp's `understudy` block, for clients that reject unknown fields
        const bare = async resp => {
          if (env.RESPONSE_META !== "off" && req.headers.get("x-dopp-meta") !== "off") return resp;
          const j = await resp.clone().json().catch(() => null); if (!j || !j.understudy) return resp;
          delete j.understudy; return json(j, resp.status);
        };
        try { return await bare(await logged(await systemone(env, ctx, pr, ws, body, { via: "key " + k.prefix, source: "traffic", xtarget: picked, noRecord: test, test, pre }))); }
        catch (e) { const r = asResponse(e); if (r) return logged(r); await logged(err("Dopp failed: " + String(e.message).slice(0, 200), 500)); throw e; }
      }

      // what SDKs ask besides the proxy: the model list, and JSON (not the dashboard's HTML) for any other /v1 address
      if (p === "/v1/models" && req.method === "GET") return json({ object: "list", data: [{ id: "jev-latest", object: "model", owned_by: "typesafe" }] });
      if (p.startsWith("/v1/")) return err(p === "/v1/systemone" ? "Use POST for /v1/systemone." : "Not found. This server answers POST /v1/systemone.", p === "/v1/systemone" ? 405 : 404);

      // ---- signed-in API
      if (p.startsWith("/api/")) {
        const user = await currentUser(req, env); if (!user) return err("Sign in first.", 401);
        const ws = await workspaceOf(user, env);
        // a blocked account can still look (GET) and sign out, but nothing that writes or spends
        if (ws.blocked && req.method !== "GET" && (p.startsWith("/api/p/") || p === "/api/projects" || p === "/api/keys" || p.startsWith("/api/billing"))) return err(blockedError().message, 403);
        if (p === "/api/me") {
          const keys = (await env.DB.prepare("SELECT id, prefix, created_at, revoked_at, last_used_at FROM proxy_keys WHERE workspace_id = ? ORDER BY created_at DESC").bind(ws.id).all()).results;
          const projects = (await projectsOf(env, ws)).map(x => ({ id: x.id, name: x.name }));
          return json({ user, workspace: { id: ws.id, name: ws.name, jev_mode: ws.jev_mode, has_ts_key: !!ws.ts_key_enc }, keys, projects, proxy_url: url.origin + "/v1/systemone" });
        }
        if (p === "/api/keys" && req.method === "POST") {
          const key = "us_" + rand(20); const id = short();
          const first = (await projectsOf(env, ws))[0];   // legacy route: keys go to the first project
          if (!first) return err("Make a route first; each key belongs to one route.", 400);
          await env.DB.prepare("INSERT INTO proxy_keys (id, key_hash, workspace_id, prefix, created_at, project_id) VALUES (?,?,?,?,?,?)").bind(id, await sha256(key), ws.id, key.slice(0, 8), now(), first.id).run();
          return json({ id, key, prefix: key.slice(0, 8) });   // the only time the full key is ever returned
        }
        if (p === "/api/keys/revoke" && req.method === "POST") {
          const { id } = await req.json(); await env.DB.prepare("UPDATE proxy_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ?").bind(now(), id, ws.id).run(); return json({ ok: true });
        }
        if (p === "/api/settings" && req.method === "POST") {
          const b = await req.json(); const mode = b.jev_mode === "own" ? "own" : "understudy";
          const encd = mode === "own" ? (b.ts_key ? await encrypt(env, b.ts_key.trim()) : ws.ts_key_enc) : null;
          await env.DB.prepare("UPDATE workspaces SET jev_mode = ?, ts_key_enc = ?, name = ? WHERE id = ?").bind(mode, encd, (b.name || ws.name).slice(0, 60), ws.id).run(); return json({ ok: true });
        }
        const bl = await billingApi(req, env, url, user, ws); if (bl) return bl;
        // outside services the account has plugged in, for every model's setup
        if (p === "/api/connections" && req.method === "GET") return json({ connections: (await connectionsOf(env, ws)).list });
        if (p === "/api/connections" && req.method === "POST") { const b = await req.json().catch(() => ({})); const [c, o] = b.kind === "openrouter" || b.kind === "openai" ? await addProviderKey(env, ws, b) : await addConnection(env, ws, b); return json(o, c); }
        if (p === "/api/connections/jev" && req.method === "POST") { const [c, o] = await setJev(env, ws, await req.json().catch(() => ({}))); return json(o, c); }
        if (p === "/api/connections/delete" && req.method === "POST") { const [c, o] = await deleteConnection(env, ws, String((await req.json().catch(() => ({}))).id || "")); return json(o, c); }
        // /api/routes/:id/<anything else> is the same route's /api/p/:id/<…> (setup, keys, try, kinds of requests, …)
        const al = url.pathname.match(/^\/api\/routes\/([0-9a-f]{8})(\/(?!delete$).+)$/); if (al) url.pathname = "/api/p/" + al[1] + al[2];
        if (p === "/api/analytics" && req.method === "GET") return analyticsApi(env, url, ws);
        if (p === "/api/onboarding" && req.method === "GET") return onboardingApi(env, ws);
        const v4 = await poolApi(req, env, ctx, url, user, ws); if (v4) return v4;   // routes, upstreams, the request pool, models
        const pr = await projectsApi(req, env, ctx, url, user, ws); if (pr) return pr;
        return err("Not found.", 404);
      }
      // Agents: a page asked for as text/markdown gets the markdown that describes the site (Cloudflare's Markdown for Agents shape);
      // every HTML page carries Link headers to the docs and the agent skill (RFC 8288).
      const wantsMd = /text\/markdown/.test(req.headers.get("accept") || "") && req.method === "GET";
      if (wantsMd && !/\.[a-z0-9]+$/i.test(p)) {
        const md = await env.ASSETS.fetch(new Request(url.origin + (p === "/docs" ? "/docs.md" : "/llms.txt")));
        const body = withOrigin(await md.text(), url);
        return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", "x-markdown-tokens": String(Math.ceil(body.length / 4)), vary: "accept", ...AGENT_LINKS } });
      }
      // the API docs are written for http://localhost:8787; everywhere else they carry this server's own address
      if (DOCS.has(p) && req.method === "GET") {
        const a = await env.ASSETS.fetch(req); if (!a.ok) return a;
        const h = new Headers(a.headers); h.delete("content-length"); h.delete("etag");
        return new Response(withOrigin(await a.text(), url), { status: a.status, headers: h });
      }
      const asset = await env.ASSETS.fetch(req);
      if ((asset.headers.get("content-type") || "").startsWith("text/html")) { const h = new Headers(asset.headers); for (const [k, v] of Object.entries(AGENT_LINKS)) h.set(k, v); h.append("vary", "accept"); return new Response(asset.body, { status: asset.status, headers: h }); }
      return asset;
    } catch (e) { return asResponse(e) || err((e && e.status ? "" : "Something went wrong: ") + (e && e.message), (e && e.status) || 500); }
  }
};
