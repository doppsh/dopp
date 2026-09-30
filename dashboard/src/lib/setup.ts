/* The setup in words: who an answerer id is, which requests a route takes, a route's steps as one readable chain, which
   routes share an oracle. Everything here is built from the setup and the lists the server sends with it; nothing is
   named by hand. */
import { fmtMs, modelName, plural, sourceLabel, usd, versionName } from "./domain";
import { groupOf } from "./upstreams";
import type { AnswererDef, AnswererView, Connection, ModelVersion, RouteStep, Setup, SetupPlan, SetupRoute, SetupState, Upstream } from "./types";

/** One answerer as a picker offers it. */
export interface AnswererOption {
  id: string;
  name: string;
  group: string;
  def: AnswererDef;
  ready: boolean;
  why_not: string | null;
  p50_ms: number | null;
  per_1000_usd: number | null;
  price_note: string | null;
  measured: boolean;
  measured_ms: boolean;
  /** a trained model on our servers: a sleeping one takes ~15 s to wake */
  isVersion: boolean;
}

export const connectionAnswererId = (c: Connection) => (c.kind === "jev" ? "jev" : `endpoint:${c.id}`);
export const planAnswererId = (p: Pick<SetupPlan, "id">) => (p.id === "main" ? "model" : `plan:${p.id}`);
/** A pinned version of the main plan, as the server names it. */
export const pinnedAnswererId = (n: number) => `model@${n}`;

/** The setup's own name for a catalog id, when the setup already knows that upstream under an older id: a service
    (`url:<id>` = `endpoint:<id>`) or this route's own model (`model:<this route>@latest` = `model`). */
function localIdOf(u: Upstream, routeId: string | null): string | null {
  if (u.id.startsWith("url:")) return "endpoint:" + u.id.slice(4);
  if (u.kind === "model" && routeId && u.route === routeId) {
    const m = u.id.match(/@(\w+)$/);
    if (m) return m[1] === "latest" ? "model" : pinnedAnswererId(Number(m[1]));
  }
  return null;
}

/** Every answerer a picker can offer: the setup's own list (its services, this route's plans and versions), the whole
    upstream catalog (Jev, LLMs, services, every route's models), and anything the draft still names. Server metadata
    (ready, speed, price) wins where it exists. */
export function answererOptions(
  state: SetupState | null,
  draft: Setup | null,
  o: { model?: string | null; versions?: ModelVersion[]; latest?: number; catalog?: Upstream[] | null; routeId?: string | null },
): AnswererOption[] {
  const view = new Map<string, AnswererView>((state?.answerers || []).map((a) => [a.id, a]));
  const out = new Map<string, AnswererOption>();
  const add = (id: string, def: AnswererDef, name: string, extra: Partial<AnswererOption> = {}) => {
    const v = view.get(id);
    const isVersion = def.kind === "version" || extra.isVersion === true;
    out.set(id, {
      id,
      def,
      name: v?.name || name,
      group: extra.group || (isVersion ? "This route's models" : def.kind === "connection" && def.connection === "jev" ? "Jev" : "Services"),
      ready: v ? v.ready : extra.ready ?? true,
      why_not: v ? v.why_not : extra.why_not ?? null,
      p50_ms: v?.p50_ms ?? extra.p50_ms ?? null,
      per_1000_usd: v?.per_1000_usd ?? extra.per_1000_usd ?? null,
      price_note: v?.price_note ?? extra.price_note ?? null,
      measured: v?.measured ?? extra.measured ?? false,
      measured_ms: v ? v.measured_ms ?? v.p50_ms != null : extra.measured_ms ?? false,
      isVersion,
    });
  };
  // what the server says this setup can use (its own services and versions, and catalog entries it already knows)
  for (const a of state?.answerers || []) {
    const def: AnswererDef =
      state?.setup.answerers[a.id] ||
      ((a.kind as string) === "person" ? { kind: "person" } : a.kind === "connection" && a.connection
        ? { kind: "connection", connection: a.connection }
        : a.kind === "llm"
          ? { kind: "llm", id: a.id }
          : a.kind === "version" && a.route
            ? { kind: "version", project: a.route, plan: "main", version: a.version ?? "latest" }
            : a.kind === "version"
              ? { kind: "version", plan: a.plan || "main", version: a.version ?? "latest" }
              : { kind: "upstream", upstream: a.id });
    const other = a.kind === "version" && !!a.route && a.route !== o.routeId;
    add(a.id, def, a.name, {
      group: (a.kind as string) === "person" ? "You" : a.kind === "llm" ? "LLMs" : (a.kind as string) === "open" ? "Open models" : other ? "Your models" : undefined,
      measured: a.price_basis ? a.price_basis === "measured" : a.measured,
      isVersion: a.kind === "version",
    });
  }
  for (const c of state?.connections || []) if (!out.has(connectionAnswererId(c))) add(connectionAnswererId(c), { kind: "connection", connection: c.id }, c.name);
  const nm = modelName(o.model) || "this route's model";
  const latest = o.latest || state?.latest_version || 0;
  for (const p of draft?.plans || state?.setup.plans || []) {
    const main = p.id === "main";
    if (out.has(planAnswererId(p))) continue;
    add(
      planAnswererId(p),
      { kind: "version", plan: p.id, version: "latest" },
      main ? (latest ? `${nm} latest (v${latest})` : `${nm} latest`) : `${nm} ${p.name} latest`,
      main && latest ? {} : { ready: false, why_not: "no trained version yet" },
    );
  }
  for (const v of [...(o.versions || [])].sort((a, b) => b.version - a.version))
    if (!out.has(pinnedAnswererId(v.version))) add(pinnedAnswererId(v.version), { kind: "version", plan: "main", version: v.version }, versionName(o.model, v.version));
  // the catalog: every upstream on the account. Ids the setup already knows under an older name are merged into those.
  for (const u of o.catalog || []) {
    const local = localIdOf(u, o.routeId ?? null);
    const meta: Partial<AnswererOption> = {
      group: groupOf(u.kind),
      ready: u.ready,
      why_not: u.why_not,
      p50_ms: u.p50_ms,
      per_1000_usd: u.per_1000_usd,
      price_note: u.price_note,
      measured: u.price_basis === "measured",
      measured_ms: u.measured_ms,
      isVersion: u.kind === "model",
    };
    if (local && out.has(local)) {
      const cur = out.get(local)!;
      out.set(local, { ...cur, group: meta.group!, p50_ms: cur.p50_ms ?? u.p50_ms, per_1000_usd: cur.per_1000_usd ?? u.per_1000_usd });
      continue;
    }
    if (out.has(u.id)) {
      out.set(u.id, { ...out.get(u.id)!, group: meta.group! });
      continue;
    }
    const def: AnswererDef =
      u.kind === "jev"
        ? { kind: "connection", connection: "jev" }
        : u.kind === "llm"
          ? { kind: "llm", id: u.id }
          : u.kind === "url"
            ? { kind: "connection", connection: u.id.replace(/^(url|endpoint):/, "") }
            : u.kind === "model" && u.route
              ? { kind: "version", project: u.route, plan: "main", version: u.version && !/@latest$/.test(u.id) ? u.version : "latest" }
              : { kind: "upstream", upstream: u.id };
    add(u.id, def, u.name, meta);
  }
  for (const [id, def] of Object.entries(draft?.answerers || {})) if (!out.has(id)) add(id, def, "an upstream that no longer exists", { ready: false, why_not: "removed" });
  return [...out.values()];
}

