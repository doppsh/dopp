export type QuestionType = "choice" | "noul" | "score";

export interface QuestionDef {
  type: QuestionType;
  instructions?: string;
  criteria?: Record<string, string | null> | string[];
}

export type Questions = Record<string, QuestionDef>;

export interface AgreementSlice {
  n: number;
  agree: number;
}

export interface Agreement {
  n?: number;
  /** held-out: how many of the n the model gave an answer for (a missing one counts as a miss) */
  answered?: number;
  /** held-out: answers with no held-out request, so the figure says nothing about them */
  missing_answers?: string[];
  overall?: number;
  per_answer?: Record<string, AgreementSlice>;
  by_version?: Record<string, AgreementSlice>;
  ready_to_switch?: boolean;
}

export interface Readiness {
  calls: number;
  /** requests with a label, outside the held-out ones: what training and the automatic plans count */
  labelled?: number;
  counts?: Record<string, Record<string, number>>;
  waiting?: string[];
  ready?: boolean;
}

/** One question-set as the engine lists it (GET /api/p/:id → question_sets). */
export interface QuestionSet {
  id: string;
  tenant?: string;
  questions: string[];
  question_defs?: Questions;
  readiness: Readiness;
  agreement?: Agreement;
  name?: string | null;
  archived?: boolean;
  declared?: boolean;
  first_seen?: number;
  last_seen?: number;
  /** landing tally only */
  recent?: Record<string, [string, string]>[];
  /** fixed: one question per id. chunks: one template question asked about every chunk of a text. */
  shape?: Shape;
  /** chunk sets only: how Dopp turns a raw text into requests (learned from the first real request) */
  recipe?: { chunker: string; text_field: string; batch: number } | null;
  /** datasets found automatically after the third real request */
  suggestions?: { t: number; datasets: DatasetCard[] } | null;
  /** chunk sets: labelled chunks so far */
  chunks?: number;
  /** what the product will do when it writes examples for this set, if already worked out */
  plan?: Plan | null;
}

/** What the product says it will do before writing examples, read from the set's real requests. */
export interface Plan {
  /** a short human name for this kind of request, from the generator (e.g. "PII yes/no per word") */
  name?: string | null;
  summary: string;
  state_kind?: string;
  constant?: string[];
  varying?: string[];
  questions_depend_on_state?: boolean;
  questions_rule?: string;
  seed_field?: string | null;
  confidence?: number;
  unsure?: string;
  correction?: string | null;
}

export type Shape =
  | { kind: "fixed" }
  | { kind: "chunks"; type: QuestionType; criteria?: QuestionDef["criteria"] | null; template: string; prefix: string };

export interface ChunkSpan {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface Correction {
  label: string | number;
  by?: string;
  t?: number;
}

export type Source = "traffic" | "typed" | "pasted" | "public" | "generated";

/** One answer: the top option, its probability, and every option with its probability (most likely first). */
export type Ans = { answer: string; p?: number; dist?: [string, number][] };
/** One raw answer: what the engine stores ({answer, p, dist}) or a bare label. */
export type RawAnswer = Ans | string;

/** One example. The engine and API call these "calls"; the UI says "examples". */
export interface Example {
  id: string;
  schema: string;
  line?: number;
  t: number;
  state: unknown;
  via?: string | null;
  source?: Source | null;
  holdout?: boolean;
  v?: number;
  jev: Record<string, Ans>;
  local?: Record<string, string> | null;
  /** v2: every target that answered, keyed by target. */
  answers?: Record<string, Record<string, RawAnswer> | null>;
  served?: string | null;
  /** when the chosen answerer failed and another answered: who was tried and why it didn't answer */
  fallback?: { from: string; reason: string } | null;
  /** milliseconds each answerer took, by target (jev, model, …) */
  ms?: Record<string, number> | null;
  errors?: Record<string, number> | null;
  model?: string | null;
  corrections: Record<string, Correction>;
  excluded?: boolean;
  /** why this example has no label yet (the labeller's error when it was added) */
  pending_label?: string;
  questions: string[];
  meta?: Record<string, unknown>;
  /** chunk sets: this example's own questions (one per chunk) */
  question_defs?: Questions;
  /** chunk sets: where each chunk sits in the text, or null if it can't be located */
  chunks?: ChunkSpan[] | null;
}

export interface ExamplesPage {
  total: number;
  offset: number;
  limit: number;
  calls: Example[];
}

export interface ProxyKey {
  id: string;
  prefix: string;
  created_at: number;
  revoked_at?: number | null;
  last_used_at?: number | null;
  project_id?: string | null;
}

export interface Me {
  user: { id: string; email: string };
  workspace: { id: string; name: string; jev_mode: "understudy" | "own"; has_ts_key: boolean };
  keys: ProxyKey[];
  proxy_url: string;
  projects?: { id: string; name: string }[];
}

/* ---------- projects ---------- */

export type ModelStatus = "collecting" | "training" | "shadow" | "ready";

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string | null;
  tags?: string[];
  tenant: string;
  keys: number;
  /** null when the engine couldn't be reached */
  examples: number | null;
  model: { version: number; status: ModelStatus | string } | null;
  created_at: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  tags?: string[];
  keywords?: string[];
  tenant: string;
  created_at: number;
}

