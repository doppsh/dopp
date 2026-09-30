/* Laya in the browser: ONNX Runtime Web (WebGPU, WASM fallback) + the HF tokenizer + Laya's exact sequence layout.
   Mirrors laya.common.build_sequence / collate_items and laya.agent.Agent.system_one from the Python package.

   import { LayaWeb } from "./laya-web.js";
   const laya = await LayaWeb.load({ base: "https://.../laya/" });   // base holds laya_fp16.onnx, laya_config.json, tokenizer/
   const result = await laya.predict(state, questions);               // same shape as Jev/Laya answers
*/
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs";
import { AutoTokenizer, PreTrainedTokenizer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";

const QTYPES = { choice: 0, score: 1, noul: 2 };

// ---- the text the model reads, exactly as the Python package writes it (laya.common.serialize_state / render_criterion /
// render_options and laya.agent.Agent._to_internal), so the token ids are the ones it was trained on and the hosted model reads.
// A state or criterion that isn't a string goes through Python's json.dumps: ", " and ": " between items (JSON.stringify writes
// none), keys in order, floats the way repr writes them (1e-05, not 0.00001). The hosted model reads the state after the Worker's
// JSON.stringify and Python's json.loads, so the values here (already through JSON.parse) are what it saw: same key order, and a
// number written without a fraction is an int to Python too.
function pyFloat(x) {
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : x < 0 ? "-Infinity" : "NaN";
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return String(x);   // JSON.stringify writes these without a fraction: an int to Python
  const [m, e] = x.toExponential().split("e"), exp = +e;              // shortest round-trip digits, like repr
  const digits = m.replace("-", "").replace(".", ""), neg = x < 0 ? "-" : "";
  if (exp < -4 || exp >= 16) return neg + digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  if (exp < 0) return neg + "0." + "0".repeat(-exp - 1) + digits;
  return neg + digits.slice(0, exp + 1).padEnd(exp + 1, "0") + "." + (digits.slice(exp + 1) || "0");
}
function pyStr(s, ascii) {
  const j = JSON.stringify(s);   // escapes " \ and control characters as json.dumps does
  return ascii ? j.replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : j;
}
function pyJson(v, ascii) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyFloat(v);
  if (typeof v === "string") return pyStr(v, ascii);
  if (Array.isArray(v)) return "[" + v.map(x => pyJson(x, ascii)).join(", ") + "]";
  return "{" + Object.keys(v).map(k => pyStr(k, ascii) + ": " + pyJson(v[k], ascii)).join(", ") + "}";
}
const renderCriterion = v => typeof v === "string" ? v : pyJson(v, false);
const serializeState = s => typeof s === "string" ? s : pyJson(s, false);
/** Agent._to_internal: a choice's list of options becomes {option: null} (order kept, a repeat counted once); instructions that
    aren't a string become json.dumps(instructions) (ASCII-escaped, Python's default). crit of a choice is [[key, value], ...]. */
function toInternal(q) {
  let crit = q.criteria;
  if (q.type === "choice") crit = Array.isArray(crit) ? [...new Map(crit.map(c => [String(c), null]))] : Object.entries(crit || {});
  else if (q.type === "score") crit = Array.isArray(crit) ? crit : Object.keys(crit || {});   // Python enumerates a dict's keys
  const ins = typeof q.instructions === "string" ? q.instructions : pyJson(q.instructions, true);
  return { t: q.type, ins, crit };
}
function renderOptions(qi) {
  const none = x => x === null || x === undefined || x === "";
  if (qi.t === "choice") return qi.crit.map(([k, v]) => none(v) ? k : `${k}: ${renderCriterion(v)}`);
  if (qi.t === "score") return qi.crit.map((c, i) => `level ${i}: ${renderCriterion(c)}`);
  const c = qi.crit && typeof qi.crit === "object" ? qi.crit : {}, f = c.false, tr = c.true;
  return ["false: " + (none(f) ? "no, the statement does not hold" : renderCriterion(f)),
          "true: " + (none(tr) ? "yes, the statement holds" : renderCriterion(tr))];
}
function confidence(p) { const k = p.length; if (k < 2) return 1; let h = 0; for (const x of p) { const v = Math.max(x, 1e-12); h -= v * Math.log(v); } return Math.min(1, Math.max(0, 1 - h / Math.log(k))); }
function tempBucket(qt, k) { const size = k <= 2 ? "2" : k <= 5 ? "3-5" : k <= 10 ? "6-10" : "11+"; return `${["choice", "score", "noul"][qt]}:${size}`; }
// a trained version's files are served only to the signed-in owner of its route, so a refused fetch usually means signed out
function httpWhy(what, status) {
  return status === 401 ? `Signed out: sign in again, then load the model again (${what}: HTTP 401).`
    : status === 404 ? `This model's browser files weren't found (${what}: HTTP 404).` : `${what}: HTTP ${status}`;
}

