/* Does the browser runtime lay out requests token for token like the Python laya package? For any checkpoint (a trained
   version's folder, or a base's): its held-out requests (heldout.json, if it has one) plus object/array states and structured
   questions that stress the serialisation, through each copy of laya-web.js, compared id for id with laya.common.build_sequence.
   No model runs: only the tokenizer and the layout. transformers.js is the exact CDN build laya-web.js imports.

     node webgpu/check_layout.mjs <checkpoint dir> [--python <python with the laya package>] [laya-web.js ...]

   Requests go through JSON.parse / JSON.stringify first, as the Worker forwards them: that is what both the hosted model and
   the browser see (same key order, 1.0 written as 1). Exits 1 if any layout differs. */
import { spawnSync } from "node:child_process";
import fs from "node:fs"; import http from "node:http"; import os from "node:os"; import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = process.argv.slice(2), flag = n => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
const python = flag("--python") || process.env.PYTHON || "python3";
const [ckArg, ...files] = args;
if (!ckArg) { console.error("usage: node webgpu/check_layout.mjs <checkpoint dir> [--python <python>] [laya-web.js ...]"); process.exit(2); }
const ck = path.resolve(ckArg), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nameOf = f => path.resolve(f).startsWith(root + path.sep) ? path.relative(root, path.resolve(f)) : path.resolve(f);
const copies = files.length ? files : ["dashboard/public/laya-web.js", "browser/laya-web.js"].map(f => path.join(root, f));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "laya-layout-"));

// 1. the requests
const rows = [];
const heldout = path.join(ck, "heldout.json");
if (fs.existsSync(heldout)) { const h = JSON.parse(fs.readFileSync(heldout, "utf8")); for (const r of h.rows) rows.push({ tag: "held-out", state: r.state, questions: h.questions }); }
const plain = { team: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "charges, refunds", technical: "bugs, errors", sales: null } },
                urgency: { type: "score", instructions: "How urgent is this?", criteria: ["can wait", "this week", "today"] },
                human: { type: "noul", instructions: "Does the writer ask for a person?" } };
const structured = {
  list_choice: { type: "choice", instructions: "Pick the product area", criteria: ["billing", "login", "reports", "billing"] },
  rubric_choice: { type: "choice", instructions: "Which tier?", criteria: { free: { max_seats: 1, price: 0 }, pro: { max_seats: 10, price: 12.5, notes: ["annual", "monthly"] }, team: null, "": "blank key" } },
  rubric_score: { type: "score", instructions: "Rate severity", criteria: ["none", { level: "low", eg: ["typo"] }, { level: "high", weight: 1e-05 }] },
  noul_crit: { type: "noul", instructions: "Is [MASK] mentioned?", criteria: { true: { means: "yes" }, false: "" } },
  obj_instructions: { type: "choice", instructions: { ask: "Which language is this?", hint: "Zürich → de; 東京 → ja 😀" }, criteria: { de: null, ja: null, en: null } },
};
const states = [
  `{"order": {"id": 1043, "total": 12.50, "tax": 0.1, "tiny": 0.00001, "big": 1e21, "huge": 12345678901234567890, "neg": -3.25e-7, "zero": -0.0, "one": 1.0},
    "flags": [true, false, null], "customer": "Zoë Ångström 李雷 😀", "note": "line1\\nline2\\t\\"quoted\\" back\\\\slash \\u0001 del\\u007f",
    "empty": {}, "list": [], "nested": [[1, [2, {"k": "v"}]], {"a": {"b": {"c": [0.5, 2.0]}}}]}`,
  `[{"role": "user", "content": "My card was charged twice   and I want a refund."}, {"role": "agent", "content": "Sorry!\\n\\nCan you share the order id?"}, {"role": "user", "content": "It's  #A-1043,   thanks"}]`,
  `{"ticket": "Hello    team,\\t\\tthe  app   crashes     on    login.\\n\\n\\n  Please   help.                                 Thanks"}`,
  `{"b": "second", "2": "two", "a": "first", "1": "one", "10": "ten"}`,
  `{"ticket": "The field shows [MASK] instead of my name.[MASK][MASK]"}`,
  JSON.stringify({ ticket: Array.from({ length: 400 }, (_, i) => `sentence ${i} about a billing problem with invoice ${1000 + i}.`).join(" ") }),
  `3.5`, `[1, 2.5, -7, 1e-7, 100000000000000000000]`, `"just text, not JSON"`,
].map(s => JSON.parse(s));
for (const st of states) rows.push({ tag: "object/array state", state: st, questions: plain }, { tag: "structured questions", state: st, questions: structured });
rows.push({ tag: "many long options", state: states[0], questions: { many: { type: "choice", instructions: "Which one?", criteria: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`option_${i}`, `a long description of option ${i} `.repeat(4)])) } } });
fs.writeFileSync(path.join(work, "cases.json"), JSON.stringify({ rows: JSON.parse(JSON.stringify(rows)) }));