export interface ModelVersion {
  version: number;
  /** which base it was trained from: laya | kev-0.8b | kev-4b */
  base?: string;
  trained_rows: number;
  /** labelled requests the route had when this version started training (the next automatic training counts from here) */
  trained_on?: number;
  t: number | null;
  holdout_agreement?: Agreement | null;
  /** where to load this version's browser copy from (a path on this site, served to the route's owner only), when web_status is ready */
  web_url?: string | null;
  /** why the browser copy couldn't be made, when it failed */
  web_error?: string | null;
  web_status?: WebStatus;
  /** when the browser copy was asked for (seconds), while it is being prepared */
  web_started?: number | null;
}

/** A trained version's browser copy: ready (load it from web_url) | preparing | failed (web_error says why) |
    needs_copy (its only copy is an old public one, from before copies were private; make a new one) | none (its base doesn't run in a browser). */
export type WebStatus = "ready" | "preparing" | "failed" | "needs_copy" | "none";

export interface Gap {
  qid: string;
  answer: string;
  have: number;
  need: number;
}

export interface ModelInfo {
  group: string;
  version: number;
  /** whether the current version's container is up right now; it sleeps idle_minutes after its last answer and takes ~wake_seconds to wake */
  serving?: { awake: boolean; since: number | null; wake_seconds: number; idle_minutes: number } | null;
  base?: string | null;
  /** the bases this server can train: id → display name */
  bases?: Record<string, string>;
  status: ModelStatus | string;
  trained_rows?: number | null;
  trained_on?: number;
  last_error?: string | null;
  train_started?: number | null;
  /** the trainer's latest progress lines while a run is going */
  train_log?: string[] | null;
  versions: ModelVersion[];
  agreement_traffic?: Agreement | null;
  agreement_examples?: Agreement | null;
  readiness?: { calls: number; gaps: Gap[]; ready: boolean };
  /** each setup plan that trains by itself: how far it is from its next run (the same test the server runs after each label) */
  auto?: AutoPlan[];
}

export interface AutoPlan {
  plan: string;
  name: string;
  base: string;
  epochs: number;
  /** null = each request's "who is right"; a list overrides it for this plan */
  oracle: string[] | null;
  cohort: unknown;
  /** true until the plan has a trained version */
  first: boolean;
  /** labelled requests counted so far (since its latest version, if it has one) and how many start a run */
  have: number;
  need: number;
  until_agreement: boolean;
  /** labels: fewer than `need`; training: a run of this base is going; agreement: its latest version already agrees well enough; null: the next label starts it */
  waiting: "labels" | "training" | "agreement" | null;
}

export interface ExampleStats {
  by_source: Partial<Record<Source, number>>;
  holdout: number;
  corrected: number;
  excluded: number;
  /** examples saved without a label because the labeller was unavailable when they were added */
  pending_label?: number;
}

/* ---------- credits ---------- */

export interface Credits {
  /** dollars used so far, margin included */
  used: number;
  lines: { kind: "jev" | "generator" | "training" | string; calls: number; units: number; usd: number }[];
  margin: number;
  /** what one more example costs here, from this model's own history (null until there is history) */
  per_example: { label: number | null; write: number | null; label_guess?: number; write_guess?: number };
  unmetered: string[];
  /** recorded at our cost, not billed: what the product did on its own */
  on_us?: { calls: number; usd: number; what: string | null };
}

/* ---------- routing ---------- */

