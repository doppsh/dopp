/* The admin's one client for the Worker. v4: routes, the upstream catalog, the request pool,
   trained models. The backend lands in stages, so every v4 call can fail with a 404; pages check `isMissing(e)` and show an
   honest "not available on this server yet" for that part. A few calls fall back to the older per-model endpoints the
   contract keeps working (/api/projects, /api/p/:id/…) when that gives the same real data; nothing is ever made up. */
import type {
  Ans,
  AskEstimate,
  AskResult,
  Base,
  Catalog,
  Connection,
  CreatedRoute,
  Credits,
  Example,
  ExamplesPage,
  Facets,
  Me,
  ModelEstimate,
  ModelsPage,
  PresetId,
  ProjectDetail,
  ProjectSummary,
  Questions,
  ReqFilter,
  Req,
  ReqPage,
  RouteKey,
  RoutesPage,
  RouteSummary,
  SearchedModel,
  Selection,
  Setup,
  SetupPreview,
  SetupState,
  SetupVersion,
  SetupVersionInfo,
  TypedResult,
  Usage,
  Analytics,
  DatasetCard,
  IngestResult,
  ParseResult,
  Plan,
  LabelCheck,
} from "./types";

export const API: string = (window as unknown as { LAYA_API?: string }).LAYA_API || location.origin;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The server doesn't have this endpoint yet (the backend is landing in stages). */
export const isMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/** Set by the app so a 401 anywhere can bounce to /signin without importing the router. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function parse(r: Response) {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    if (r.status === 404) return {};
    throw new ApiError("The server sent something we couldn't read.", r.status);
  }
}

export async function get<T>(path: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  let r: Response;
  // Reads give up after a while so a slow server shows an error with a retry, not an endless skeleton.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45000);
  opts.signal?.addEventListener("abort", () => ctrl.abort());
  try {
    r = await fetch(API + path, { credentials: "include", signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      if (opts.signal?.aborted) throw e;
      throw new ApiError("The server took too long to answer. Try again in a moment.", 0);
    }
    throw new ApiError("Couldn't reach the server. Check your connection.", 0);
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 401) {
    onUnauthorized();
    throw new ApiError("Sign in first.", 401);
  }
  const body = await parse(r);
  if (!r.ok) throw new ApiError(body.error || `Request failed (HTTP ${r.status}).`, r.status);
  return body as T;
}

async function send<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(API + path, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (r.status === 401 && !path.startsWith("/auth")) {
    clearMe();
    onUnauthorized();
    throw new ApiError("Sign in first.", 401);
  }
  const data = await parse(r);
  if (!r.ok || data.error) throw new ApiError(data.error || `Request failed (HTTP ${r.status}).`, r.status);
  return data as T;
}

export const post = <T,>(path: string, body?: unknown, signal?: AbortSignal) => send<T>("POST", path, body, signal);
export const put = <T,>(path: string, body?: unknown) => send<T>("PUT", path, body);

const enc = encodeURIComponent;

/* ---------- /api/me, cached in sessionStorage so pages paint instantly ---------- */

const ME_KEY = "understudy_me";
let ME: Me | null = readCachedMe();