/** Picker order: Jev, LLMs, this route's models, other routes' models, services. */
export const OPTION_GROUPS = ["You", "Jev", "Open models", "LLMs", "This route's models", "Your models", "Services"];

export const nameOf = (id: string | null | undefined, opts: AnswererOption[]) =>
  !id ? "nobody" : opts.find((a) => a.id === id)?.name || "an upstream that no longer exists";

/** "140 ms · $0.18 per 1,000" or with "list price" when it is a guess, not history. */
export function answererMeta(a: AnswererOption | undefined): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.p50_ms != null) parts.push(a.measured_ms ? `p50 ${fmtMs(a.p50_ms)}` : `about ${fmtMs(a.p50_ms)} (a guess)`);
  if (a.per_1000_usd != null) parts.push(`${usd(a.per_1000_usd)} per 1,000${a.measured ? "" : " (list price)"}`);
  else if (a.price_note) parts.push(a.price_note);
  if (!parts.length) parts.push("no history yet");
  return parts.join(" · ");
}

export { usd };

/** Default wait for a step: a sleeping version takes ~15 s to wake, so versions get 90 s; services 30 s. */
export const defaultWait = (a: AnswererOption | undefined) => (a?.isVersion ? 90000 : 30000);

/* ---------- a route in words ---------- */

export function matchText(r: SetupRoute, state: SetupState | null): string {
  const m = r.match;
  if (!m.kinds.length && !m.keys.length && !m.sources.length) return "Everything";
  const parts = [
    ...m.kinds.map((k) => state?.kinds.find((x) => x.id === k)?.name || "a kind of request not seen lately"),
    ...m.keys.map((k) => `key ${k}…`),
    ...m.sources.map((s) => sourceLabel(s)),
  ];
  return parts.join(" · ");
}

export const matchesEverything = (r: SetupRoute) => !r.match.kinds.length && !r.match.keys.length && !r.match.sources.length;

export function stepName(s: RouteStep, opts: AnswererOption[]): string {
  if (s.split) {
    const xs = Object.entries(s.split).filter(([, w]) => w > 0);
    return xs.map(([id, w]) => `${nameOf(id, opts)} ${w}%`).join(" / ") || "nobody";
  }
  return nameOf(s.ask, opts);
}

