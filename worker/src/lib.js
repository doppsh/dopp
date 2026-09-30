/* Shared helpers: responses, hashing, AES for stored keys, the engine client (train/predict only), and direct Jev calls. */
export const enc = new TextEncoder();
export const now = () => Date.now();
export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
export const err = (msg, status = 400) => json({ error: msg }, status);
export async function sha256(s) { const d = await crypto.subtle.digest("SHA-256", enc.encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
export function rand(n = 24) { const a = crypto.getRandomValues(new Uint8Array(n)); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
export const short = () => rand(4);
export function cookie(req, name) { const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")); return m && m[1]; }
export const body = req => req.json().catch(() => ({}));

// Stored TypeSafe / endpoint keys are encrypted with AES-GCM under a Worker secret.
async function aesKey(env) {
  if (!env.KEY_SECRET) { const e = new Error("KEY_SECRET isn't set on this server, so keys can't be stored safely. Set it (any long random string) and try again."); e.status = 503; throw e; }
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(env.KEY_SECRET)); return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]); }
export async function encrypt(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(text)); return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...new Uint8Array(ct))); }
export async function decrypt(env, blob) { const [iv, ct] = blob.split(".").map(s => Uint8Array.from(atob(s), c => c.charCodeAt(0))); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(env), ct)); }
export const upstreamOf = async (env, ws) => "Bearer " + (ws.jev_pass ? ws.jev_pass : ws.jev_mode === "own" && ws.ts_key_enc ? await decrypt(env, ws.ts_key_enc) : env.TYPESAFE_API_KEY);   // jev_pass: the caller's x-jev-key, this request only

// The engine (Modal) only trains, predicts and serves checkpoints. Everything else is D1.
// One engine per base family, same contract, different URLs: Laya (engines/modal_engine.py), Kev (engines/modal_kev.py), GLiNER (engines/modal_gliner.py).
export const BASES = { laya: "Laya 0.4B", "laya-multilingual": "Laya multilingual 0.3B", "kev-0.8b": "Kev 0.8B", "kev-4b": "Kev 4B", "gliner-decide": "GLiNER2.5-Decide 0.49B", "gliner-small": "GLiNER2 small 0.21B", tiny: "Tiny 33M" };
/** Bases the engines also serve untrained (their version 0) as open upstreams anyone can pick, with where the weights come from. */
// jevbench: JevBench v1.4.1 composite (benchmarkheaven.com/jev-models, 23 Sep 2026; Jev 1.13.0 = 63.3), only where the exact model is listed.
// gpu: what its serving container runs on (for the GPU-time charge). jevk5 is served by the open-models engine (engines/modal_open.py).
export const OPEN_BASES = {
  jevk5: { name: "JevK5 4B", repo: "alibiserikbay/JevK5", license: "Apache-2.0", jevbench: 62.0, gpu: "L4", note: "closest open model to Jev" },
  laya: { name: "Laya 0.4B", repo: "convaiinnovations/laya", license: "Apache-2.0", jevbench: 30.3, gpu: "T4", note: "small and fast; best after fine-tuning" },
  "gliner-decide": { name: "GLiNER2.5-Decide 0.49B", repo: "fastino/GLiNER2.5-Decide", license: "Apache-2.0", gpu: "T4", note: "a base to fine-tune; weak untrained" },
  "gliner-small": { name: "GLiNER2 small 0.21B", repo: "fastino/gliner2-base-v1", license: "Apache-2.0", gpu: "T4", note: "phone-sized base to fine-tune; weak untrained" },
  "kev-0.8b": { name: "Kev 0.8B", repo: "jaredpalmer/kev-0.8b", license: "Apache-2.0", gpu: "T4", note: "a base to fine-tune" } };
export const openName = b => (OPEN_BASES[b] && OPEN_BASES[b].name) || BASES[b] || b;
/** The serving container a model answers from (for the GPU-time charge): Laya runs one per model, Kev and GLiNER one per engine. */
export const containerOf = (base, project, version) => familyOf(base) === "laya" ? `laya:${project}:v${version}` : familyOf(base) === "open" ? "open:" + base : familyOf(base);
export const familyOf = base => base === "jevk5" ? "open" : base === "tiny" ? "tiny" : String(base || "laya").startsWith("kev") ? "kev" : String(base || "").startsWith("gliner") ? "gliner" : "laya";
export const isKev = base => familyOf(base) === "kev";
// Kev and GLiNER train on labelled requests (question + label), Laya on soft targets; the training GPU each family runs on (for the charge)
export const labelledTrainer = base => familyOf(base) !== "laya";
export const TRAIN_GPU = { laya: "H100", kev: "H100", gliner: "A10G", tiny: "T4" };
/** An engine at a localhost address runs on this machine (engines/tiny_local.py): trained on its CPU, nothing billed. */
export const localEngine = (env, base) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(engineUrl(env, base)).hostname); } catch (_) { return false; } };
export const trainGpu = (env, base) => localEngine(env, base) ? "CPU" : TRAIN_GPU[familyOf(base)];
/** A base whose engine isn't deployed on this server yet can't be trained or asked (the page says so instead of failing late). */
export const baseReady = (env, base) => !!engineUrl(env, base);
/** Laya-family bases other than "laya" need an engine that knows them (GET /bases); an older engine would train English Laya
    instead. Asked once a minute per isolate; any failure counts as "not there", so nothing starts on a guess. */
