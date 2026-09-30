// End-to-end check of a local Dopp: starts a stub Jev and `wrangler dev` on free ports with a throwaway database, then signs in,
// makes a route, sends requests, and checks that strangers are kept out. Run it with `npm test` (it builds the dashboard first).
// Needs nothing but this repo's dependencies: no Cloudflare account, no TypeSafe key, no network.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const PASSWORD = "smoke-test-password-" + Math.random().toString(36).slice(2);
const dir = mkdtempSync(join(tmpdir(), "dopp-smoke-"));
const log = [];
let failed = 0, wrangler = null, stub = null;

const check = (ok, what, detail = "") => { console.log((ok ? "  ok   " : "  FAIL ") + what + (ok || !detail ? "" : "\n         " + detail)); if (!ok) failed++; };
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const run = (args, opts = {}) => spawn(WRANGLER, args, { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, ...opts });
const wait = ms => new Promise(r => setTimeout(r, ms));

// A stand-in for Jev: answers every question with fixed probabilities and counts the calls.
const jev = { calls: 0 };
function startStub(port) {
  stub = createServer((req, res) => {
    let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
      jev.calls++;
      const body = JSON.parse(raw || "{}"), answers = {};
      for (const [id, q] of Object.entries(body.questions || {})) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
        else { const opts = Object.keys(q.criteria || { a: 1, b: 1 }); answers[id] = { type: "choice", choice: opts[0], probabilities: Object.fromEntries(opts.map((o, i) => [o, i ? 0.2 / (opts.length - 1) : 0.8])), confidence: 0.8 }; }
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 0 } }));
    });
  });
  return new Promise(r => stub.listen(port, "127.0.0.1", r));
}

