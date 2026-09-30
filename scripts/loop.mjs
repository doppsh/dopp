// The whole Dopp loop on this machine, for the examples: a local Dopp with a throwaway database, a local Tiny trainer, and a
// stand-in service that answers each request with the labels an example wrote next to it. The route asks the stand-in and
// labels with it; a fifth of the items go through the proxy as traffic, the rest are added the way the dashboard's Add requests
// does (one in ten of those is held out), Tiny trains on the CPU, and the offline folder is downloaded and unzipped.
//
//   await runLoop({ name, items, questions, stateOf, labelsOf, after })
//     items       anything; stateOf(item) is the request's state, labelsOf(item) its labels { <question id>: label }
//     after       async ({ folder, meta, say, start, up, freePort, dopp }) => …, checks on the offline folder
//   --keep        leave everything running afterwards, to look around the dashboard
//
// Needs Node 22+, `npm install`, and uv (https://docs.astral.sh/uv/) for the Python side.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDopp, freePort, wait, ROOT } from "./local-server.mjs";

export async function runLoop({ name, items, questions, stateOf, labelsOf, after }) {
  const keep = process.argv.includes("--keep");
  const t0 = Date.now(), say = s => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${s}`);
  const kids = [], cleanup = [];
  const start = (cmd, args, opts = {}) => {
    const c = spawn(cmd, args, { cwd: ROOT, detached: true, ...opts }); kids.push(c);
    const out = []; c.stdout.on("data", d => out.push(String(d))); c.stderr.on("data", d => out.push(String(d)));
    c.out = out; return c;
  };
  const up = async (url, what, tries = 600) => { for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return; } catch { /* not yet */ } await wait(500); } throw new Error(what + " didn't start"); };

  // a stand-in upstream in Jev's shape: the labels written next to each item, as answers
  const byState = new Map(items.map(it => [JSON.stringify(stateOf(it)), labelsOf(it)]));
  const standIn = createServer((req, res) => {
    let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
      const b = JSON.parse(raw || "{}"), lab = byState.get(JSON.stringify(b.state)) || {}, answers = {};
      for (const [id, q] of Object.entries(b.questions || {})) {
        if (q.type === "noul") { answers[id] = { type: "noul", noul: lab[id] ? 0.95 : 0.05 }; continue; }
        const opts = Array.isArray(q.criteria) ? q.criteria.map((_, i) => String(i)) : Object.keys(q.criteria || {}), pick = opts.includes(String(lab[id])) ? String(lab[id]) : opts[opts.length - 1];
        const probabilities = Object.fromEntries(opts.map(o => [o, o === pick ? 0.9 : 0.1 / Math.max(1, opts.length - 1)]));
        answers[id] = { type: q.type === "score" ? "score" : "choice", ...(q.type === "score" ? { score: +pick } : { choice: pick }), probabilities, confidence: 0.9 };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: "stand-in", answers, usage: { input_tokens: 0, output_tokens: 0 } }));
    });
  });
  cleanup.push(() => standIn.close());

  try {
    const [port, standInPort, trainerPort] = [await freePort(), await freePort(), await freePort()];
    const secret = "local-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    await new Promise(r => standIn.listen(standInPort, "127.0.0.1", r));
    say("starting the Tiny trainer (the first run installs PyTorch and downloads bge-small)");
    const trainer = start("uv", ["run", "engines/tiny_local.py", "--port", String(trainerPort)], { env: { ...process.env, MODAL_SECRET: secret } });
    const dopp = await startDopp({ port, vars: { MODAL_SECRET: secret, TINY_ENGINE_URL: `http://127.0.0.1:${trainerPort}`, SELF_URL: `http://127.0.0.1:${port}` } });
    cleanup.push(() => dopp.stop());
    await up(`http://127.0.0.1:${trainerPort}/health`, "the trainer");
    say(`Dopp on ${dopp.base}, trainer on :${trainerPort}, answers from the stand-in`);

    if (!(await dopp.signIn()).ok) throw new Error("couldn't sign in");
    // the stand-in is a service that speaks Jev's API: the route asks it, and its answers are the labels (by default you label)
    const svc = await (await dopp.call("/api/connections", { method: "POST", body: { name: `${name} (stand-in)`, url: `http://127.0.0.1:${standInPort}/v1/systemone` } })).json();
    if (!svc.id) throw new Error("couldn't add the stand-in service: " + JSON.stringify(svc));
    const upstream = "endpoint:" + svc.id;
    const made = await (await dopp.call("/api/routes", { method: "POST", body: { name, upstream, labels: upstream } })).json();
    if (!made.route) throw new Error("couldn't make the route: " + JSON.stringify(made));
    const route = made.route.id, key = made.key;

    // 1. traffic through the proxy: what teaches the route its questions
    const live = items.filter((_, i) => i % 5 === 0), rest = items.filter((_, i) => i % 5 !== 0);
    for (const it of live) {
      const r = await fetch(dopp.base + "/v1/systemone", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ state: stateOf(it), questions }) });
      if (!r.ok) throw new Error(`request failed: ${r.status} ${await r.text()}`);
    }
    say(`sent ${live.length} requests through the proxy`);
    let kind = null;
    for (let i = 0; i < 20 && !kind; i++) { const p = await (await dopp.call("/api/requests?limit=1&offset=0")).json(); kind = p.requests && p.requests[0] && p.requests[0].kind; if (!kind) await wait(250); }
    if (!kind) throw new Error("the requests never showed up");

    // 2. more of the same kind, added the way the dashboard's Add requests does; one in ten is held out for the check
    const added = await (await dopp.call(`/api/routes/${route}/examples/paste`, { method: "POST", body: { schema: kind, states: rest.map(stateOf) } })).json();
    if (added.recorded == null) throw new Error("adding requests failed: " + JSON.stringify(added));
    say(`added ${added.recorded} more (${added.holdout} held out)`);

    // 3. train Tiny here
    const tr = await dopp.call("/api/models/train", { method: "POST", body: { route, base: "tiny", epochs: 2 } });
    const started = await tr.json(); if (!tr.ok) throw new Error("training didn't start: " + JSON.stringify(started));
    say(`training Tiny v${started.version} on this machine's CPU`);
    const mine = list => list.find(m => (m.route === route || m.route_id === route || m.project_id === route) && m.version === started.version) || null;
    const models = async () => { const ms = await (await dopp.call("/api/models")).json(); return Array.isArray(ms) ? ms : (ms.models || []).concat(ms.training || []); };
    let model = null, lastLog = "";
    for (;;) {
      model = mine(await models());
      const line = [].concat(model && model.log || []).slice(-1)[0] || trainer.out.join("").trim().split("\n").slice(-1)[0] || "";
      if (line && line !== lastLog && !/^epoch|\] epoch/.test(line)) { say("  " + line.replace(/^\[tiny [^\]]+\] /, "")); lastLog = line; }
      if (model && (model.status === "ready" || model.status === "failed")) break;
      await wait(2000);
    }
    if (model.status !== "ready") throw new Error("training failed: " + (model.error || JSON.stringify(model)));
    let offline = model.offline_url || (model.web && model.web.offline_url);
    for (let i = 0; i < 30 && !offline; i++) { await wait(1000); const m = mine(await models()); offline = m && (m.offline_url || (m.web && m.web.offline_url)); }   // it arrives a moment after "done"
    if (!offline) throw new Error("the offline folder never came back: " + JSON.stringify(model));

    // 4. the offline folder, downloaded and unzipped
    const dir = mkdtempSync(join(tmpdir(), "dopp-example-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const zip = await dopp.call(offline); if (!zip.ok) throw new Error("download failed: " + zip.status);
    writeFileSync(join(dir, "offline.zip"), Buffer.from(await zip.arrayBuffer()));
    execFileSync("unzip", ["-q", "offline.zip"], { cwd: dir });
    const folder = join(dir, readdirSync(dir).find(f => f !== "offline.zip"));
    const meta = JSON.parse(readFileSync(join(folder, "tiny.json"), "utf8"));
    say(`offline folder: ${(meta.measured.bytes / 1e6).toFixed(0)} MB, ${meta.measured.ms_per_request_cpu} ms a request, held-out agreement ${meta.measured.holdout.overall} on ${meta.measured.holdout.n} answers`);

    const extra = after ? await after({ folder, meta, say, start, up, freePort, dopp }) : null;
    say("done");
    if (keep) {
      console.log(`\nStill running. Dashboard: ${dopp.base}  password: ${dopp.password}${extra && extra.note ? "  " + extra.note : ""}\nCtrl-C to stop.`);
      await new Promise(r => process.on("SIGINT", r));
    }
    return { folder, meta };
  } finally {
    for (const c of kids) { if (c.exitCode === null) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } } }
    for (const f of cleanup.reverse()) { try { await f(); } catch { /* best effort */ } }
  }
}

/** Run an example's main() and exit with 1 on failure, printing the reason. */
export async function main(fn) {
  try { await fn(); process.exit(0); } catch (e) { console.log("\nFAILED: " + e.message); process.exit(1); }
}