export interface Target {
  on: boolean;
  version?: "latest" | number;
  url?: string;
  auth_enc?: string;
  name?: string;
  has_auth?: boolean;
}

export type Rule =
  | { id: string; type: "header"; on: boolean }
  | { id: string; type: "split"; on: boolean; weights: Record<string, number> }
  | { id: string; type: "confidence_gate"; on: boolean; below: number; ask: string }
  | { id: string; type: "fallback"; on: boolean; to: string; timeout_ms: number }
  | { id: string; type: "shadow"; on: boolean; target: string; pct: number }
  | { id: string; type: "cache"; on: boolean; ttl_s: number };

export type RuleType = Rule["type"];

export interface Routing {
  targets: Record<string, Target>;
  rules: Rule[];
  /** keep the current version's server awake (pinged on a schedule) so no request waits for it to wake */
  keep_awake?: boolean;
}

export interface RoutingPreview {
  n: number;
  by_target: Record<string, number>;
  shadow_by_target?: Record<string, number>;
  est_cost_per_1000: number;
  est_p50_ms: number;
  sample?: { id: string; served: string; rule: string }[];
}

export interface ProjectDetail {
  project: Project;
  keys: ProxyKey[];
  question_sets: QuestionSet[];
  model: ModelInfo | null;
  routing: Routing | null;
  stats: ExampleStats | null;
  proxy_url?: string;
  endpoints?: { id: string; target: string; name: string; url: string; has_key: boolean; created_at: number }[];
  /** which parts the engine failed to return, with its status and body */
  errors?: Partial<Record<"model" | "routing" | "stats", { status: number; body: unknown }>>;
}

/* ---------- faucets ---------- */

export interface Dropped {
  format?: number;
  realism?: number;
  duplicate?: number;
}

export interface IngestResult {
  /** paste / dataset use */
  recorded?: number;
  /** generate */
  added?: number;
  /** saved without a label (the labeller was unavailable); label them later from the Examples page */
  pending?: number;
  /** recorded but left out of training by default: Jev thought they didn't read like the real requests (include them from the row) */
  left_out?: number;
  holdout: number;
  failed?: { i: number; error: string }[];
  ids?: string[];
  /** a bare count (older paths) or counts by reason */
  dropped?: number | Dropped;
  reasons?: string[];
  /** rows read from the dataset */
  pulled?: number;
  from_row?: number;
  next_row?: number;
  /** true: each row was placed into the state's text field and the rest of the request written to match the plan */
  composed?: boolean;
  plan?: Plan | null;
  asked?: number;
  gate?: string;
}

export interface TrainEstimate {
  base: string;
  epochs: number;
  requests: number;
  sequences?: number;
  /** examples kept aside to measure this version */
  holdout?: number;
  avg_tokens?: number;
  minutes: number;
  cost: number;
  gpu?: string;
  /** the cohort the server actually applied (normalised); absent when it ignored the filter and counted everything */
  cohort?: Cohort | null;
}

export interface ParseResult {
  states: unknown[];
  format: "jsonl" | "json" | "csv" | "lines" | "hint" | string;
  column?: string;
  columns?: string[];
  picked_by?: string;
  n?: number;
}

export interface DatasetCard {
  id: string;
  name: string;
  url: string;
  rows: number;
  description?: string;
  sample: string[];
  columns: string[];
  fit: number;
  informs: string[];
  reason?: string;
  /** the Worker's pick for the text column */
  column?: string;
  config?: string;
  split?: string;
  /** where this model is in the dataset: the next unread row (0-based) and rows used so far, remembered server-side */
  next_row?: number;
  used_rows?: number;
}

/** Jev-shaped answer as /v1/systemone returns it. */
export interface WireAnswer {
  type: string;
  choice?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
}

export interface TypedResult {
  id?: string;
  example_id?: string;
  model?: string;
  answers?: Record<string, WireAnswer>;
  understudy?: { served: string; rule?: string; shadow?: string[]; example?: string; recorded?: boolean; fallback?: { from: string; reason: string } };
  schema?: string;
}

/* ---------- the request log ---------- */

/** One request through a key, as the proxy logged it (GET /api/p/:id/requests). Rejected and failed ones too. */
export interface LoggedRequest {
  id: string;
  /** unix seconds */
  t: number;
  /** "key us_xxxxx" */
  key?: string | null;
  /** the HTTP status your app got */
  status: number;
  ok: boolean;
  /** why it was rejected or failed */
  error?: string | null;
  served?: string | null;
  ms?: number | null;
  fallback?: { from: string; reason: string } | null;
  /** the full request when it was recorded (answers, what it trains on); null for rejected, failed and test requests */
  example?: Example | null;
}