// ---- the tokenizer: transformers.js's, built from base + "tokenizer/" the way AutoTokenizer.from_pretrained builds it, plus what
// it doesn't reproduce of the Rust library the Python package tokenizes with. Its Metaspace pre-tokenizer ignores prepend_scheme
// (no "▁" in front of the text) and never splits; Rust puts the "▁" in front as the config says and, with split on, cuts before
// every "▁" (MergedWithNext), so a run of spaces is its own pieces. Keyed on the tokenizer's own config, never on a model name;
// ByteLevel tokenizers (base Laya's) need nothing.
function splitBefore(s, rep) { const out = []; let cur = ""; for (const ch of s) { if (ch === rep && cur) { out.push(cur); cur = ""; } cur += ch; } if (cur) out.push(cur); return out; }
function patchPreTokenizer(inst, cfg) {
  if (!inst || !cfg) return;
  if (cfg.type === "Sequence") (cfg.pretokenizers || []).forEach((c, i) => patchPreTokenizer(inst.tokenizers && inst.tokenizers[i], c));
  if (cfg.type === "Metaspace") {
    const rep = cfg.replacement ?? "\u2581", split = cfg.split !== false;
    const scheme = cfg.prepend_scheme ?? (cfg.add_prefix_space === false ? "never" : "always");   // configs written before prepend_scheme
    inst.pre_tokenize_text = (text, { section_index } = {}) => {
      let s = text.replaceAll(" ", rep);
      if (!s.startsWith(rep) && (scheme === "always" || (scheme === "first" && section_index === 0))) s = rep + s;
      return split ? splitBefore(s, rep) : [s];
    };
  }
}
// its two files are kept in the same Cache Storage as the weights, and only once they've parsed (a cut-off download is never kept)
async function loadTokenizer(base) {
  let store = null; try { store = await caches.open("laya-weights-v1"); } catch (_) {}
  const read = async (name) => {
    const url = base + "tokenizer/" + name;
    if (store) { try { const hit = await store.match(url); if (hit) return JSON.parse(await hit.text()); } catch (_) { try { await store.delete(url); } catch (_) {} } }
    const r = await fetch(url); if (!r.ok) throw new Error(httpWhy("tokenizer/" + name, r.status));
    const text = await r.text(), value = JSON.parse(text);
    if (store) { try { await store.put(url, new Response(text, { headers: { "content-type": "application/json" } })); } catch (_) {} }
    return value;
  };
  const [json, conf] = await Promise.all([read("tokenizer.json"), read("tokenizer_config.json")]);
  const Cls = AutoTokenizer.TOKENIZER_CLASS_MAPPING[conf.tokenizer_class?.replace(/Fast$/, "") ?? "PreTrainedTokenizer"] ?? PreTrainedTokenizer;
  const tok = new Cls(json, conf);
  patchPreTokenizer(tok.pre_tokenizer, json.pre_tokenizer);
  return tok;
}

