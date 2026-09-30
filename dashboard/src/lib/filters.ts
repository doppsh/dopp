/* The request filter lives in the page URL (so a view can be shared or bookmarked) with the same names the API takes. */
import { dayOf, pct, sourceLabel } from "./domain";
import { upstreamName } from "./upstreams";
import type { Facets, ReqFilter, Source } from "./types";

export const FILTER_KEYS: (keyof ReqFilter)[] = ["route", "kind", "source", "key", "answered_by", "missing", "labelled", "labels_from", "disagree", "maxp", "q", "since", "until", "holdout", "left_out"];

export function filterFromParams(p: URLSearchParams): ReqFilter {
  const f: ReqFilter = {};
  const routes = p.getAll("route").filter(Boolean);
  if (routes.length) f.route = routes;
  for (const k of FILTER_KEYS) {
    if (k === "route") continue;
    const v = p.get(k);
    if (v != null && v !== "") (f as Record<string, string>)[k] = v;
  }
  return f;
}

/** Writes the filter into `p` (other params, like the compare column, are kept). */
export function filterToParams(f: ReqFilter, p: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const out = new URLSearchParams(p);
  for (const k of FILTER_KEYS) out.delete(k);
  for (const r of f.route || []) out.append("route", r);
  for (const k of FILTER_KEYS) {
    if (k === "route") continue;
    const v = f[k];
    if (v != null && v !== "") out.set(k, String(v));
  }
  return out;
}

export const isEmptyFilter = (f: ReqFilter) => FILTER_KEYS.every((k) => (k === "route" ? !f.route?.length : f[k] == null || f[k] === ""));

export interface Names {
  route: (id: string) => string;
  kind: (id: string) => string;
  upstream: (id: string) => string;
}

export function namesFrom(facets: Facets | null, routes: { id: string; name: string }[] | null, upstreams: { id: string; name: string }[] | null): Names {
  return {
    route: (id) => routes?.find((r) => r.id === id)?.name || "a route not on this account",
    kind: (id) => facets?.kinds?.[id]?.name || "a kind of request",
    upstream: (id) => upstreamName(id, upstreams, routes),
  };
}

/** Each active filter in words, with the keys to clear it. */
export function filterChips(f: ReqFilter, n: Names): { key: keyof ReqFilter; value?: string; text: string }[] {
  const out: { key: keyof ReqFilter; value?: string; text: string }[] = [];
  for (const r of f.route || []) out.push({ key: "route", value: r, text: `route ${n.route(r)}` });
  if (f.kind) out.push({ key: "kind", text: n.kind(f.kind) });
  if (f.source) out.push({ key: "source", text: `from ${sourceLabel(f.source as Source)}` });
  if (f.key) out.push({ key: "key", text: `key ${f.key}…` });
  if (f.answered_by) out.push({ key: "answered_by", text: `answered by ${n.upstream(f.answered_by)}` });
  if (f.missing) out.push({ key: "missing", text: `no answer from ${n.upstream(f.missing)}` });
  if (f.labelled === "1") out.push({ key: "labelled", text: "labelled" });
  if (f.labelled === "0") out.push({ key: "labelled", text: "not labelled" });
  if (f.labels_from) out.push({ key: "labels_from", text: `labels from ${n.upstream(f.labels_from)}` });
  if (f.disagree) {
    const [a, b] = f.disagree.split(",");
    out.push({ key: "disagree", text: `${n.upstream(a)} and ${n.upstream(b || "")} disagree` });
  }
  if (f.maxp) out.push({ key: "maxp", text: `least sure ≤ ${pct(Number(f.maxp))}` });
  if (f.q) out.push({ key: "q", text: `“${f.q}”` });
  if (f.since) out.push({ key: "since", text: `from ${dayOf(f.since)}` });
  if (f.until) out.push({ key: "until", text: `to ${dayOf(f.until)}` });
  if (f.holdout === "1") out.push({ key: "holdout", text: "held out" });
  if (f.holdout === "0") out.push({ key: "holdout", text: "not held out" });
  if (f.left_out === "1") out.push({ key: "left_out", text: "left out of training" });
  if (f.left_out === "0") out.push({ key: "left_out", text: "not left out" });
  return out;
}

/** "every request" or "requests on support-triage, answered by Jev, labelled". */
export function filterWords(f: ReqFilter | null | undefined, n: Names): string {
  if (!f || isEmptyFilter(f)) return "every request";
  return "requests: " + filterChips(f, n).map((c) => c.text).join(", ");
}

export function withoutChip(f: ReqFilter, key: keyof ReqFilter, value?: string): ReqFilter {
  const next = { ...f };
  if (key === "route" && value) {
    next.route = (f.route || []).filter((r) => r !== value);
    if (!next.route.length) delete next.route;
  } else delete next[key];
  return next;
}