export interface RequestLogPage {
  total: number;
  offset: number;
  limit: number;
  requests: LoggedRequest[];
}

/** Which requests train the next version. Sent as `cohort` to POST /model/train and (JSON) to GET /model/estimate. */
export interface Cohort {
  /** where requests came from; empty or missing = every source */
  sources?: Source[];
  /** key prefixes ("us_ab12c"), only meaningful with "traffic"; empty = every key */
  keys?: string[];
  /** kinds of request (question-set ids); empty = every kind */
  schemas?: string[];
  /** seconds since the epoch, inclusive */
  since?: number | null;
  until?: number | null;
  /** only requests with a grounded answer (the labeller's, or one a person picked). Training needs one, so always true today. */
  labelled_only: true;
  /** only requests where the model's recorded answer and the grounded answer differ */
  disagreements_only?: boolean;
}

/** One answerer anywhere in the UI: Jev, the version on our servers, a version or base Laya in this browser, an endpoint. */
export interface Answerer {
  /** "jev" | "model" | "endpoint:<id>" | "web:<version>" | "web:laya" | "recorded" */
  key: string;
  /** what the UI calls it: "Jev", "support-triage v2", "support-triage v2 in this browser", "base Laya in this browser" */
  name: string;
  where: "server" | "browser" | "recorded";
  /** browser only: the weights URL */
  base?: string;
  version?: number;
}

/** Account-wide usage: GET /api/credits. Dollars include the margin. */
export interface Usage {
  used: number;
  by_project: { id: string; name: string; used: number }[];
  lines: { kind: string; calls: number; units: number; usd: number }[];
  margin: number;
  unmetered: string[];
  /** recorded at our cost, not billed: what the product did on its own */
  on_us?: { calls: number; usd: number; what: string | null };
}

/* ---------- setup v2 ---------- */

/** An outside service the account plugged in once, for every model. `jev` is built in. */
export interface Connection {
  id: string;
  kind: "jev" | "systemone" | "gemini" | "anthropic" | "openai" | string;
  name: string;
  url: string;
  /** "ours" = Dopp's key, billed through credits; "yours" = the account's own */
  key_owner: "ours" | "yours";
  has_key: boolean;
  built_in: boolean;
}

/** What an answerer id in a setup means. Connection ids: `jev`, `endpoint:<connection id>`; versions: `model` (plan main,
    latest), `plan:<plan id>` (another plan's latest), or a pinned version. */
export type AnswererDef =
  | { kind: "connection"; connection: string }
  | { kind: "version"; plan: string; version: "latest" | number; project?: string }
  /** v4: an LLM from the catalog */
  | { kind: "llm"; id: string }
  /** v4: something from the catalog whose definition the server derives from its id */
  | { kind: "upstream"; upstream: string }
  /** you: your fixes on Requests are the labels. Only ever a labeller ("who is right"), never asked. */
  | { kind: "person" };

/** One try in a route: ask one answerer, or split requests between several by weight (weights sum to 100). */
export interface RouteStep {
  ask?: string;
  split?: Record<string, number>;
  /** move on when it takes longer than this */
  wait_ms?: number;
  /** move on when its least sure question is below this probability */
  unsure_below?: number | null;
}

export interface RouteMatch {
  /** kinds of requests (question-set ids); empty = any */
  kinds: string[];
  /** key prefixes; empty = any */
  keys: string[];
  sources: Source[];
}

export interface SetupRoute {
  id: string;
  name: string;
  match: RouteMatch;
  allow_header: boolean;
  steps: RouteStep[];
  background: { ask: string; pct: number }[];
  /** who is right, in order: the grounded answer is the first of these that answered (a person's fix always wins) */
  oracle: string[];
  /** if oracle[0] didn't answer, ask it after the reply on this % of requests */
  fill_pct: number;
  cache_s: number | null;
}

export type PlanCohort = Pick<Cohort, "sources" | "keys" | "schemas" | "since" | "until">;