function readCachedMe(): Me | null {
  try {
    const raw = sessionStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

export const cachedMe = (): Me | null => ME;

const meListeners = new Set<(m: Me | null) => void>();
export function onMe(fn: (m: Me | null) => void) {
  meListeners.add(fn);
  return () => void meListeners.delete(fn);
}

export async function fetchMe(force = false): Promise<Me | null> {
  if (ME && !force) return ME;
  try {
    const r = await fetch(API + "/api/me", { credentials: "include" });
    const fresh = r.ok ? ((await r.json()) as Me) : null;
    // a different account signed in on this tab: nothing cached from the previous one may be reused
    if (fresh && ME && fresh.user.id !== ME.user.id) clearCaches();
    ME = fresh;
  } catch {
    return ME;
  }
  try {
    if (ME) sessionStorage.setItem(ME_KEY, JSON.stringify(ME));
    else sessionStorage.removeItem(ME_KEY);
  } catch {
    /* private mode */
  }
  meListeners.forEach((l) => l(ME));
  return ME;
}

export function clearMe() {
  ME = null;
  clearCaches();
  try {
    sessionStorage.removeItem(ME_KEY);
  } catch {
    /* ignore */
  }
}

export const signOut = () => post<{ ok: true }>("/auth/signout");

/** The operator's password (ADMIN_PASSWORD on the server) → a session cookie. */
export const signInWithPassword = (password: string) => post<{ ok: true }>("/auth/password", { password });

/* ---------- module caches (so navigation never blanks) ---------- */

let ROUTES: RoutesPage | null = null;
let CATALOG: Catalog | null = null;
const DETAIL = new Map<string, ProjectDetail>();
const routeListeners = new Set<(r: RoutesPage | null) => void>();

function clearCaches() {
  ROUTES = null;
  CATALOG = null;
  DETAIL.clear();
}

export const cachedRoutes = () => ROUTES;
export const cachedCatalog = () => CATALOG;
export function onRoutes(fn: (r: RoutesPage | null) => void) {
  routeListeners.add(fn);
  return () => void routeListeners.delete(fn);
}

/* ================= routes ================= */

/** The older list, mapped to routes: name, total requests and key count are real; the rest isn't on that endpoint. */
function fromProjects(ps: ProjectSummary[], url: string): RoutesPage {
  return {
    legacy: true,
    url,
    routes: ps.map((p) => ({
      id: p.id,
      name: p.name,
      created_at: p.created_at,
      upstream: null,
      upstream_name: null,
      setup_summary: null,
      requests_24h: null,
      requests_total: p.examples,
      cost_24h_usd: null,
      keys: [],
      latest_model: p.model?.version ? { id: `model:${p.id}@${p.model.version}`, name: `${p.name} v${p.model.version}` } : null,
    })),
  };
}

export async function fetchRoutes(): Promise<RoutesPage> {
  let page: RoutesPage;
  try {
    page = await get<RoutesPage>("/api/routes");
  } catch (e) {
    if (!isMissing(e)) throw e;
    const ps = await get<ProjectSummary[]>("/api/projects");
    const me = await fetchMe();
    page = fromProjects(ps, me?.proxy_url || location.origin + "/v1/systemone");
  }
  ROUTES = page;
  routeListeners.forEach((l) => l(page));
  return page;
}

/** One route: from the routes list (there is no single-route read in the contract), falling back to the older detail. */
export async function fetchRoute(id: string): Promise<{ route: RouteSummary; url: string; legacy: boolean }> {
  const page = await fetchRoutes();
  const r = page.routes.find((x) => x.id === id);
  if (!r) throw new ApiError("There is no route with that link on this account.", 404);
  if (!page.legacy) return { route: r, url: page.url, legacy: false };
  // older server: the keys and the URL come from the per-model detail
  const d = await fetchProject(id).catch(() => null);
  return {
    route: { ...r, keys: (d?.keys || []).map((k) => ({ id: k.id, prefix: k.prefix, created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at })) },
    url: d?.proxy_url || page.url,
    legacy: true,
  };
}

/** A new route. On a server without /api/routes this walks the same steps through the older endpoints: the model, a key,
    then the preset's setup (so the result is the same route, not a stand-in). */
export async function createRoute(body: { name: string; upstream?: string; preset?: PresetId }): Promise<CreatedRoute & { legacy?: boolean; url?: string }> {
  try {
    const r = await post<CreatedRoute>("/api/routes", body);
    const page = await fetchRoutes().catch(() => null);
    return { ...r, url: page?.url };
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  const p = await post<{ id: string; name?: string }>("/api/projects", { name: body.name });
  const k = await post<{ id: string; key: string; prefix: string }>(`/api/p/${enc(p.id)}/keys`);
  if (body.preset) {
    const st = await get<SetupState>(`/api/p/${enc(p.id)}/setup`).catch(() => null);
    const preset = st?.presets.find((x) => x.id === body.preset);
    if (preset) await put(`/api/p/${enc(p.id)}/setup`, { setup: preset.setup, note: `Started from “${preset.name}”` }).catch(() => null);
  }
  const page = await fetchRoutes().catch(() => null);
  const route = page?.routes.find((x) => x.id === p.id) || {
    id: p.id,
    name: p.name || body.name,
    created_at: Date.now() / 1000,
    upstream: null,
    upstream_name: null,
    setup_summary: null,
    requests_24h: 0,
    requests_total: 0,
    cost_24h_usd: 0,
    keys: [],
    latest_model: null,
  };
  return { route: { ...route, keys: [{ id: k.id, prefix: k.prefix }] }, key: k.key, legacy: true, url: page?.url };
}

export async function renameRoute(id: string, name: string) {
  try {
    await post(`/api/routes/${enc(id)}`, { name });
  } catch (e) {
    if (!isMissing(e)) throw e;
    await post(`/api/p/${enc(id)}`, { name });
  }
  void fetchRoutes().catch(() => {});
}

export const deleteRoute = (id: string, confirm?: string) => post<{ ok: true }>(`/api/routes/${enc(id)}/delete`, confirm ? { confirm } : {});

export async function createRouteKey(id: string): Promise<{ id: string; key: string; prefix: string }> {
  try {
    return await post(`/api/routes/${enc(id)}/keys`);
  } catch (e) {
    if (!isMissing(e)) throw e;
    return post(`/api/p/${enc(id)}/keys`);
  }
}

export async function revokeRouteKey(id: string, keyId: string) {
  try {
    await post(`/api/routes/${enc(id)}/keys/revoke`, { id: keyId });
  } catch (e) {
    if (!isMissing(e)) throw e;
    await post(`/api/p/${enc(id)}/keys/revoke`, { id: keyId });
  }
}

/** The full key from a create response, kept in memory only so it can be shown once. */
const FRESH_KEYS = new Map<string, string>();
export const freshKey = (routeId: string) => FRESH_KEYS.get(routeId) ?? null;
export const rememberFreshKey = (routeId: string, key: string) => void FRESH_KEYS.set(routeId, key);
export const forgetFreshKey = (routeId: string) => void FRESH_KEYS.delete(routeId);

export type { RouteKey };

/* ---------- a route's setup (/api/routes/:id/setup; older servers: /api/p/:id/setup) ---------- */

async function either<T>(v4: () => Promise<T>, old: () => Promise<T>): Promise<T> {
  try {
    return await v4();
  } catch (e) {
    if (!isMissing(e)) throw e;
    return old();
  }
}

const R = (id: string) => `/api/routes/${enc(id)}`;
const P = (id: string) => `/api/p/${enc(id)}`;

export const getSetup = (id: string) => either(() => get<SetupState>(R(id) + "/setup"), () => get<SetupState>(P(id) + "/setup"));

export const saveSetup = (id: string, setup: Setup, note?: string) => {
  const body = note ? { setup, note } : { setup };
  return either(() => put<SetupState>(R(id) + "/setup", body), () => put<SetupState>(P(id) + "/setup", body));
};

export const setupHistory = async (id: string) =>
  (await either(() => get<{ versions: SetupVersionInfo[] }>(R(id) + "/setup/history"), () => get<{ versions: SetupVersionInfo[] }>(P(id) + "/setup/history"))).versions;

export const setupVersion = (id: string, n: number) => either(() => get<SetupVersion>(R(id) + `/setup/v/${n}`), () => get<SetupVersion>(P(id) + `/setup/v/${n}`));

/** The last 100 requests replayed through `setup` on paper; nothing is sent anywhere. */
export const previewSetup = (id: string, setup: Setup, signal?: AbortSignal) =>
  either(() => post<SetupPreview>(R(id) + "/setup/preview", { setup }, signal), () => post<SetupPreview>(P(id) + "/setup/preview", { setup }, signal));

/* ================= the upstream catalog ================= */

export async function fetchCatalog(): Promise<Catalog> {
  CATALOG = await get<Catalog>("/api/upstreams");
  return CATALOG;
}

export const searchUpstreams = (provider: string, q: string, signal?: AbortSignal) =>
  get<{ models: SearchedModel[] }>(`/api/upstreams/search?provider=${enc(provider)}&q=${enc(q)}`, { signal });

export const pinUpstream = (id: string) => post<{ ok: true }>("/api/upstreams/pin", { id });
export const unpinUpstream = (id: string) => post<{ ok: true }>("/api/upstreams/unpin", { id });

/* ---------- connections (keys to upstreams), per account ---------- */

export const listConnections = async () => (await get<{ connections: Connection[] }>("/api/connections")).connections;

export type NewConnection =
  | { kind: "systemone"; name: string; url: string; key?: string }
  | { kind: "openrouter"; key: string }
  | { kind: "openai"; name: string; url: string; key: string };

export const addConnection = (body: NewConnection) => post<Connection>("/api/connections", body);

export const setJevConnection = (body: { key_owner: "ours" | "yours"; key?: string }) => post<Connection>("/api/connections/jev", body);

/** 400 when a route's setup still uses it; the error names the routes. */
export const deleteConnection = (connectionId: string) => post<{ ok: true }>("/api/connections/delete", { id: connectionId });

/* ================= the request pool ================= */

/** A filter as query-string pairs (route repeats). Empty values are left out. */
export function filterQuery(f: ReqFilter): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) v.filter(Boolean).forEach((x) => q.append(k, x));
    else q.set(k, String(v));
  }
  return q;
}