let engineBases = { t: 0, list: null };
export async function engineHasBase(env, base) {
  if (!baseReady(env, base)) return false;
  if (familyOf(base) !== "laya" || base === "laya") return true;
  if (Date.now() - engineBases.t > 60000) {
    let list = [];
    try { const r = await engineFetch(env, "/bases", {}, base); if (r.ok) list = (await r.json()).bases || []; } catch (_) { list = []; }
    engineBases = { t: Date.now(), list };
  }
  return engineBases.list.includes(base);
}
export const engineUrl = (env, base) => ({ kev: env.KEV_ENGINE_URL, gliner: env.GLINER_ENGINE_URL, laya: env.ENGINE_URL, open: env.OPEN_PREDICT_URL, tiny: env.TINY_ENGINE_URL })[familyOf(base)];
export const predictUrl = (env, base) => ({ kev: env.KEV_PREDICT_URL, gliner: env.GLINER_PREDICT_URL, open: env.OPEN_PREDICT_URL })[familyOf(base)];
export const engineFetch = (env, path, init = {}, base = "laya") => fetch(engineUrl(env, base) + path, { ...init, headers: { "content-type": "application/json", "x-understudy-secret": env.MODAL_SECRET, ...(init.headers || {}) } });
export const passthrough = async r => new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
export class EngineError extends Error { constructor(status, text) { super("engine " + status); this.status = status; this.text = text; } }
export const asResponse = e => e instanceof EngineError ? new Response(e.text, { status: e.status, headers: { "content-type": "application/json" } }) : null;
// JSON from the engine or an EngineError carrying its status and body (handlers pass those through unchanged).
export async function engine(env, path, init = {}, base = "laya") { const r = await engineFetch(env, path, init, base); const t = await r.text(); if (!r.ok) throw new EngineError(r.status, t); try { return JSON.parse(t); } catch (_) { throw new EngineError(502, JSON.stringify({ error: "Engine returned non-JSON: " + t.slice(0, 200) })); } }
export const post = (env, path, data, headers = {}) => engine(env, path, { method: "POST", body: JSON.stringify(data), headers });
// Predict: Laya versions answer from their own memory-snapshotted T4 container behind the engine's /predict; Kev still at its own URL.
// A container that is still starting drops requests that arrive meanwhile (Modal answers 408/5xx): retried with backoff, like Jev.
export async function predict(env, data, base = "laya") {
  let r, t;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(res => setTimeout(res, 1500 * 2 ** (attempt - 1)));
    r = await fetch(familyOf(base) !== "laya" ? predictUrl(env, base) : engineUrl(env, base) + "/predict", { method: "POST", headers: { "content-type": "application/json", "x-understudy-secret": env.MODAL_SECRET }, body: JSON.stringify({ ...data, base, model: base }) });
    t = await r.text(); if (r.ok) return JSON.parse(t);
    if (![408, 429, 500, 502, 503, 504].includes(r.status)) break;
  }
  throw new EngineError(r.status, t);
}

// Jev (the oracle), called directly.
export let JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const UA = "Dopp/1.0 (+https://dopp.sh)";
/** Per-request settings read from env: JEV_URL points the built-in Jev connection at another Jev-compatible server (a self-hosted
    install, or a local stub for development). Unset (dopp.sh): TypeSafe's Jev. */
export function configure(env) { if (env.JEV_URL && /^https?:\/\//.test(env.JEV_URL)) JEV_URL = env.JEV_URL; }
// Jev is retried on overload/rate-limit (429, 5xx incl. 529) with backoff; other statuses come straight back.
import { chargeJev } from "./ledger.js";
export async function jevFetch(auth, body, signal, meter = null) {
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(res => setTimeout(res, 800 * 2 ** (attempt - 1)));
    r = await fetch(JEV_URL, { method: "POST", headers: { "content-type": "application/json", authorization: auth, "user-agent": UA }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    if (r.status !== 429 && r.status < 500) {
      // the charge is a D1 write: with meter.later (the proxy) it lands after the reply instead of in front of it
      if (meter && r.ok) { const c = r.clone().json().then(j => chargeJev(meter.env, meter.ws, meter.pid, j.usage, meter.note || null)).catch(() => {}); if (meter.later) meter.later(c); else await c; }
      return r;
    }
  }
  return r;
}
export const jevStatusText = status => status === 429 ? "Jev is rate-limiting us right now; try again in a minute." : status >= 500 ? `Jev is overloaded right now (HTTP ${status}); try again in a minute.` : `Jev returned HTTP ${status}.`;
// A Jev decision the product makes for itself (column pick, dataset fit, quality gate). Straight to Jev, never recorded, no project routing.
export async function jevDecide(env, ws, state, questions, pid = null) {
  const r = await jevFetch(await upstreamOf(env, ws), { model: "jev-latest", state, questions }, null, pid ? { env, ws, pid, note: "decision" } : null); const t = await r.text();
  if (!r.ok) throw new EngineError(r.status, JSON.stringify({ error: jevStatusText(r.status) + " (" + t.slice(0, 200) + ")" }));
  return (JSON.parse(t).answers) || {};
}
export const nouls = a => a && a.type === "noul" ? +a.noul : a && a.probabilities ? +(a.probabilities.yes ?? a.probabilities.true ?? 0) : 0;
export const choiceOf = a => a && (a.choice || (a.probabilities && Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0]));

// Run fn over items with at most n in flight.
export async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __error: e }; } } })); return out; }