export interface SetupPlan {
  id: string;
  name: string;
  base: string;
  epochs: number;
  cohort: PlanCohort | null;
  /** null = each request's route oracle; a list overrides it for this plan only */
  oracle: string[] | null;
  /** null = by hand only */
  auto: { first_at: number; every: number; until_agreement: boolean } | null;
}

export interface Setup {
  answerers: Record<string, AnswererDef>;
  routes: SetupRoute[];
  plans: SetupPlan[];
  /** judges generated requests (realism) and dataset fit */
  checker: string;
  keep_awake: boolean;
}

/** One answerer the setup could use, with its measured speed and price. */
export interface AnswererView {
  id: string;
  name: string;
  kind: "connection" | "version" | "llm" | string;
  plan?: string;
  version?: "latest" | number;
  connection?: string;
  route?: string;
  route_name?: string;
  provider?: string;
  price_basis?: "measured" | "list" | null;
  connection_kind?: string | null;
  ready: boolean;
  why_not: string | null;
  p50_ms: number | null;
  per_1000_usd: number | null;
  /** why there is no price (e.g. "billed by that service") */
  price_note?: string | null;
  /** false: the price is a list-price guess, not history */
  measured: boolean;
  /** whether p50_ms is measured from history */
  measured_ms?: boolean;
  /** `model` (latest): the version it answers with right now */
  resolves_to?: number | null;
}

export interface SetupPreset {
  id: string;
  name: string;
  summary: string;
  setup: Setup;
  /** e.g. "a trained version": the preset can't run until that exists */
  needs?: string | null;
}

export interface SetupVersionInfo {
  version: number;
  saved_at: number;
  saved_by: string | null;
  note?: string | null;
}

export interface SetupVersion extends SetupVersionInfo {
  setup: Setup;
}

/** GET /api/p/:id/setup */
export interface SetupState extends SetupVersion {
  answerers: AnswererView[];
  connections: Connection[];
  kinds: { id: string; name: string; requests: number }[];
  keys: { prefix: string; requests: number }[];
  sources: Partial<Record<Source, number>>;
  bases: { id: string; name: string }[];
  /** requests per route id in the last 24 hours */
  routes_24h: Record<string, number>;
  presets: SetupPreset[];
  /** the newest ready version of the main plan, if any */
  latest_version?: number | null;
  /** how long a saved setup can take to reach every request (the proxy's key cache, KEY_CTX_MS on the server) */
  applies_within_s?: number;
}

/** POST /api/p/:id/setup/preview: the last requests replayed through a setup on paper. */
export interface SetupPreview {
  n: number;
  /** may include "nobody" when no step could answer */
  by_answerer: Record<string, number>;
  background_by_answerer?: Record<string, number>;
  est_cost_per_1000: number | null;
  est_p50_ms: number | null;
}

/* ================= v4: routes, the upstream catalog, one request pool, trained models ================= */

export type UpstreamKind = "jev" | "llm" | "url" | "model" | "open";
export type KeyOwner = "ours" | "yours" | "none";

/** Anything that answers in Jev's shape. Its id is also the key its answers are stored under on a request. */
export interface Upstream {
  id: string;
  /** the key this upstream's answers carry in Req.answers and in the answered_by / labels_from / disagree filters
      (a route's model: `model:<route>` for every version; others = id) */
  answers_key?: string;
  name: string;
  kind: UpstreamKind;
  provider: string;
  key: KeyOwner;
  ready: boolean;
  why_not: string | null;
  per_1000_usd: number | null;
  /** "measured": from this account's history; "list": the provider's list price (a guess) */
  price_basis: "measured" | "list" | null;
  price_note: string | null;
  p50_ms: number | null;
  measured_ms: boolean;
  /* trained models only */
  route?: string;
  route_name?: string;
  version?: number;
  base?: string;
  trained_rows?: number;
  holdout_agreement?: number | Agreement | null;
  used_by?: string[];
  runs_in_browser?: boolean;
  web_url?: string | null;
  /* open models (and Jev): JevBench v1.4.1 composite where the exact model is listed; licence, weights and a one-line note */
  jevbench?: number | null;
  /** open models: GPU time while it answers, and one wake-up (it stays up ~10 minutes after its last request) */
  per_hour_usd?: number;
  wake_usd?: number;
  license?: string;
  repo?: string;
  note?: string;
  trainable?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  connected: boolean;
  key_owner: "ours" | "yours" | null;
}

export interface Catalog {
  upstreams: Upstream[];
  providers: Provider[];
}