/** The pool. On a server without /api/requests, one route's requests still come from its older examples list (the same
    records), for the filters that list understands; `legacy` says so. Anything else stays "not available yet". */
export async function fetchRequests(f: ReqFilter, offset: number, limit: number, signal?: AbortSignal): Promise<ReqPage & { legacy?: boolean }> {
  const q = filterQuery(f);
  q.set("offset", String(offset));
  q.set("limit", String(limit));
  try {
    return await get<ReqPage>("/api/requests?" + q.toString(), { signal });
  } catch (e) {
    const onlyOld = f.route?.length === 1 && !f.answered_by && !f.missing && !f.labelled && !f.labels_from && !f.maxp && !f.holdout && !f.left_out;
    if (!isMissing(e) || !onlyOld) throw e;
    const id = f.route![0];
    const eq = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (f.kind) eq.set("schema", f.kind);
    if (f.source) eq.set("source", f.source);
    if (f.key) eq.set("key", "key " + f.key);
    if (f.q) eq.set("q", f.q);
    if (f.since) eq.set("since", f.since);
    if (f.until) eq.set("until", f.until);
    if (f.disagree) eq.set("disagree", "1");
    const [page, proj] = await Promise.all([get<ExamplesPage>(P(id) + "/examples?" + eq.toString(), { signal }), cachedProject(id) ? Promise.resolve(cachedProject(id)!) : fetchProject(id)]);
    return { total: page.total, requests: page.calls.map((x) => exampleToReq(x, proj)), legacy: true };
  }
}

