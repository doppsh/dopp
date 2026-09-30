/* Sign-in for a self-hosted Dopp: one operator, one password. The dashboard asks for ADMIN_PASSWORD (a secret you set in
   worker/.dev.vars or with `wrangler secret put`) and opens a 30-day session for the server's one user. There is no sign-up.
   Apps never sign in: they send a us_ key made on a route's page. */
import { json, err, now, rand, short, sha256 } from "./lib.js";

const MIN_LENGTH = 12, TRIES = 10, WINDOW_MS = 10 * 60 * 1000;
const fails = new Map();   // ip → times of wrong passwords, in this isolate: a brake on guessing

/** POST /auth/password {password} → a session cookie, or an error that says what to fix. */
export async function passwordSignIn(req, env) {
  const want = String(env.ADMIN_PASSWORD || "");
  if (!want) return err("ADMIN_PASSWORD isn't set on this server. Put it in worker/.dev.vars (or run `npx wrangler secret put ADMIN_PASSWORD -c worker/wrangler.toml`) and restart.", 503);
  if (want.length < MIN_LENGTH) return err(`ADMIN_PASSWORD is too short. Use at least ${MIN_LENGTH} characters, then restart.`, 503);
  const ip = req.headers.get("cf-connecting-ip") || "local", t = now();
  const recent = (fails.get(ip) || []).filter(x => x > t - WINDOW_MS);
  if (recent.length >= TRIES) return err("Too many wrong passwords. Try again in 10 minutes.", 429);
  const { password } = await req.json().catch(() => ({}));
  // compare digests, so the time taken says nothing about how much of the password matched
  if (await sha256(String(password || "")) !== await sha256(want)) {
    if (fails.size > 10000) fails.clear();
    recent.push(t); fails.set(ip, recent);
    return err("That's not the password.", 401);
  }
  fails.delete(ip);
  const u = await operator(env), sid = rand(24);
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)").bind(sid, u.id, t + 30 * 86400 * 1000).run();
  return json({ ok: true }, 200, { "set-cookie": `us_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}` });
}

/** The server's one user: the oldest account (so an existing database keeps its routes), or a new one named "admin". */
async function operator(env) {
  const u = await env.DB.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").first();
  if (u) return u;
  const made = { id: short() };
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?,?,?)").bind(made.id, "admin", now()).run();
  return made;
}