/** One model from a provider's live list (GET /api/upstreams/search). */
export interface SearchedModel {
  id: string;
  name: string;
  context?: number | null;
  per_1m_in_usd?: number | null;
  per_1m_out_usd?: number | null;
  /** assumes ~600 input + 60 output tokens per request */
  per_1000_est_usd?: number | null;
}

export interface RouteKey {
  id: string;
  prefix: string;
  created_at?: number | null;
  last_used_at?: number | null;
  revoked_at?: number | null;
}

export interface RouteSummary {
  id: string;
  name: string;
  created_at: number;
  /** the first step's upstream id */
  upstream: string | null;
  upstream_name: string | null;
  /** "support-triage v1 → below 70% → Jev" */
  setup_summary: string | null;
  requests_24h: number | null;
  requests_total: number | null;
  cost_24h_usd: number | null;
  keys: RouteKey[];
  latest_model: { id: string; name: string } | null;
}

export interface RoutesPage {
  routes: RouteSummary[];
  /** the one URL every route shares; the key picks the route */
  url: string;
  /** true when this server has no /api/routes yet and the list came from the older /api/projects (fewer columns) */
  legacy?: boolean;
}

export type PresetId = "learn" | "only" | "model_first" | "model_only" | string;

export interface CreatedRoute {
  route: RouteSummary;
  /** the full key, shown once */
  key: string;
  setup?: unknown;
}

/** Where a request went at ingest: each step tried, why it moved on, who answered in the background. */
export interface PathStep {
  ask: string;
  ok: boolean;
  ms?: number | null;
  conf?: number | null;
  code?: number | null;
  reason?: "error" | "slow" | "unsure" | "skipped" | string | null;
}

export interface ReqPath {
  route?: string | null;
  steps: PathStep[];
  background?: string[];
  served?: string | null;
}

/** One request in the pool. `answers` holds every upstream's answer, keyed by upstream id. */
export interface Req {
  id: string;
  route: string;
  route_name: string;
  kind: string;
  kind_name: string | null;
  t: number;
  source: Source | null;
  via: string | null;
  state: unknown;
  questions: Questions;
  served: string | null;
  ms: Record<string, number> | null;
  /** how long the caller waited, from the Worker receiving the request to the reply (null when not recorded) */
  waited_ms?: number | null;
  path: ReqPath | null;
  answers: Record<string, Record<string, Ans> | null>;
  /** whose answers are the labels (upstream id), or null when a person's fixes or the route's oracle decide */
  labels_from: string | null;
  labels: Record<string, Ans> | null;
  corrections: Record<string, Correction> | null;
  holdout: boolean;
  pending_label?: string | null;
  excluded?: boolean;
  /** why it is left out of training: the realism check ("didn't read like your requests") or a person; null when it trains */
  left_out?: "realism" | "person" | null;
  /** chunk kinds */
  chunks?: ChunkSpan[] | null;
}

export interface ReqPage {
  total: number;
  requests: Req[];
}

export interface Facets {
  routes: Record<string, number>;
  kinds: Record<string, { name: string; n: number }>;
  sources: Record<string, number>;
  answered_by: Record<string, number>;
  labels_from: Record<string, number>;
  /** requests in this filter that are left out of training */
  left_out?: number;
  /** not in the contract yet; used when the server sends it */
  keys?: Record<string, number>;
  total: number;
}

/** The request filter: the same names in the page URL and in the API's query string. */
export interface ReqFilter {
  route?: string[];
  kind?: string;
  source?: string;
  key?: string;
  answered_by?: string;
  missing?: string;
  labelled?: "1" | "0";
  labels_from?: string;
  /** "a,b" */
  disagree?: string;
  /** 0–1 */
  maxp?: string;
  q?: string;
  since?: string;
  until?: string;
  holdout?: "1" | "0";
  /** left out of training (by the realism check or a person) */
  left_out?: "1" | "0";
}

/** POST /api/models/check-labels */
export interface LabelCheck {
  /** labelled requests in the pick that would train */
  labelled: number;
  /** of those, labels less sure than below_at (not yet picked by a person) */
  below: number;
  below_at: number;
  fixed_by_person: number;
  requests: Req[];
}

/** Which requests an action applies to: a filter ("all N matching") or picked ids. */
export type Selection = { filter: ReqFilter } | { ids: string[] };

