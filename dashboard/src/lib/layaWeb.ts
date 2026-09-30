/* Laya running in this browser tab (ONNX Runtime Web on WebGPU): base Laya, or one of your trained versions.
   The runtime itself is /laya-web.js (plain ES module in public/); this file owns one loaded copy PER MODEL
   (keyed by the weights URL), exposes each load state to React, and turns Laya's Jev-shaped answers into
   the raw label strings the proxy stores for Jev (choice → option key, noul → "true"/"false", score → level index). */
import { useEffect, useState } from "react";
import type { QuestionDef } from "./types";

export const LAYA_WEIGHTS = (import.meta.env.VITE_LAYA_WEIGHTS_URL as string | undefined) || "/laya/";   // base Laya's browser weights (browser/export_onnx.py)

interface LayaAnswer {
  type: string;
  choice?: string;
  noul?: number;
  probabilities?: Record<string, number>;
}
interface LayaRuntime {
  backend: string;
  predict(state: unknown, questions: Record<string, QuestionDef>): Promise<{ answers: Record<string, LayaAnswer>; latency_ms: number }>;
}

export type LayaState =
  | { status: "idle" }
  | { status: "loading"; phase: "download"; loaded: number; total: number }
  | { status: "loading"; phase: "start" }
  | { status: "ready"; backend: string; seconds: number }
  | { status: "error"; message: string };

interface Slot {
  state: LayaState;
  runtime: LayaRuntime | null;
  loading: Promise<LayaRuntime> | null;
  listeners: Set<(s: LayaState) => void>;
  chain: Promise<unknown>;
  cache: Map<string, LayaLabels>;
}
const slots = new Map<string, Slot>();
function slotOf(base: string): Slot {
  let s = slots.get(base);
  if (!s) {
    s = { state: { status: "idle" }, runtime: null, loading: null, listeners: new Set(), chain: Promise.resolve(), cache: new Map() };
    slots.set(base, s);
  }
  return s;
}
function set(s: Slot, st: LayaState) {
  s.state = st;
  s.listeners.forEach((l) => l(st));
}

/** Phones and tablets: the 846 MB model plus its GPU copy is more than a mobile tab may hold, and the OS kills the tab. */
export const isMobile = () =>
  typeof navigator !== "undefined" && (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && screen.width < 900));

export const hasWebGPU = () => typeof navigator !== "undefined" && "gpu" in navigator;

/** Copies in laya-web.js's Cache Storage (846 MB each) that are never read again: trained versions cached from the bucket's
    old public address (this site serves them now, to their owner only), and older builds of the version being loaded (a new
    browser copy lands in a new build folder). Base Laya's copy is kept. */
async function dropOldCopies(base: string) {
  const version = base.match(/^\/api\/p\/[0-9a-f]{8}\/web\/v\d+\//)?.[0];
  try {
    const c = await caches.open("laya-weights-v1");
    for (const r of await c.keys()) {
      const u = new URL(r.url);
      const oldPublic = u.origin !== location.origin && !r.url.startsWith(LAYA_WEIGHTS);
      const olderBuild = !!version && u.origin === location.origin && u.pathname.startsWith(version) && !u.pathname.startsWith(base);
      if (oldPublic || olderBuild) await c.delete(r);
    }
  } catch {
    /* no Cache Storage here (a private window): nothing was kept */
  }
}

/** Load a model once per tab; later calls return the same runtime. Safe to call from many components.
    base: base Laya's public address, or a version's web_url (a path on this site, sent with the sign-in cookie). */
export function loadLaya(base: string = LAYA_WEIGHTS): Promise<LayaRuntime> {
  const s = slotOf(base);
  if (s.runtime) return Promise.resolve(s.runtime);
  if (s.loading) return s.loading;
  void dropOldCopies(base);
  const t0 = performance.now();
  set(s, { status: "loading", phase: "download", loaded: 0, total: 0 });
  s.loading = (async () => {
    try {
      const url = "/laya-web.js";
      const mod = (await import(/* @vite-ignore */ url)) as {
        LayaWeb: { load(o: { base: string; onProgress: (p: { status: string; loaded?: number; total?: number }) => void }): Promise<LayaRuntime> };
      };
      const r = await mod.LayaWeb.load({
        base,
        onProgress: (p) => {
          if (p.status === "download") set(s, { status: "loading", phase: "download", loaded: p.loaded || 0, total: p.total || 0 });
          else if (p.status === "compile") set(s, { status: "loading", phase: "start" });
        },
      });
      s.runtime = r;
      set(s, { status: "ready", backend: r.backend, seconds: Math.round((performance.now() - t0) / 1000) });
      return r;
    } catch (e) {
      s.loading = null;
      set(s, { status: "error", message: (e as Error).message || String(e) });
      throw e;
    }
  })();
  return s.loading;
}

/** A model's load state right now, without subscribing (for "which in-browser models are ready?"). */
export const layaState = (base: string): LayaState => slotOf(base).state;

export function useLaya(base: string = LAYA_WEIGHTS): LayaState {
  const [st, setSt] = useState(slotOf(base).state);
  useEffect(() => {
    const s = slotOf(base);
    setSt(s.state);
    s.listeners.add(setSt);
    return () => void s.listeners.delete(setSt);
  }, [base]);
  return st;
}

/** One question's Laya answer as {label, p, dist}: the top option, its probability, and every option (most likely first). */
export function toLabel(a: LayaAnswer): { label: string; p: number; dist: [string, number][] } {
  if (a.type === "noul") {
    const v = a.noul ?? 0;
    return { label: v >= 0.5 ? "true" : "false", p: Math.max(v, 1 - v), dist: ([["true", v], ["false", 1 - v]] as [string, number][]).sort((x, y) => y[1] - x[1]) };
  }
  const dist = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]);
  const best = dist[0]?.[0] ?? a.choice ?? "";
  return { label: best, p: dist[0]?.[1] ?? 0, dist };
}

export type LayaLabels = Record<string, { label: string; p: number; dist?: [string, number][] }>;

/** Run a model on one state + question set. Serialised per model so a page of calls doesn't hammer the GPU. */
export function predictLabels(base: string, state: unknown, defs: Record<string, QuestionDef>): Promise<LayaLabels> {
  const s = slotOf(base);
  const run = async () => {
    const r = await loadLaya(base);
    const res = await r.predict(state, defs);
    const out: LayaLabels = {};
    for (const [q, a] of Object.entries(res.answers)) out[q] = toLabel(a);
    return out;
  };
  const p = s.chain.then(run, run);
  s.chain = p.catch(() => {});
  return p;
}

/** Shared cache per model so re-renders and the drawer don't re-run rows already scored. */
export async function labelsForCall(base: string, id: string, state: unknown, defs: Record<string, QuestionDef>): Promise<LayaLabels> {
  const s = slotOf(base);
  const hit = s.cache.get(id);
  if (hit) return hit;
  const r = await predictLabels(base, state, defs);
  s.cache.set(id, r);
  return r;
}
export const cachedLabels = (base: string, id: string) => slotOf(base).cache.get(id);