/** An older example record as a pool request: the same fields under the v4 names. */
function exampleToReq(x: Example, proj: ProjectDetail): Req {
  const set = proj.question_sets.find((s) => s.id === x.schema);
  const questions: Questions = x.question_defs || set?.question_defs || Object.fromEntries(x.questions.map((q) => [q, { type: "choice" as const }]));
  const answers: Req["answers"] = {};
  for (const [k, v] of Object.entries(x.answers || {})) {
    if (!v) continue;
    const m: Record<string, Ans> = {};
    for (const [q, a] of Object.entries(v)) {
      const r = typeof a === "string" ? { answer: a } : a && typeof a === "object" && "answer" in a ? { answer: String(a.answer), p: a.p, dist: a.dist } : null;
      if (r) m[q] = r;
    }
    answers[k] = m;
  }
  if (x.jev && Object.keys(x.jev).length && !answers.jev) answers.jev = x.jev;
  if (x.local && Object.keys(x.local).length && !answers.model) answers.model = Object.fromEntries(Object.entries(x.local).map(([q, a]) => [q, { answer: String(a) }]));
  const ext = x as Example & { grounded?: Record<string, Ans> | null; grounded_by?: string | null; route?: string; path?: Req["path"] };
  const labels = ext.grounded || null;   // only the labeller's answers are labels; Jev's answer stays under answers.jev
  return {
    id: x.id,
    route: proj.project.id,
    route_name: proj.project.name,
    kind: x.schema,
    kind_name: set ? set.name || set.plan?.name || set.questions.join(", ") : null,
    t: x.t,
    source: x.source || null,
    via: x.via || null,
    state: x.state,
    questions,
    served: x.served || (x.jev && Object.keys(x.jev).length ? "jev" : null),
    ms: x.ms || null,
    path: ext.path || null,
    answers,
    labels_from: ext.grounded_by ?? null,
    labels,
    corrections: x.corrections || null,
    holdout: !!x.holdout,
    pending_label: x.pending_label || null,
    excluded: x.excluded,
    left_out: (x as Example & { left_out?: Req["left_out"] }).left_out ?? null,
    chunks: x.chunks || null,
  };
}