// 2. Python's layout, and the laya_config.json values export_version.py would write
const py = spawnSync(python, ["-c", `
import json, os, sys
os.environ.setdefault("HF_HUB_OFFLINE", "1")
from transformers import AutoTokenizer
from laya import Agent
from laya.common import build_sequence
ck, work = sys.argv[1:3]
cfg = json.load(open(os.path.join(ck, "rl_agent_config.json")))
tok = AutoTokenizer.from_pretrained(os.path.join(ck, "tokenizer"))
mx, hm = cfg.get("max_len", 512), cfg.get("head_max_len", 192)
seqs = []
for r in json.load(open(os.path.join(work, "cases.json")))["rows"]:
    seqs.append({q: dict(zip(("ids", "markers"), build_sequence(tok, r["state"], Agent._to_internal(d), mx, hm))) for q, d in r["questions"].items()})
json.dump({"laya_config": {"max_len": mx, "head_max_len": hm, "mask_token": tok.mask_token, "mask_token_id": tok.mask_token_id, "cls_token_id": tok.cls_token_id,
           "sep_token_id": tok.sep_token_id, "pad_token_id": tok.pad_token_id, "temperature": cfg.get("temperature")}, "seqs": seqs}, open(os.path.join(work, "python.json"), "w"))
`, ck, work], { encoding: "utf8" });
if (py.status !== 0) { console.error(`${python} couldn't lay the requests out (it needs the laya package):\n` + py.stderr.split("\n").slice(-8).join("\n")); process.exit(2); }
const { laya_config, seqs } = JSON.parse(fs.readFileSync(path.join(work, "python.json"), "utf8"));

// 3. the checkpoint's tokenizer and that config, served the way an export lays them out
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (u === "/laya_config.json") return res.end(JSON.stringify(laya_config));
  const f = path.join(ck, path.normalize(u));
  if (!f.startsWith(ck + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
globalThis.caches = undefined;   // no Cache Storage in Node: the runtime fetches, as in a private window
fs.writeFileSync(path.join(work, "ort.mjs"), "export class Tensor {}\nexport const InferenceSession = {};\n");

// 4. each copy of laya-web.js, its CDN imports swapped for the same files on disk
let failed = false;
for (const file of copies) {
  let src = fs.readFileSync(file, "utf8");
  for (const [, url] of src.matchAll(/^import .* from "(https:\/\/cdn\.jsdelivr\.net\/[^"]+)";$/gm)) {
    let local = path.join(work, "ort.mjs");
    if (!/onnxruntime-web/.test(url)) {
      local = path.join(os.tmpdir(), "laya-layout-cdn", url.replace(/^https:\/\//, "").replace(/[^\w.@-]+/g, "_"));
      if (!fs.existsSync(local)) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, Buffer.from(await r.arrayBuffer())); }
    }
    src = src.replace(`"${url}"`, `"${pathToFileURL(local).href}"`);
  }
  const mod = path.join(work, nameOf(file).replace(/[\\/]/g, "_") + ".mjs"); fs.writeFileSync(mod, src);
  const { LayaWeb } = await import(pathToFileURL(mod).href);
  if (typeof LayaWeb.layout !== "function") { console.log(`${nameOf(file)}: no LayaWeb.layout, can't be checked without the weights`); failed = true; continue; }
  const lay = await LayaWeb.layout({ base }), byTag = {}, diffs = [];
  rows.forEach((r, i) => { for (const [qid, p] of Object.entries(seqs[i])) {
    const js = lay.buildSequence(r.state, r.questions[qid]), t = byTag[r.tag] ||= [0, 0];
    t[1]++; if (JSON.stringify(js.ids) === JSON.stringify(p.ids) && JSON.stringify(js.markers) === JSON.stringify(p.markers)) t[0]++;
    else diffs.push(`${r.tag} #${i} ${qid}: first different id at ${js.ids.findIndex((x, j) => x !== p.ids[j])}`);
  } });
  console.log(nameOf(file).padEnd(30), Object.entries(byTag).map(([t, [a, b]]) => `${t} ${a}/${b}`).join(" · "));
  diffs.slice(0, 5).forEach(d => console.log("   ", d));
  if (diffs.length) failed = true;
}
server.close(); fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