export class LayaWeb {
  /** The config and tokenizer only, no weights: buildSequence works, predict doesn't. For checking the layout against Python's. */
  static async layout({ base } = {}) {
    const cr = await fetch(base + "laya_config.json"); if (!cr.ok) throw new Error(httpWhy("laya_config.json", cr.status));
    return new LayaWeb(null, await loadTokenizer(base), await cr.json(), null);
  }
  static async load({ base, onProgress } = {}) {
    const cr = await fetch(base + "laya_config.json"); if (!cr.ok) throw new Error(httpWhy("laya_config.json", cr.status));
    const cfg = await cr.json();
    const tok = await loadTokenizer(base);
    // the weights are sharded into ~200 MB files next to the graph. Fetch them in parallel and report ONE number
    // to the caller: bytes so far out of the total, so the UI can show a single "412 of 846 MB" bar.
    // weights are kept in the browser's Cache Storage (per URL, so each model and each export has its own copy); a reload or a new
    // tab reads them from disk instead of downloading 846 MB again. Cache Storage may be unavailable (private windows): then plain fetch.
    let store = null; try { store = await caches.open("laya-weights-v1"); } catch (_) {}
    const cachedFetch = async (url) => { if (store) { const hit = await store.match(url); if (hit) return hit; } const r = await fetch(url); if (store && r.ok) { try { const b = await r.clone().arrayBuffer(); await store.put(url, new Response(b, { headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" } })); } catch (_) {} } return r; };
    const gr = await cachedFetch(base + "laya_fp16.onnx"); if (!gr.ok) throw new Error(httpWhy("laya_fp16.onnx", gr.status));
    const graph = await gr.arrayBuffer();
    const shardNames = cfg.shards || ["laya_fp16.w0.bin", "laya_fp16.w1.bin", "laya_fp16.w2.bin", "laya_fp16.w3.bin", "laya_fp16.w4.bin"];
    // the full size is known before the first byte: from the export's config, or by asking each file's size up front for older exports
    const loaded = new Array(shardNames.length).fill(0);
    const totals = Array.isArray(cfg.shard_bytes) && cfg.shard_bytes.length === shardNames.length ? cfg.shard_bytes.slice()
      : await Promise.all(shardNames.map(async (name) => { try { return +(await fetch(base + name, { method: "HEAD" })).headers.get("content-length") || 0; } catch (_) { return 0; } }));
    const report = () => onProgress && onProgress({ status: "download", loaded: loaded.reduce((a, b) => a + b, 0), total: totals.reduce((a, b) => a + b, 0) });
    // each shard is read into one preallocated buffer, checked against the export's byte count, and only then put in the cache;
    // a short or failed read (a dropped connection, a half-written cache entry) is retried once from the network with the cache entry dropped,
    // so a first load never hands the runtime a truncated shard ("Deserialize tensor … failed")
    const readShard = async (name, i, retry) => {
      const url = base + name;
      let r = null;
      if (store && !retry) { try { r = await store.match(url); } catch (_) {} }
      const fromCache = !!r;
      if (!r) r = await fetch(url, retry ? { cache: "reload" } : {});
      if (!r.ok) throw new Error(httpWhy(`shard ${name}`, r.status));
      if (!totals[i]) totals[i] = +r.headers.get("content-length") || 0; report();
      const reader = r.body.getReader(); let buf = new Uint8Array(totals[i] || 0); loaded[i] = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        if (loaded[i] + value.length > buf.length) { const g = new Uint8Array(Math.max(buf.length * 2, loaded[i] + value.length)); g.set(buf); buf = g; }
        buf.set(value, loaded[i]); loaded[i] += value.length; report(); }
      const data = buf.length === loaded[i] ? buf : buf.subarray(0, loaded[i]);
      if (totals[i] && loaded[i] !== totals[i]) {
        console.warn(`shard ${name}: got ${loaded[i]} of ${totals[i]} bytes${fromCache ? " from the cache" : ""}${retry ? "" : ", retrying"}`);
        if (store) { try { await store.delete(url); } catch (_) {} }
        if (!retry) return readShard(name, i, true);
        throw new Error(`shard ${name} came back short (${loaded[i]} of ${totals[i]} bytes). Check the connection and try again.`);
      }
      if (store && !fromCache) { try { await store.put(url, new Response(data, { headers: { "content-length": String(data.byteLength), "content-type": "application/octet-stream" } })); } catch (_) {} }
      return { path: name, data };
    };
    const externalData = await Promise.all(shardNames.map((name, i) => readShard(name, i, false)));
    onProgress && onProgress({ status: "compile" });
    let session, backend = "webgpu";
    try { session = await ort.InferenceSession.create(graph, { executionProviders: ["webgpu"], externalData, graphOptimizationLevel: "all" }); }
    catch (e) { console.warn("webgpu failed, using wasm:", e); backend = "wasm"; session = await ort.InferenceSession.create(graph, { executionProviders: ["wasm"], externalData }); }
    return new LayaWeb(session, tok, cfg, backend);
  }
  constructor(session, tok, cfg, backend) { this.session = session; this.tok = tok; this.cfg = cfg; this.backend = backend; }

  enc(text) { return Array.from(this.tok.encode(text, { add_special_tokens: false })); }

  /** build_sequence: [CLS] <type> question: instructions [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] state [SEP], token for token. */
  buildSequence(state, q) {
    const c = this.cfg, maskTok = c.mask_token, maxLen = c.max_len, headMax = c.head_max_len;
    const qi = toInternal(q), opts = renderOptions(qi);
    const ins = String(qi.ins).split(maskTok).join(" ");
    let head = this.enc(`${qi.t} question: ${ins}`);
    let optIds = opts.map(o => [c.mask_token_id, ...this.enc(" " + o.split(maskTok).join(" ")).slice(0, 48)]);
    let budget = headMax - optIds.reduce((s, o) => s + o.length, 0);
    if (budget < 16) { const per = Math.max(4, Math.floor((headMax - 16) / Math.max(1, optIds.length))); optIds = optIds.map(o => o.slice(0, per)); budget = headMax - optIds.reduce((s, o) => s + o.length, 0); }
    head = head.slice(0, Math.max(8, budget));
    const ids = [c.cls_token_id, ...head, c.sep_token_id]; const markers = [];
    for (const o of optIds) { markers.push(ids.length); ids.push(...o); }
    ids.push(c.sep_token_id);
    const room = Math.max(0, maxLen - ids.length - 1);
    const st = this.enc(serializeState(state).split(maskTok).join(" ")).slice(0, room);
    const seq = [...ids, ...st, c.sep_token_id].slice(0, maxLen);
    return { ids: seq, markers: markers.filter(m => m < maxLen), options: opts.length, qi };
  }

  async predict(state, questions) {
    const ids = Object.keys(questions); const items = [];
    for (const qid of ids) { const q = questions[qid]; const { ids: seq, markers, options, qi } = this.buildSequence(state, q);
      if (markers.length !== options) throw new Error(`question ${qid}: options exceed head_max_len=${this.cfg.head_max_len}`);
      items.push({ seq, markers, qi, qtype: QTYPES[q.type] }); }
    const n = items.length, L = Math.max(...items.map(i => i.seq.length)), K = Math.max(...items.map(i => i.markers.length));
    const input_ids = new BigInt64Array(n * L).fill(BigInt(this.cfg.pad_token_id)), attention_mask = new BigInt64Array(n * L), marker_pos = new BigInt64Array(n * K), marker_mask = new BigInt64Array(n * K), qtype = new BigInt64Array(n);
    items.forEach((it, i) => { it.seq.forEach((v, j) => { input_ids[i * L + j] = BigInt(v); attention_mask[i * L + j] = 1n; }); it.markers.forEach((m, j) => { marker_pos[i * K + j] = BigInt(m); marker_mask[i * K + j] = 1n; }); qtype[i] = BigInt(it.qtype); });
    const t0 = performance.now();
    const out = await this.session.run({ input_ids: new ort.Tensor("int64", input_ids, [n, L]), attention_mask: new ort.Tensor("int64", attention_mask, [n, L]), marker_pos: new ort.Tensor("int64", marker_pos, [n, K]), marker_mask: new ort.Tensor("int64", marker_mask, [n, K]), qtype: new ort.Tensor("int64", qtype, [n]) });
    const ms = performance.now() - t0; const logits = out.logits.data, act = out.act.data;
    const answers = {};
    ids.forEach((qid, r) => { const q = questions[qid]; const k = items[r].markers.length; const qt = items[r].qtype;
      const T = this.cfg.temperature_by_options?.[tempBucket(qt, k)] ?? this.cfg.temperature[qt];
      const z = Array.from({ length: k }, (_, j) => Number(logits[r * K + j]) / Math.max(1e-3, T)); const mx = Math.max(...z); const e = z.map(v => Math.exp(v - mx)); const s = e.reduce((a, b) => a + b, 0); const p = e.map(v => v / s);
      const conf = +confidence(p).toFixed(4); const actP = +(1 / (1 + Math.exp(Number(act[r * 2 + 1]) - Number(act[r * 2])))).toFixed(4);
      if (q.type === "choice") { const keys = items[r].qi.crit.map(([kk]) => kk); const i = p.indexOf(Math.max(...p)); answers[qid] = { type: "choice", choice: keys[i], probabilities: Object.fromEntries(keys.map((kk, j) => [kk, +p[j].toFixed(4)])), confidence: conf, action: { act_probability: actP } }; }
      else if (q.type === "score") { answers[qid] = { type: "score", score: +p.reduce((a, v, j) => a + j * v, 0).toFixed(4), legend: Object.fromEntries(items[r].qi.crit.map((c, j) => [String(j), c])), probabilities: Object.fromEntries(p.map((v, j) => [String(j), +v.toFixed(4)])), confidence: conf, action: { act_probability: actP } }; }
      else answers[qid] = { type: "noul", noul: +p[1].toFixed(4), confidence: +Math.max(p[1], 1 - p[1]).toFixed(4), action: { act_probability: actP } }; });
    return { model: "laya-web/" + this.backend, answers, usage: { input_tokens: items.reduce((s, i) => s + i.seq.length, 0), output_tokens: 0 }, latency_ms: Math.round(ms) };
  }
}