async function main() {
  const [port, jevPort, inspector] = [await freePort(), await freePort(), await freePort()];
  await startStub(jevPort);
  const envFile = join(dir, "vars.env");
  writeFileSync(envFile, [`ADMIN_PASSWORD=${PASSWORD}`, `KEY_SECRET=${"k".repeat(40)}`, `JEV_URL=http://127.0.0.1:${jevPort}/v1/systemone`, ""].join("\n"));

  console.log("Applying migrations to a throwaway database…");
  const mig = run(["d1", "migrations", "apply", "DB", "--local", "-c", "worker/wrangler.toml", "--persist-to", dir]);
  mig.stdout.on("data", d => log.push(String(d))); mig.stderr.on("data", d => log.push(String(d)));
  const migCode = await new Promise(r => mig.on("close", r));
  if (migCode !== 0) throw new Error("migrations failed");

  console.log(`Starting the Worker on port ${port}…`);
  wrangler = run(["dev", "-c", "worker/wrangler.toml", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", dir,
    "--env-file", envFile, "--show-interactive-dev-session=false"], { detached: true });
  wrangler.stdout.on("data", d => log.push(String(d))); wrangler.stderr.on("data", d => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + "/auth/server")).ok) break; } catch { /* not up yet */ }
    if (i > 120 || wrangler.exitCode !== null) throw new Error("the Worker didn't start");
    await wait(500);
  }

  const call = (path, { method = "GET", body, headers = {} } = {}) =>
    fetch(base + path, { method, redirect: "manual", headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const jsonOf = async r => r.json().catch(() => null);

  console.log("\nSign-in");
  let r = await call("/auth/server"); const info = await jsonOf(r);
  check(r.ok && info && info.billing === false, "the server says billing is off");
  r = await call("/api/me"); check(r.status === 401, "the API refuses a visitor who hasn't signed in", `got ${r.status}`);
  r = await call("/auth/password", { method: "POST", body: { password: "wrong" } }); check(r.status === 401, "a wrong password is refused", `got ${r.status}`);
  r = await call("/auth/password", { method: "POST", body: { password: PASSWORD } });
  const sid = ((r.headers.get("set-cookie") || "").match(/us_session=([^;]+)/) || [])[1];
  check(r.ok && !!sid, "the right password signs in", `got ${r.status} ${await r.text().catch(() => "")}`);
  const auth = { cookie: "us_session=" + sid };
  r = await call("/api/me", { headers: auth }); const me = await jsonOf(r);
  check(r.ok && me && me.user, "the session works", `got ${r.status}`);

  console.log("\nProxy");
  r = await call("/api/routes", { method: "POST", headers: auth, body: { name: "Smoke" } }); const made = await jsonOf(r);
  const key = made && made.key;
  check(r.ok && typeof key === "string" && key.startsWith("us_"), "a new route comes with a us_ key", `got ${r.status} ${JSON.stringify(made)}`);
  const ask = { state: "My card was charged twice.", questions: { refund: { type: "noul", instructions: "Does the customer want money back?" } } };
  r = await call("/v1/systemone", { method: "POST", headers: { authorization: "Bearer " + key }, body: ask }); const ans = await jsonOf(r);
  check(r.ok && ans && ans.answers && ans.answers.refund && ans.answers.refund.noul === 0.8, "a request with the route key is answered by Jev", `got ${r.status} ${JSON.stringify(ans)}`);
  let seen = null;
  for (let i = 0; i < 20 && !seen; i++) {
    const page = await jsonOf(await call("/api/requests?limit=5&offset=0", { headers: auth }));
    seen = page && (page.requests || []).find(x => JSON.stringify(x.state || "").includes("charged twice"));
    if (!seen) await wait(250);
  }
  check(!!seen, "the request shows up in the request list");
  console.log("\nLabels");
  const setup = made.setup && (made.setup.setup || made.setup), rid = made.route.id;
  check(setup && JSON.stringify(setup.routes[0].oracle) === '["you"]', "a new route's labels come from you, not Jev", JSON.stringify(setup && setup.routes[0].oracle));
  const labelled = async () => (await jsonOf(await call("/api/requests?limit=5&offset=0&labelled=1", { headers: auth }))).total;
  check(await labelled() === 0, "nothing is labelled until you fix an answer");
  r = await call(`/api/routes/${rid}/examples/correct`, { method: "POST", headers: auth, body: { id: seen.id, qid: "refund", label: "true" } });
  check(r.ok && await labelled() === 1, "your fix makes it a label", `got ${r.status}`);
  const cur = await jsonOf(await call(`/api/routes/${rid}/setup`, { headers: auth }));
  r = await call(`/api/routes/${rid}/setup`, { method: "PUT", headers: auth, body: { setup: { ...cur.setup, plans: cur.setup.plans.map(p => ({ ...p, auto: null })) } } });
  check(r.ok, "a setup labelled by you saves", `got ${r.status} ${await r.text().catch(() => "")}`);

  console.log("\nProxy, continued");
  r = await call("/v1/systemone/", { method: "POST", headers: { authorization: "Bearer " + key }, body: ask });
  check(r.ok, "a trailing slash on /v1/systemone/ works", `got ${r.status}`);
  r = await call("/v1/systemone", { method: "POST", headers: { authorization: "Bearer " + key, "x-dopp-meta": "off", "x-dopp-test": "1" }, body: ask }); const plain = await jsonOf(r);
  check(r.ok && plain && plain.answers && !("understudy" in plain), "x-dopp-meta: off returns Jev's shape exactly", `got ${r.status} ${JSON.stringify(plain)}`);
  r = await call("/v1/models"); const models = await jsonOf(r);
  check(r.ok && models && Array.isArray(models.data), "GET /v1/models is JSON", `got ${r.status} ${r.headers.get("content-type")}`);
  r = await call("/v1/nothing"); check(r.status === 404 && /json/.test(r.headers.get("content-type") || ""), "an unknown /v1 address is a JSON 404", `got ${r.status}`);

  console.log("\nDocs");
  for (const doc of ["/docs.md", "/openapi.json"]) {
    const text = await (await call(doc)).text();
    check(text.includes(base) && !text.includes("localhost:8787"), `${doc} carries this server's address`);
  }

  console.log("\nStrangers");
  const before = jev.calls;
  r = await call("/v1/systemone", { method: "POST", body: ask }); check(r.status === 401, "no bearer: 401", `got ${r.status}`);
  r = await call("/v1/systemone", { method: "POST", headers: { authorization: "Bearer anything-at-all" }, body: ask }); check(r.status === 401, "a bearer that isn't a Dopp key: 401", `got ${r.status}`);
  r = await call("/v1/systemone", { method: "POST", headers: { authorization: "Bearer us_" + "0".repeat(40) }, body: ask }); check(r.status === 401, "a made-up us_ key: 401", `got ${r.status}`);
  check(jev.calls === before, "none of those reached Jev", `Jev was called ${jev.calls - before} more times`);
  r = await call("/agent/start", { method: "POST", body: {} }); const agent = await jsonOf(r);
  check(!(agent && agent.key), "POST /agent/start hands out no key", `got ${r.status} ${JSON.stringify(agent)}`);
  r = await call("/auth/magic", { method: "POST", body: { email: "someone@example.com" } }); const magic = await jsonOf(r);
  check(!(r.ok && magic && magic.ok), "there's no email sign-up", `got ${r.status} ${JSON.stringify(magic)}`);
  for (let i = 0; i < 10; i++) await call("/auth/password", { method: "POST", body: { password: "guess-" + i } });
  r = await call("/auth/password", { method: "POST", body: { password: PASSWORD } });
  check(r.status === 429, "after 10 wrong passwords, sign-in pauses", `got ${r.status}`);
}

try { await main(); }
catch (e) { failed++; console.log("\n  FAIL " + e.message); }
finally {
  if (wrangler && wrangler.exitCode === null) { try { process.kill(-wrangler.pid, "SIGTERM"); } catch { /* already gone */ } }
  if (stub) stub.close();
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} check(s) failed. Worker output:\n` + log.join("").split("\n").slice(-40).join("\n")); process.exit(1); }
console.log("\nAll checks passed.");
