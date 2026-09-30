/* The upstream catalog in words: its groups, a one-line price/speed for each, and names for ids. Every list comes from
   GET /api/upstreams; the page never names an upstream by hand. */
import { useCallback, useEffect, useState } from "react";
import { cachedCatalog, fetchCatalog, isMissing } from "./api";
import { fmtMs, usd } from "./domain";
import type { Catalog, Upstream, UpstreamKind } from "./types";
import { billingOn, ourKey } from "./server";

export type Group = "Jev" | "Open models" | "LLMs" | "Your models" | "Services";
export const GROUPS: Group[] = ["Jev", "Open models", "LLMs", "Your models", "Services"];
export const groupOf = (k: UpstreamKind | string): Group => (k === "jev" ? "Jev" : k === "open" ? "Open models" : k === "llm" ? "LLMs" : k === "model" ? "Your models" : "Services");
/** "JevBench 62.0" when the exact model is on the benchmark (v1.4.1, benchmarkheaven.com, 23 Sep 2026). */
export const benchText = (u: Pick<Upstream, "jevbench">) => (u.jevbench != null ? `JevBench ${u.jevbench.toFixed(1)}` : "");

/** The catalog, loaded once per tab and shared. `missing`: this server has no catalog yet. */
export function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(cachedCatalog());
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCatalog(await fetchCatalog());
      setError(null);
      setMissing(false);
    } catch (e) {
      if (isMissing(e)) setMissing(true);
      else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { catalog, upstreams: catalog?.upstreams ?? null, providers: catalog?.providers ?? [], missing, error, reload: load, setCatalog };
}

/** "$0.18 per 1,000 (list price)", from measured history where there is some. */
export function priceText(u: Pick<Upstream, "per_1000_usd" | "price_basis" | "price_note" | "per_hour_usd" | "wake_usd">, short = false): string {
  if (short && u.per_hour_usd != null) return `${usd(u.per_hour_usd)}/h GPU · ${usd(u.wake_usd ?? 0)}/wake`;
  if (u.per_1000_usd != null) {
    const p = short ? `${usd(u.per_1000_usd)}/1k` : `${usd(u.per_1000_usd)} per 1,000`;
    return u.price_basis === "measured" ? p : `${p}${short ? " list" : " (list price)"}`;
  }
  return u.price_note || (short ? "" : "no price yet");
}

/** "p50 212 ms" when measured; "about 2 s (a guess)" otherwise. */
export function speedText(u: Pick<Upstream, "p50_ms" | "measured_ms">, short = false): string {
  if (u.p50_ms == null) return short ? "" : "no timing yet";
  return u.measured_ms ? (short ? fmtMs(u.p50_ms) : `p50 ${fmtMs(u.p50_ms)}`) : short ? `~${fmtMs(u.p50_ms)}` : `about ${fmtMs(u.p50_ms)} (a guess)`;
}

/** "ours" is the key of whoever runs this server (Dopp on dopp.sh). */
export const keyText = (k: Upstream["key"]) => (k === "ours" ? ourKey(billingOn()) : k === "yours" ? "your key" : "no key needed");

/** Whatever we know about an id: the catalog's name, or a readable form of the id itself. */
export function upstreamName(id: string | null | undefined, list: { id: string; name: string }[] | null | undefined, routes?: { id: string; name: string }[] | null): string {
  if (!id) return "nobody";
  const hit = list?.find((u) => u.id === id);
  if (hit) return hit.name;
  if (id === "jev") return "Jev";
  if (id === "person" || id === "human") return "a person";
  const llm = id.match(/^llm:[^/]+\/(.+)$/);
  if (llm) return llm[1].split("/").pop() || llm[1];
  const model = id.match(/^model:([^@]+)(?:@(\w+))?$/);
  if (model) {
    const r = routes?.find((x) => x.id === model[1]);
    const v = model[2] && model[2] !== "latest" ? ` v${model[2]}` : "";
    return r ? `${r.name}${v || " model"}` : "another route's model";
  }
  if (/^(endpoint|url):/.test(id)) return "a service no longer connected";
  if (id === "model" || /^model@\d+$/.test(id)) return id === "model" ? "this route's model" : `this route's v${id.slice(6)}`;
  return id;
}

/** The key an upstream's answers carry on a request (a route's model: `model:<route>` for every version). */
export const answersKey = (u: Pick<Upstream, "id" | "answers_key">) => u.answers_key || u.id;

/** Names for both ids and answers keys, for turning any id on a request into words. */
export function nameList(ups: Upstream[] | null | undefined): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const u of ups || []) {
    out.push({ id: u.id, name: u.name });
    if (u.answers_key && u.answers_key !== u.id && !out.some((x) => x.id === u.answers_key)) out.push({ id: u.answers_key, name: u.kind === "model" && u.route_name ? `${u.route_name} (any version)` : u.name });
  }
  return out;
}

export const holdoutPct = (h: Upstream["holdout_agreement"]): number | null =>
  h == null ? null : typeof h === "number" ? h : typeof h.overall === "number" ? h.overall : null;
