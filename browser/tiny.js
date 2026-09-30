// A Tiny model in the browser (or Node): the offline folder Dopp makes, run with ONNX Runtime Web (WASM). Nothing is sent anywhere.
//
//   import { load } from "./tiny.js";
//   const model = await load("/models/my-route/", { onProgress })     // a folder in Dopp's "Download to run offline" layout
//   const r = await model.decide("Here's a pie for you")              // the first question: { choice, probabilities, confidence, ms }
//   const all = await model.answers("Here's a pie for you")           // every question, in the same shape serve.py answers
//
// The folder (engines/tiny_train.py writes it, served as is):
//   model.onnx      int8 ONNX; inputs input_ids, attention_mask (int64 [1, t]); one output per question (o0, o1, ...), logits
//   tokenizer.json  Hugging Face tokenizer (BERT WordPiece), read by ./wordpiece.js
//   tiny.json       { model, base, text_field, max_tokens, outputs: { <question id>: { output, type, options, instructions } }, measured }
//   README.md, serve.py (for running it outside a browser; not read here)
// Scoring follows serve.py (examples/gatekeeper/check.mjs checks it: same tokens and choices, probabilities within 0.05): tokenize the text alone, truncate to max_tokens, softmax the question's logits (float32), renormalise over
// the options asked, round to 4 places; confidence = the top probability. A noul answer is the probability of "true"; a score answer is
// the expected level.
//
// ONNX Runtime: pass your own (`ort`, e.g. a copy you serve yourself, so it works offline); otherwise onnxruntime-web is loaded from
// jsDelivr. tiny.json "extras": { emb: <output name> } names an embedding output (the mean of the middle encoder layer over the
// text's tokens), which decide() returns as emb; Dopp's exporter adds it to every folder. extras.moves (a file of typical lines) is
// the game's own, not Dopp's.
import { WordPiece } from "./wordpiece.js";

const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";

export class LoadError extends Error {
  constructor(message, { stage, cause } = {}) { super(message); this.stage = stage; this.cause = cause; }
}

// fetch with progress; onProgress({ status: "download", loaded, total, compressed }) and { status: "stalled", loaded, total, seconds }
// when no bytes have arrived for a while (the download keeps going). With content-encoding (gzip), total is only the compressed size.
async function fetchBytes(url, onProgress, { stallMs = 6000, fetchImpl = fetch } = {}) {
  let r, n = 0, total = 0, lastByte = Date.now();
  const watch = setInterval(() => { const s = Date.now() - lastByte; if (s > stallMs) onProgress?.({ status: "stalled", loaded: n, total, seconds: Math.round(s / 1000) }); }, 1000);
  try {
    try { r = await fetchImpl(url); } catch (e) { throw new LoadError("couldn't reach the server for the model file", { stage: "download", cause: e }); }
    if (!r.ok) throw new LoadError(`the model file answered HTTP ${r.status}`, { stage: "download" });
    const compressed = !/^(|identity)$/i.test(r.headers.get("content-encoding") || "");
    total = +r.headers.get("content-length") || 0; lastByte = Date.now();
    if (!r.body || !r.body.getReader) { const b = new Uint8Array(await r.arrayBuffer()); onProgress?.({ status: "download", loaded: b.length, total: b.length, compressed }); return b; }
    const reader = r.body.getReader(); let buf = new Uint8Array(total || 1 << 22);
    for (;;) {
      let chunk; try { chunk = await reader.read(); } catch (e) { throw new LoadError("the download of the model broke off", { stage: "download", cause: e }); }
      if (chunk.done) break; const v = chunk.value; lastByte = Date.now();
      if (n + v.length > buf.length) { const g = new Uint8Array(Math.max(buf.length * 2, n + v.length)); g.set(buf.subarray(0, n)); buf = g; }
      buf.set(v, n); n += v.length; onProgress?.({ status: "download", loaded: n, total: Math.max(total, n), compressed });
    }
    if (total && !compressed && n !== total) throw new LoadError(`the model file stopped at ${n} of ${total} bytes`, { stage: "download" });
    return buf.subarray(0, n);
  } finally { clearInterval(watch); }
}
async function fetchJSON(url, what, fetchImpl = fetch) {
  let r; try { r = await fetchImpl(url); } catch (e) { throw new LoadError(`couldn't reach the server for ${what}`, { stage: "download", cause: e }); }
  if (!r.ok) throw new LoadError(`${what} answered HTTP ${r.status}`, { stage: "download" });
  try { return await r.json(); } catch (e) { throw new LoadError(`${what} isn't valid JSON`, { stage: "read", cause: e }); }
}

const f32 = Math.fround, round4 = (v) => Number(v.toFixed(4));
// serve.py: softmax in float32 (numpy on the ORT output), then renormalised over the asked options in float64, rounded to 4 places
function distribution(logits, head, asked) {
  const x = Array.from(logits, f32), m = x.reduce((a, b) => Math.max(a, b), -Infinity);
  const e = x.map((v) => f32(Math.exp(f32(v - m)))); let s = 0; for (const v of e) s = f32(s + v);
  const p = Object.fromEntries(head.options.map((o, i) => [o, f32(e[i] / s)]));
  const known = asked.filter((o) => o in p); let tot = 0; for (const o of known) tot += p[o]; tot = tot || 1;
  return { p, known, dist: Object.fromEntries(known.map((o) => [o, round4(p[o] / tot)])) };
}
/** One question's answer from its logits, as serve.py gives it. options: the options asked (default: all it was trained on). */
function score(logits, head, options) {
  if (head.type === "noul") { const { p } = distribution(logits, head, head.options); return { type: "noul", noul: round4(p.true ?? 0) }; }
  const asked = options || head.options, { known, dist } = distribution(logits, head, asked);
  let top = known[0]; for (const o of known) if (dist[o] > dist[top]) top = o;
  const confidence = dist[top];
  if (head.type === "score") return { type: "score", score: round4(known.reduce((s, o) => s + +o * dist[o], 0)), probabilities: dist, confidence };
  return { type: "choice", choice: top, probabilities: dist, confidence };
}