export const fetchFacets = (f: ReqFilter, signal?: AbortSignal) => get<Facets>("/api/requests/facets?" + filterQuery(f).toString(), { signal });

const sel = (s: Selection) => ("ids" in s ? { ids: s.ids } : { filter: s.filter });

export const estimateAsk = (s: Selection, upstream: string, signal?: AbortSignal) =>
  post<AskEstimate>("/api/requests/estimate", { ...sel(s), action: "ask", upstream }, signal);

export const askUpstream = (ids: string[], upstream: string) => post<AskResult>("/api/requests/ask", { ids, upstream });

export const pinLabels = (s: Selection, from: string | null) => post<{ labelled: number; missing: number }>("/api/requests/labels", { ...sel(s), from });

export const removeRequests = (ids: string[]) => post<{ removed: number }>("/api/requests/remove", { ids });

export const exportUrl = (f: ReqFilter) => {
  const q = filterQuery(f);
  q.set("format", "jsonl");
  return API + "/api/requests/export?" + q.toString();
};

/** A person's pick for one question of one request (the older per-model endpoint, which the contract keeps). */
export const correctRequest = (routeId: string, body: { id: string; qid: string; label: string | number | null }) =>
  post<{ ok: true }>(P(routeId) + "/examples/correct", body);

/* ================= trained models ================= */

export const fetchModels = () => get<ModelsPage>("/api/models");

export const fetchBases = () => get<Base[]>("/api/models/bases");

export const estimateModel = (body: { route: string; base: string; epochs: number; labels_from?: string; include_left_out?: boolean } & Selection, signal?: AbortSignal) =>
  post<ModelEstimate>("/api/models/estimate", body, signal);

/** Make a new browser copy of a trained version (into private storage; takes a few minutes, the Models page shows it preparing). */
export const makeBrowserCopy = (route: string, version: number) =>
  post<{ ok: true; job: string; version: number }>(`/api/p/${encodeURIComponent(route)}/model/export-web`, { version });
export const trainModel = (body: { route: string; base: string; epochs: number; labels_from?: string; include_left_out?: boolean; name?: string } & Selection) =>
  post<{ version: number; job: string }>("/api/models/train", body);

/** Train drawer, "Check a few labels first": up to 8 requests of the pick worth a look, and how many labels are below the bar. */
export const checkLabels = (body: { route: string; include_left_out?: boolean } & Selection, signal?: AbortSignal) =>
  post<LabelCheck>("/api/models/check-labels", body, signal);

/* ================= older per-route endpoints the admin still uses (Try it, the question sets, usage) ================= */

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const d = await get<ProjectDetail>(P(id));
  DETAIL.set(id, d);
  return d;
}
export const cachedProject = (id: string) => DETAIL.get(id) ?? null;

export const fetchExamples = (id: string, query: string) => get<ExamplesPage>(P(id) + "/examples?" + query);

export async function fetchExample(id: string, exId: string): Promise<Example | null> {
  const r = await get<ExamplesPage>(P(id) + "/examples?limit=1&id=" + enc(exId));
  return r.calls[0] ?? null;
}

/** The playground: one request answered by `target`, with `compare` answering the same request too. Recorded as a
    request (source typed); the compare answers land on the same request once they finish. */
export const tryRequest = (id: string, body: { state: unknown; questions: Questions; target: string; compare?: string[] }) =>
  post<TypedResult>(P(id) + "/try", body);

/** Everything this account has used, all routes together (GET /api/credits). */
export const fetchUsage = () => get<Usage>("/api/credits");
export const fetchAnalytics = (days: 7 | 30, route: string | null, signal?: AbortSignal) =>
  get<Analytics>(`/api/analytics?days=${days}${route ? "&route=" + encodeURIComponent(route) : ""}`, { signal, timeoutMs: 30000 });

export async function refreshCredits(id: string): Promise<Credits | null> {
  try {
    return await get<Credits>(P(id) + "/credits");
  } catch {
    return null;
  }
}

/** A request through the route's URL with its key, the way the customer's app sends it. `x-dopp-test: 1` makes it a
    connectivity test: answered, not saved. Returns what came back, errors included. */
