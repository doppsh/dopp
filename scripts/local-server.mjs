// A throwaway local Dopp for tests and examples: migrations applied to a temporary database, `wrangler dev` on a free port,
// the given vars instead of worker/.dev.vars, signed in with the admin password. stop() ends it and deletes the database.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = new URL("..", import.meta.url).pathname;
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Starts a Worker. vars: extra env (ADMIN_PASSWORD is made up if missing). port: pass one to know SELF_URL before it starts. */
export async function startDopp({ vars = {}, port, log = [] } = {}) {
  port = port || await freePort();
  const inspector = await freePort(), dir = mkdtempSync(join(tmpdir(), "dopp-local-"));
  const all = { ADMIN_PASSWORD: "local-" + Math.random().toString(36).slice(2) + "-password", KEY_SECRET: "k".repeat(40), ...vars };
  const envFile = join(dir, "vars.env");
  writeFileSync(envFile, Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const run = (args, opts = {}) => {
    const c = spawn(WRANGLER, args, { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, ...opts });
    c.stdout.on("data", d => log.push(String(d))); c.stderr.on("data", d => log.push(String(d))); return c;
  };
  const mig = run(["d1", "migrations", "apply", "DB", "--local", "-c", "worker/wrangler.toml", "--persist-to", dir]);
  if (await new Promise(r => mig.on("close", r)) !== 0) throw new Error("migrations failed");
  const w = run(["dev", "-c", "worker/wrangler.toml", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", dir,
    "--env-file", envFile, "--show-interactive-dev-session=false"], { detached: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + "/auth/server")).ok) break; } catch { /* not up yet */ }
    if (i > 120 || w.exitCode !== null) throw new Error("the Worker didn't start");
    await wait(500);
  }
  let cookie = "";
  const call = (path, { method = "GET", body, headers = {}, raw = false } = {}) =>
    fetch(base + path, { method, redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...(body && !raw ? { "content-type": "application/json" } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const signIn = async (password = all.ADMIN_PASSWORD) => {
    const r = await fetch(base + "/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    const sid = ((r.headers.get("set-cookie") || "").match(/us_session=([^;]+)/) || [])[1];
    if (sid) cookie = "us_session=" + sid;
    return r;
  };
  const stop = async () => { if (w.exitCode === null) { try { process.kill(-w.pid, "SIGTERM"); } catch { /* gone */ } } await wait(300); rmSync(dir, { recursive: true, force: true }); };
  return { base, port, call, signIn, stop, password: all.ADMIN_PASSWORD, log, get cookie() { return cookie; } };
}
