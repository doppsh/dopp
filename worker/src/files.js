/* A route's private files: what training makes from a route's data, kept in the R2 bucket bound as PRIVATE, which must have no
   public address. Today that is each trained version's browser copy and offline folder, handed back by the trainer through
   /engine/web/ (index.js). It is served only here, to the signed-in operator or to a caller holding the route's own us_ key as
   bearer. This Worker binds no public bucket, so nothing it makes can end up public.
   Files under a build folder never change (every export gets a new one), so the browser may keep them forever; Range and
   ETag work as on any file server. */
import { err, sha256, now, cookie, familyOf } from "./lib.js";

/** Where a version's browser copy is served on this site; build is the export's folder with its slash. */
export const webPath = (pid, v, build) => `/api/p/${pid}/web/v${v}/${build}`;

// models.web_url says where a version's browser copy is:
//   "private:<build>/"  in the PRIVATE bucket under web/<route>/v<N>/<build>/, the only kind that is ever served
//   "pending:<secs>"    a new copy was asked for then and isn't back yet
//   anything else       an old copy in the public bucket (made before 28 Sep 2026): never served or handed out
export const privateCopy = build => "private:" + build;
export const pendingCopy = () => "pending:" + Math.floor(now() / 1000);

/** A version's browser copy as the API hands it out. web_status: ready (load it from web_url) | preparing (since
    web_started, in seconds) | failed (web_error says why) | needs_copy (its only copy is an old public one; make a new one)
    | none (its base doesn't run in a browser). */
export function webState(m) {
  const u = String(m.web_url || ""), s = (web_status, more) => ({ web_status, web_url: null, web_error: null, web_started: null, ...more });
  // Tiny doesn't run in the browser runtime; its files are the offline folder (offline.zip with serve.py), handed back the same way
  if (familyOf(m.base) === "tiny") return { ...s("none"), offline_url: u.startsWith("private:") ? webPath(m.project_id, m.version, u.slice(8)) + "offline.zip" : null,
    offline_status: u.startsWith("private:") ? "ready" : m.web_error ? "failed" : m.status === "ready" ? "preparing" : null, ...(m.web_error ? { web_error: m.web_error } : {}) };
  if (u.startsWith("private:")) return s("ready", { web_url: webPath(m.project_id, m.version, u.slice(8)) });
  if (m.web_error) return s("failed", { web_error: m.web_error });
  if (u.startsWith("pending:")) return s("preparing", { web_started: +u.slice(8) || null });
  if (u) return s("needs_copy");
  return familyOf(m.base) === "laya" ? s("preparing", { web_started: m.t || null }) : s("none");   // exported right after training
}

/** null when this caller may read route pid's private files, else the response to send. Signed out or an unknown key → 401;
    signed in as someone else, or another route's key → the same 404 as a route that doesn't exist. */
async function mayRead(req, env, pid) {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    // only a Dopp key: any other bearer an app sends (a passed-through TypeSafe key, an email) names an account, it isn't a secret
    if (!bearer.startsWith("us_")) return err("Send this route's Dopp key (us_…) as the bearer.", 401);
    // a key made before routes has no route of its own and belongs to the account's first one (as in index.js keyContext)
    const k = await env.DB.prepare(`SELECT k.revoked_at, EXISTS (SELECT 1 FROM projects p WHERE p.id = ?2 AND p.workspace_id = k.workspace_id AND (k.project_id = p.id
      OR (k.project_id IS NULL AND p.id = (SELECT id FROM projects WHERE workspace_id = k.workspace_id ORDER BY created_at LIMIT 1)))) own FROM proxy_keys k WHERE k.key_hash = ?1`).bind(await sha256(bearer), pid).first();
    if (!k || k.revoked_at) return err("This Dopp key isn't valid (unknown or revoked).", 401);
    return k.own ? null : err("Not found.", 404);
  }
  const sid = cookie(req, "us_session"); if (!sid) return err("Sign in first.", 401);
  const s = await env.DB.prepare("SELECT s.expires_at, EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?2 AND w.user_id = s.user_id) own FROM sessions s WHERE s.id = ?1").bind(sid, pid).first();
  if (!s || s.expires_at < now()) return err("Sign in first.", 401);
  return s.own ? null : err("Not found.", 404);
}

// the engine names each export's folder by when it ran (export_web: build = %Y%m%d%H%M%S); files in one never change
const BUILD = /^\d{14}\//;

/** GET/HEAD /api/p/<pid>/web/v<N>/<file>: one file of a version's browser weights. */
export async function serveWeb(req, env, pid, v, name) {
  if (!/^[\w./-]+$/.test(name) || name.includes("..")) return err("Not found.", 404);
  const denied = await mayRead(req, env, pid); if (denied) return denied;
  if (!env.PRIVATE) return err("Browser copies aren't stored on this server.", 503);
  return serveObject(req, env.PRIVATE, `web/${pid}/v${v}/${name}`, BUILD.test(name));
}

/** One R2 object as a private HTTP response: HEAD, one byte range (206, or 416 past the end), If-None-Match (304), If-Range.
    Several ranges in one request, or a malformed one, get the whole file, which HTTP allows. */
async function serveObject(req, bucket, key, immutable) {
  const meta = await bucket.head(key); if (!meta) return err("Not found.", 404);
  const h = new Headers({ "accept-ranges": "bytes", "cache-control": immutable ? "private, max-age=31536000, immutable" : "private, no-cache", "x-content-type-options": "nosniff" });
  meta.writeHttpMetadata(h); h.set("etag", meta.httpEtag); h.set("last-modified", meta.uploaded.toUTCString());
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").map(t => t.trim().replace(/^W\//, "")).some(t => t === "*" || t === meta.httpEtag)) return new Response(null, { status: 304, headers: h });
  const size = meta.size, ask = req.headers.get("range"), ifRange = req.headers.get("if-range");
  const m = ask && (!ifRange || ifRange === meta.httpEtag) ? ask.trim().match(/^bytes=(\d*)-(\d*)$/) : null;
  let range = null;
  if (m && (m[1] || m[2]) && !(m[1] && m[2] && +m[2] < +m[1])) {
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) { h.set("content-range", `bytes */${size}`); return new Response(null, { status: 416, headers: h }); }
    range = { offset: start, length: end - start + 1 };
    h.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  h.set("content-length", String(range ? range.length : size));
  if (req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers: h });
  const obj = await bucket.get(key, range ? { range } : {}); if (!obj) return err("Not found.", 404);
  return new Response(obj.body, { status: range ? 206 : 200, headers: h });
}