export async function sendTestRequest(url: string, key: string, body: { state: unknown; questions: Questions }) {
  const t0 = performance.now();
  // same path on this origin: the Worker that serves the admin (or the dev proxy) is the one behind the route's URL
  let path = "/v1/systemone";
  try {
    path = new URL(url, location.origin).pathname;
  } catch {
    /* keep the default */
  }
  let r: Response;
  try {
    r = await fetch(API + path, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-dopp-test": "1" },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, ms: Math.round(performance.now() - t0), body: { error: "Couldn't reach the route's URL from this browser." } as Record<string, unknown> };
  }
  const text = await r.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text.slice(0, 300) };
  }
  return { status: r.status, ms: Math.round(performance.now() - t0), body: parsed };
}

/** A setup drafted from plain words (not saved): the board loads it as a draft. 422/503 carry the reason in `error`. */
export const describeSetup = (id: string, text: string) =>
  post<{ setup: Setup; reasons: { block: string; why: string }[]; note: string | null }>(R(id) + "/setup/describe", { text });

/* ---------- credits (worker/src/billing.js; billing is off in this repo) ---------- */

/** Prepaid credits (GET /api/billing). Off in this repo. */
export interface Billing {
  balance: number;
  /** what can actually be spent now: the free credit is only fully unlocked once a card is on file */
  spendable: number;
  allowance: number;
  locked: number;
  card: { brand: string | null; last4: string | null } | null;
  free: number;
  granted: number;
  used: number;
  packs: number[];
  payments: boolean;
  purchases: { usd: number; kind: string; t: number; note: string | null }[];
  /** hosting: the monthly price per hosted model, and the account's subscriptions */
  hosted_usd: number;
  serving_usd_per_hour: number;
  subscriptions: { project_id: string; name: string; status: string; period_end: number | null; cancel_at_period_end: number }[];
}
export const fetchBilling = () => get<Billing>("/api/billing");
export const startCheckout = (usd: number) => post<{ url: string }>("/api/billing/checkout", { usd });
export const addCard = () => post<{ url: string }>("/api/billing/card");
export const subscribeHosting = (project: string) => post<{ url: string }>("/api/billing/subscribe", { project });
export const unsubscribeHosting = (project: string) => post<{ ok: boolean }>("/api/billing/unsubscribe", { project });
/** one tiny request to the current version so the next real request finds it awake */
export const wakeModel = (id: string) => post<{ ok: boolean; version: number; seconds: number }>(`/api/p/${enc(id)}/model/wake`);

/* ---------- adding requests to a route: paste, public datasets, generated (the Worker's /api/p/:id/… under /api/routes/:id/…) ---------- */

/** Pasted text (lines, CSV, JSON, JSONL) read into states; nothing is saved. */
export const parseRows = (id: string, text: string, column?: string) =>
  post<ParseResult>(R(id) + "/examples/parse", column ? { text, column } : { text });
/** States saved as requests of one kind (tagged pasted), each answered by Jev. At most 1,000 per call. */
export const pasteRows = (id: string, body: { schema: string; states: unknown[] }) => post<IngestResult>(R(id) + "/examples/paste", body);
/** Public Hugging Face datasets whose rows read like this kind of request, scored for fit by Jev. */
export const findDatasets = (id: string, schema: string, q?: string) =>
  get<DatasetCard[]>(R(id) + "/datasets/find?schema=" + enc(schema) + (q ? "&q=" + enc(q) : ""), { timeoutMs: 120000 });
/** Rows of a dataset saved as requests and answered by Jev. */
export const addDatasetRows = (
  id: string,
  body: { dataset: string; column: string; count: number; schema: string; config?: string; split?: string; offset?: number },
) => post<IngestResult & { schema?: string }>(R(id) + "/datasets/use", body);
/** What the generator will write for this kind of request, read from its real requests. */
export const planRequests = (id: string, schema: string) => post<Plan>(R(id) + "/examples/plan", { schema });
/** New requests written from real ones, answered by Jev; ones that don't read like the real ones are dropped. Up to 50. */
export const generateRequests = (id: string, body: { schema: string; count: number; target?: { qid: string; answer: string }; prompt?: string }) =>
  post<IngestResult>(R(id) + "/examples/generate", body);