/** Why the route moves past a step: "below 70% or 90 s", "error or 30 s". */
export function moveOnText(s: RouteStep): string {
  const secs = `${Math.round((s.wait_ms ?? 30000) / 1000)} s`;
  return s.unsure_below != null ? `below ${Math.round(s.unsure_below * 100)}% or ${secs}` : `error or ${secs}`;
}

/** "signup-gate v1 → below 70% or 90 s → Jev" */
export function chainText(r: SetupRoute, opts: AnswererOption[]): string {
  if (!r.steps.length) return "nobody answers";
  return r.steps.map((s, i) => (i === 0 ? stepName(s, opts) : `${moveOnText(r.steps[i - 1])} → ${stepName(s, opts)}`)).join(" → ");
}

export function backgroundText(r: SetupRoute, opts: AnswererOption[]): string {
  return r.background.map((b) => `${nameOf(b.ask, opts)} ${b.pct}%`).join(", ");
}

export const oracleText = (ids: string[], opts: AnswererOption[]) => (ids.length ? ids.map((x) => nameOf(x, opts)).join(" → ") : "nobody");

/** Routes that share who is right share one card on the board. */
export function oracleGroups(s: Setup): { key: string; routes: SetupRoute[]; oracle: string[]; fill_pct: number }[] {
  const groups = new Map<string, { key: string; routes: SetupRoute[]; oracle: string[]; fill_pct: number }>();
  for (const r of s.routes) {
    const key = JSON.stringify([r.oracle, r.fill_pct || 0]);
    const g = groups.get(key) || { key, routes: [], oracle: r.oracle, fill_pct: r.fill_pct || 0 };
    g.routes.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function planWhen(p: SetupPlan): string {
  if (!p.auto) return "by hand";
  const { first_at, every } = p.auto;
  return first_at === every ? `every ${every.toLocaleString()} new labelled` : `first at ${first_at.toLocaleString()} labelled, then every ${every.toLocaleString()}`;
}

/* ---------- keeping the answerer list in step with what the setup uses ---------- */

export function usedAnswerers(s: Setup): Set<string> {
  const used = new Set<string>();
  for (const r of s.routes) {
    for (const st of r.steps) {
      if (st.ask) used.add(st.ask);
      for (const k of Object.keys(st.split || {})) used.add(k);
    }
    r.background.forEach((b) => used.add(b.ask));
    r.oracle.forEach((x) => used.add(x));
  }
  for (const p of s.plans) (p.oracle || []).forEach((x) => used.add(x));
  if (s.checker) used.add(s.checker);
  return used;
}

/** Every id the setup uses has its definition, and nothing it doesn't use stays in the list. */
export function normalize(s: Setup, opts: AnswererOption[]): Setup {
  const used = usedAnswerers(s);
  const answerers: Setup["answerers"] = {};
  for (const id of [...used].sort()) {
    if (s.answerers[id]) {
      answerers[id] = s.answerers[id];
      continue;
    }
    // catalog ids (LLMs, other routes' models) are left for the server to define from the id itself
    const def = opts.find((a) => a.id === id)?.def;
    if (def && (def.kind === "connection" || (def.kind === "version" && !def.project))) answerers[id] = def;
  }
  return { ...s, answerers };
}

/** JSON with keys sorted, so two setups that mean the same compare equal. */
export function stableKey(x: unknown): string {
  // a missing field and a null one mean the same in a setup
  return JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] != null).map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/** What stops a save, in plain words. The server checks too; this catches the obvious before a round trip. */
export function problems(s: Setup): string[] {
  const out: string[] = [];
  const last = s.routes[s.routes.length - 1];
  if (!s.routes.length) out.push("Add a branch: every request needs one.");
  else if (!matchesEverything(last)) out.push(`The last branch (${last.name || "unnamed"}) has to take everything the branches above don't. Set its "Which requests" to Everything.`);
  s.routes.forEach((r, i) => {
    const n = r.name || `Branch ${i + 1}`;
    if (!r.steps.length) out.push(`${n}: nobody answers. Add who answers.`);
    r.steps.forEach((st, j) => {
      if (st.split) {
        const sum = Object.values(st.split).reduce((a, b) => a + (Number(b) || 0), 0);
        if (sum !== 100) out.push(`${n}, step ${j + 1}: the split adds up to ${sum}%, not 100%.`);
      } else if (!st.ask) out.push(`${n}, step ${j + 1}: pick who answers.`);
    });
    if (!r.oracle.length) out.push(`${n}: pick who is right.`);
    if (i < s.routes.length - 1 && matchesEverything(r)) out.push(`${n} takes every request, so the branches below it never get any. Narrow "Which requests" or move it last.`);
  });
  if (!s.plans.length) out.push("Keep at least one training plan.");
  s.plans.forEach((p) => {
    if (p.oracle && !p.oracle.length) out.push(`${p.name}: pick who is right, or use each request's branch.`);
  });
  return out;
}

export const routeCount = (s: Setup) => plural(s.routes.length, "branch", "branches");
export const planCount = (s: Setup) => plural(s.plans.length, "plan");

export const newId = (p: string) => p + Math.random().toString(36).slice(2, 7);