/** load(folderUrl, { onProgress, ort, question, fetch, threads }) -> model. Throws LoadError with a plain message. */
export async function load(folderUrl, { onProgress = null, ort = null, question = null, fetch: fetchImpl = globalThis.fetch.bind(globalThis), threads = null } = {}) {
  const base = folderUrl.endsWith("/") ? folderUrl : folderUrl + "/";
  const t0 = performance.now();
  const meta = await fetchJSON(base + "tiny.json", "the model's description (tiny.json)", fetchImpl);
  if (!meta.outputs || typeof meta.outputs !== "object" || !Object.keys(meta.outputs).length) throw new LoadError("tiny.json lists no outputs", { stage: "read" });
  const qid = question || Object.keys(meta.outputs)[0], head = meta.outputs[qid];
  if (!head) throw new LoadError(`tiny.json has no question "${qid}"`, { stage: "read" });
  const extras = meta.extras || {};
  if (!ort) {
    try { ort = await import(/* @vite-ignore */ ORT_CDN + "ort.wasm.min.mjs"); ort.env.wasm.wasmPaths = ORT_CDN; }
    catch (e) { throw new LoadError("couldn't load ONNX Runtime Web from jsDelivr (pass your own with { ort })", { stage: "download", cause: e }); }
  }
  ort.env.wasm.numThreads = threads || (globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency || 1)) : 1);
  const [bytes, tokJSON, moves] = await Promise.all([
    fetchBytes(base + "model.onnx", onProgress, { fetchImpl }),
    fetchJSON(base + "tokenizer.json", "the tokenizer (tokenizer.json)", fetchImpl),
    extras.moves ? fetchJSON(base + extras.moves, "moves", fetchImpl).catch(() => null) : null,
  ]);
  let tok; try { tok = new WordPiece(tokJSON); } catch (e) { throw new LoadError(e.message, { stage: "read", cause: e }); }
  onProgress?.({ status: "compile" });
  let session; try { session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }); }
  catch (e) { throw new LoadError("this browser couldn't start the model (" + String(e.message || e).slice(0, 80) + ")", { stage: "compile", cause: e }); }
  for (const need of ["input_ids", "attention_mask"]) if (!session.inputNames.includes(need)) throw new LoadError(`model.onnx has no ${need} input`, { stage: "read" });
  for (const [q, h] of Object.entries(meta.outputs)) if (!session.outputNames.includes(h.output)) throw new LoadError(`model.onnx has no output ${h.output} (tiny.json says question "${q}" is there)`, { stage: "read" });
  const embOut = extras.emb && session.outputNames.includes(extras.emb) ? extras.emb : null;
  const maxTokens = meta.max_tokens || 128;
  const I64 = (a) => new ort.Tensor("int64", BigInt64Array.from(a, (v) => BigInt(v)), [1, a.length]);
  const run = async (text, outputs) => {
    const ids = tok.encode(String(text), { maxLength: maxTokens }).ids;
    return { ids, out: await session.run({ input_ids: I64(ids), attention_mask: I64(ids.map(() => 1)) }, outputs) };
  };

  const model = {
    name: meta.model || base, meta, question: qid, labels: head.options.slice(), bytes: bytes.length, backend: "wasm", threads: ort.env.wasm.numThreads,
    standin: meta.dev_standin || null, moves, hasEmb: !!embOut,
    tokenize: (text) => tok.encode(text, { maxLength: maxTokens }).ids,
    /** decide(text, { options }) -> the loaded question's answer + { ms, tokens, emb? }. options: the options asked, for a choice. */
    async decide(text, { options = null } = {}) {
      const s = performance.now(), { ids, out } = await run(text, embOut ? [head.output, embOut] : [head.output]);
      return { ...score(out[head.output].data, head, options), ms: performance.now() - s, tokens: ids.length, emb: embOut ? Array.from(out[embOut].data) : null };
    },
    /** answers(text, questions?) -> { <question id>: answer } for every question it was trained on (or the ids given), and
        untrained: the ids it wasn't trained on. The same answers serve.py gives for those questions. */
    async answers(text, questions = null) {
      const ids = questions ? Object.keys(questions) : Object.keys(meta.outputs), known = ids.filter((q) => meta.outputs[q]);
      const { out } = await run(text, known.map((q) => meta.outputs[q].output)), res = {};
      for (const q of known) {
        const h = meta.outputs[q], asked = questions?.[q]?.type === "score" ? (questions[q].criteria || []).map((_, i) => String(i))
          : questions?.[q]?.criteria ? (Array.isArray(questions[q].criteria) ? questions[q].criteria.map(String) : Object.keys(questions[q].criteria)) : null;
        res[q] = score(out[h.output].data, h, asked);
      }
      return { answers: res, untrained: ids.filter((q) => !meta.outputs[q]) };
    },
  };
  onProgress?.({ status: "warmup" });
  await model.decide("Good evening.");
  model.loadMs = performance.now() - t0;
  return model;
}