export interface AskEstimate {
  /** the selection's request ids, to page into /ask 25 at a time */
  ids?: string[];
  n: number;
  already_answered: number;
  to_ask: number;
  est_usd: number | null;
  est_minutes: number | null;
  key: KeyOwner;
}

export interface AskResult {
  asked: number;
  failed: { id: string; error: string }[];
}

export interface TrainedModel {
  /** Tiny: the offline folder (zip with serve.py) */
  offline_url?: string | null;
  offline_status?: "ready" | "preparing" | "failed" | null;
  id: string;
  name: string;
  route: string;
  route_name?: string;
  latest?: boolean;
  error?: string | null;
  log?: string[] | null;
  version: number;
  base: string;
  status: string;
  t: number | null;
  trained_rows: number | null;
  holdout_agreement: number | Agreement | null;
  /** the filter it was trained on */
  cohort: ReqFilter | Record<string, unknown> | null;
  used_by: string[];
  web_url: string | null;
  web_status?: WebStatus;
  web_error?: string | null;
  web_started?: number | null;
  /** URL of the trained weights as a tar, when the base's engine hands them back */
  download?: string | null;
}

/** A training that is running. The contract lists it as "[...running]"; these are the fields the page reads when present. */
export interface TrainingRun {
  route: string;
  route_name?: string;
  name?: string;
  version?: number;
  base?: string;
  started?: number | null;
  status?: string;
  progress?: number | null;
  log?: string[] | null;
  requests?: number | null;
}

export interface ModelsPage {
  models: TrainedModel[];
  training: TrainingRun[];
}

export interface Base {
  id: string;
  name: string;
  size?: string | null;
  runs_in_browser?: boolean;
  /** a trained version can be downloaded to run offline */
  downloads?: boolean;
  /** where a trained version runs: on Dopp's servers, in a browser tab, downloaded */
  runs?: ("server" | "browser" | "download")[];
  /** how it reads a question: its text, or its id (one head per question id) */
  reads?: "text" | "id" | "fixed" | null;
  about?: string | null;
  ready?: boolean;
  why_not?: string | null;
}

export interface ModelEstimate {
  /** a guess, not history (e.g. "guess until the first run is measured") */
  estimate?: string | null;
  gpu?: string | null;
  ready?: boolean;
  why_not?: string | null;
  requests: number;
  sequences?: number;
  holdout?: number;
  minutes: number;
  cost: number;
  /** where every picked request goes; trains is the exact number the trainer gets */
  breakdown?: TrainBreakdown | null;
}

export interface TrainBreakdown {
  total: number;
  /** written requests the realism check marked "didn't read like your requests" */
  left_out: number;
  left_out_included: boolean;
  /** removed from training by a person */
  removed: number;
  held_out: number;
  no_label: number;
  /** thinned so one answer doesn't dominate */
  balanced_away: number;
  trains: number;
  /** of the rows that train, how many the trainer sets aside to tune its confidence (Laya) */
  calibration?: number;
}

/** GET /api/analytics (worker/src/analytics.js). Times in ms, t in seconds. */
export type Dist = { n: number; p50: number | null; p95: number | null; p99: number | null };
export type Analytics = {
  days: number;
  route: string | null;
  since: number;
  until: number;
  routes: { id: string; name: string }[];
  total: number;
  empty: boolean;
  sample?: number;
  sample_limit: number;
  capped?: boolean;
  sample_since?: number | null;
  e2e_recorded_since?: number | null;
  timing_columns?: boolean;
  daily?: { day: string; total: number; failed: number; by: Record<string, number> }[];
  latency?: { e2e: Dist; upstream: Dist; overhead: Dist; handler: Dist };
  answerers?: { name: string; failed: boolean; requests: number; share: number | null; e2e: Dist; upstream: Dist; overhead: Dist; handler: Dist; call: Dist; agreement: { requests: number; questions: number; rate: number | null } | null }[];
  fallbacks?: { requests: number; of: number; rate: number | null; reasons: Record<string, number>; unsure_gate: { requests: number; rate: number | null } };
  confidence?: { n: number; buckets: number[] };
  errors?: { requests: number; rate: number | null; by_status: { status: number; requests: number; last_error: string | null }[] };
  cost?: { margin: number; daily: { day: string; kinds: Record<string, number> }[]; total_usd: number; traffic_usd: number; per_1000: number | null; traffic_kinds: string[] };
};
