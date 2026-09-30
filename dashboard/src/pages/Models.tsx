/* Models: every model trained on a route's requests, named "<route> v<N>", and the trainings running now. A model joins the
   upstream catalog and can answer on any route. "Train a model" picks a route, which of its requests, a base and whose
   labels, prices it from the server's estimate, and starts the run. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState, ErrorState } from "../components/Bits";
import { Drawer } from "../components/Drawer";
import { RequestDrawer, labelOf, readableState } from "../components/RequestList";
import { useToast } from "../components/Toast";
import { API, cachedRoutes, checkLabels, estimateModel, fetchBases, fetchFacets, fetchModels, fetchRoutes, getSetup, isMissing, makeBrowserCopy, trainModel } from "../lib/api";
import { ago, fmtT, money, num, pct1, plural } from "../lib/domain";
import { filterFromParams, filterToParams, filterWords, isEmptyFilter, namesFrom } from "../lib/filters";
import { useNarrow } from "../lib/project";
import { holdoutPct, nameList, useCatalog } from "../lib/upstreams";
import type { Base, Facets, LabelCheck, ModelEstimate, Req, ModelsPage, ReqFilter, RoutesPage, Selection, TrainBreakdown, TrainedModel, TrainingRun } from "../lib/types";

const POLL_MS = 10_000;
/** A browser copy takes a few minutes; one still not back after this is taken as lost, and can be made again. */
const COPY_LOST_S = 30 * 60;
const copyLost = (m: TrainedModel) => m.web_status === "preparing" && m.web_started != null && Date.now() / 1000 - m.web_started > COPY_LOST_S;

/** "In a browser" for one model: yes, being prepared, or why not, with the button that makes a new private copy when one is needed. */
function BrowserCopy({ m, onChange }: { m: TrainedModel; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      await makeBrowserCopy(m.route, m.version);
      toast.show(`Making a browser copy of ${m.name}. It takes a few minutes and shows here when it's ready.`);
      onChange();
    } catch (e) {
      toast.show((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const again = (label: string, title: string) => (
    <Button size="sm" variant="quiet" loading={busy} onClick={make} title={title} className="ml-1">
      {label}
    </Button>
  );
  // Tiny: no browser runtime; its folder runs offline (python serve.py)
  if (m.offline_status)
    return m.offline_status === "ready" && m.offline_url ? (
      <a className="text-accent hover:underline" href={m.offline_url} download title="A folder with the model and serve.py: pip install onnxruntime tokenizers numpy, then python serve.py">
        Download to run offline
      </a>
    ) : m.offline_status === "failed" ? <span className="text-stop">folder couldn't be made{m.web_error ? `: ${m.web_error}` : ""}</span> : <span className="text-wait">folder being made</span>;
  switch (m.web_status) {
    case "ready":
      return <span className="text-go">yes</span>;
    case "preparing":
      return copyLost(m) ? (
        <span className="text-wait">not ready after 30 minutes{again("Make it again", "Starts a new browser copy; takes a few minutes")}</span>
      ) : (
        <span className="text-wait" title="Made right after training, or after you asked for a new copy; takes a few minutes">being prepared</span>
      );
    case "failed":
      return (
        <span className="text-stop">
          couldn't be made{m.web_error ? `: ${m.web_error}` : ""}
          {again("Try again", "Starts a new browser copy; takes a few minutes")}
        </span>
      );
    case "needs_copy":
      return (
        <span className="text-wait" title="Its only browser copy was made before copies were private, so it isn't used. A new private copy takes a few minutes.">
          needs a new copy{again("Make a browser copy", "Makes a private browser copy that only you can load; takes a few minutes")}
        </span>
      );
    default:
      return <span className="text-slate">no, server only</span>;
  }
}

function agreement(m: Pick<TrainedModel, "holdout_agreement">) {
  const p = holdoutPct(m.holdout_agreement);
  const h = m.holdout_agreement && typeof m.holdout_agreement === "object" ? m.holdout_agreement : null;
  const n = h?.n ?? null;
  const answered = h?.answered ?? n;
  const missing = h?.missing_answers || [];
  // per question (from per_answer "qid=label": {n, agree}), weakest first, so a route with one hard question among easy ones shows it
  const perQ = new Map<string, { n: number; ok: number }>();
  for (const [k, v] of Object.entries((h as { per_answer?: Record<string, { n: number; agree: number }> } | null)?.per_answer || {})) {
    const q = k.slice(0, k.indexOf("=") < 0 ? k.length : k.indexOf("=")), c = perQ.get(q) || { n: 0, ok: 0 }; c.n += v.n; c.ok += Math.round(v.agree * v.n); perQ.set(q, c);
  }
  const weakest = [...perQ].map(([q, c]) => ({ q, ...c })).filter((w) => w.n >= 3).sort((a, b) => a.ok / a.n - b.ok / b.n).slice(0, 3);
  const title = [n != null ? `over ${plural(n, "held-out answer")}; one the model didn't give counts as a miss` : "", missing.length ? `none held out for: ${missing.join(", ")}` : ""].filter(Boolean).join(". ");
  return p == null ? <span className="text-slate">not measured</span> : (
    <span title={title || undefined}>
      <span className={p >= 0.9 ? "text-go" : p >= 0.75 ? "text-ink" : "text-wait"}>{pct1(p)}</span>
      {n != null && <span className="ml-1 text-2xs text-slate">{answered != null && answered !== n ? `${num(answered)} answered of ${num(n)}` : `of ${num(n)}`}</span>}
      {missing.length > 0 && <span className="ml-1 block text-2xs text-wait">none held out: {missing.slice(0, 4).join(", ")}{missing.length > 4 ? "…" : ""}</span>}
      {weakest.length > 1 && (
        <span className="block text-2xs text-slate" title="Held-out answers per question, weakest first: easy yes/no questions can carry the overall number">
          {weakest.map((w, i) => (
            <span key={w.q}>
              {i ? " · " : "by question: "}
              <span className={w.ok / w.n >= 0.9 ? "text-go" : w.ok / w.n >= 0.75 ? "text-ink" : "text-wait"}>{w.q} {num(w.ok)}/{num(w.n)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export default function Models() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState<ModelsPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [routes, setRoutes] = useState<RoutesPage | null>(cachedRoutes());
  const [bases, setBases] = useState<Base[] | null>(null);
  const narrow = useNarrow(900);
  const only = params.get("route");
  const training = params.get("train") === "1";

  const load = useCallback(async () => {
    try {
      setPage(await fetchModels());
      setErr(null);
    } catch (e) {
      if (isMissing(e)) setMissing(true);
      else setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
    fetchRoutes().then(setRoutes).catch(() => null);
    fetchBases().then(setBases).catch(() => setBases([]));
  }, [load]);
  // while something trains or a browser copy is being made, check every 10 s
  const busy = !!page?.training.length || !!page?.models.some((m) => m.web_status === "preparing" && !copyLost(m));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    return () => clearInterval(t);
  }, [busy, load]);

  const routeName = (id: string) => routes?.routes.find((r) => r.id === id)?.name || "a route";
  const baseName = (id: string) => bases?.find((b) => b.id === id)?.name || id;
  const models = (page?.models || []).filter((m) => !only || m.route === only);
  const runs = (page?.training || []).filter((t) => !only || t.route === only);
  const openTrain = () => {
    const p = new URLSearchParams(params);
    p.set("train", "1");
    setParams(p);
  };
  const closeTrain = () => {
    const p = new URLSearchParams();
    if (only) p.set("route", only);
    setParams(p);
  };

  return (
    <Page wide>
      <PageHeader
        title="Models"
        description="Models trained on your requests, named after their route. Each one joins the upstreams: it can answer on any route, in its setup or from Requests."
        action={
          <Button variant="primary" onClick={openTrain}>
            Train a model
          </Button>
        }
      />
      {only && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2.5 pr-1 text-xs text-ink">
            route {routeName(only)}
            <button type="button" aria-label="Show every route's models" className="grid h-4 w-4 place-items-center rounded-full text-slate hover:bg-panel hover:text-ink" onClick={() => setParams(new URLSearchParams())}>
              ×
            </button>
          </span>
        </p>
      )}

      {runs.length > 0 && (
        <section className="mt-4 space-y-2" aria-label="Training now">
          {runs.map((t, i) => (
            <Running key={i} t={t} name={routeName} base={baseName} />
          ))}
        </section>
      )}

      <div className="mt-4">
        {missing ? (
          <EmptyState title="Models aren't listed on this server yet." body="Each route's setup still shows its trained versions in the pickers." />
        ) : err && !page ? (
          <ErrorState title="Couldn't load your models." detail={err} onRetry={load} />
        ) : page && !models.length ? (
          <EmptyState
            title={only ? `No models trained on ${routeName(only)} yet.` : "No models yet."}
            body="Train one on a route's labelled requests: a few minutes on a GPU, priced before you start."
            action={<Button variant="primary" onClick={openTrain}>Train a model</Button>}
          />
        ) : narrow ? (
          <ul className="space-y-2">
            {!page
              ? [0, 1].map((i) => (
                  <li key={i} className="space-y-2 rounded-lg border border-line bg-surface p-3">
                    <span className="skel h-4 w-1/3" />
                    <span className="skel h-3 w-2/3" />
                  </li>
                ))
              : models.map((m) => (
                  <li key={m.id} className="rounded-lg border border-line bg-surface p-3 text-sm">
                    <p className="flex flex-wrap items-baseline justify-between gap-2">
                      <b className="text-base font-semibold text-ink">{m.name}</b>
                      <span className="font-mono">{agreement(m)}</span>
                    </p>
                    <p className="mt-0.5 text-slate">
                      {baseName(m.base)} · trained {ago(m.t)} on {m.trained_rows != null ? plural(m.trained_rows, "request") : "—"}
                    </p>
                    <p className="mt-0.5 text-slate">{m.cohort ? filterWords(m.cohort as ReqFilter, namesFrom(null, routes?.routes || null, null)) : "every labelled request"}</p>
                    <p className="mt-1 text-xs text-slate">
                      Answers on: {m.used_by.length ? m.used_by.map(routeName).join(", ") : "no route yet"} · In a browser: <BrowserCopy m={m} onChange={load} />
                      {m.download && (<> · <a className="text-accent hover:underline" href={API + m.download}>Download weights</a></>)}
                    </p>
                  </li>
                ))}
          </ul>
        ) : (
          <div className="scroll-x rounded-lg border border-line bg-surface">
            <table className="w-full border-collapse text-left" style={{ minWidth: 980 }}>
              <caption className="sr-only">Trained models</caption>
              <thead>
                <tr className="bg-panel text-xs text-slate">
                  {["Model", "Route", "Base", "Trained on", "Held-out agreement", "Answers on", "In a browser"].map((h) => (
                    <th key={h} scope="col" className="whitespace-nowrap border-b border-line px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!page
                  ? [0, 1, 2].map((i) => (
                      <tr key={i}>
                        {Array.from({ length: 7 }).map((_, j) => (
                          <td key={j} className="border-b border-line px-3 py-3">
                            <span className="skel h-3 w-3/4" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : models.map((m) => (
                      <tr key={m.id} className="align-top hover:bg-panel">
                        <td className="border-b border-line px-3 py-2.5">
                          <b className="font-medium text-ink">{m.name}</b> {m.latest && <Badge tone="go">latest</Badge>}
                          <span className="block text-2xs text-slate" title={fmtT(m.t)}>
                            trained {ago(m.t)}
                            {m.status !== "ready" && ` · ${m.status}`}
                          </span>
                          {m.error && <span className="block text-2xs text-stop">{m.error}</span>}
                        </td>
                        <td className="border-b border-line px-3 py-2.5 text-sm">
                          <Link to={`/routes/${encodeURIComponent(m.route)}`} className="text-accent hover:underline">
                            {m.route_name || routeName(m.route)}
                          </Link>
                        </td>
                        <td className="border-b border-line px-3 py-2.5 text-sm">{baseName(m.base)}</td>
                        <td className="border-b border-line px-3 py-2.5 text-sm">
                          <span className="font-mono">{m.trained_rows != null ? num(m.trained_rows) : "—"}</span> requests
                          <span className="block text-2xs text-slate">{m.cohort ? filterWords(m.cohort as ReqFilter, namesFrom(null, routes?.routes || null, null)) : "every labelled request on the route"}</span>
                        </td>
                        <td className="border-b border-line px-3 py-2.5 font-mono text-sm">{agreement(m)}</td>
                        <td className="border-b border-line px-3 py-2.5 text-sm">
                          {m.used_by.length ? (
                            m.used_by.map((r, i) => (
                              <span key={r}>
                                {i > 0 && ", "}
                                <Link to={`/routes/${encodeURIComponent(r)}`} className="hover:underline">
                                  {routeName(r)}
                                </Link>
                              </span>
                            ))
                          ) : (
                            <span className="text-slate">no route yet</span>
                          )}
                        </td>
                        <td className="border-b border-line px-3 py-2.5 text-sm">
                          <BrowserCopy m={m} onChange={load} />
                          {m.download && (<> · <a className="text-accent hover:underline" href={API + m.download}>Download weights</a></>)}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
        {page && models.length > 0 && <p className="mt-2 text-xs text-slate">Held-out agreement: how often the model gives the label on requests kept aside from its training.</p>}
      </div>

      <Drawer open={training} onClose={closeTrain} title="Train a model" subtitle="On one route's requests. Priced before it starts.">
        {training && (
          <TrainPanel
            routes={routes}
            bases={bases}
            models={page?.models || []}
            onStarted={() => {
              closeTrain();
              load();
            }}
          />
        )}
      </Drawer>
    </Page>
  );
}

function Running({ t, name, base }: { t: TrainingRun; name: (id: string) => string; base: (id: string) => string }) {
  return (
    <div className="rounded-lg border border-wait/40 bg-wait-soft px-3 py-2 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <b className="font-medium text-ink">Training {t.name || `${t.route_name || name(t.route)}${t.version ? ` v${t.version}` : ""}`}</b>
        <span className="text-slate">
          {t.base ? base(t.base) : ""}
          {t.requests ? ` · ${plural(t.requests, "request")}` : ""}
          {t.started ? ` · started ${ago(t.started)}` : ""}
          {t.status ? ` · ${t.status}` : ""}
        </span>
      </p>
      {t.progress != null && (
        <span className="mt-1.5 block h-1.5 overflow-hidden rounded bg-line">
          <span className="block h-full bg-wait" style={{ width: `${Math.round(Math.min(1, t.progress) * 100)}%` }} />
        </span>
      )}
      {t.log?.length ? <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-slate">{t.log.slice(-3).join("\n")}</pre> : <p className="mt-0.5 text-xs text-slate">Progress lines appear once the trainer starts.</p>}
    </div>
  );
}

/** Where every picked request goes, so the number on the button is the one the trainer gets. */
function Breakdown({ b, include, onInclude }: { b: TrainBreakdown; include: boolean; onInclude: (v: boolean) => void }) {
  const parts = [
    `${num(b.total)} picked`,
    b.left_out && !b.left_out_included ? `${num(b.left_out)} left out` : "",
    b.removed ? `${num(b.removed)} removed by you` : "",
    b.held_out ? `${num(b.held_out)} held out` : "",
    b.no_label ? `${num(b.no_label)} without a label yet` : "",
    b.balanced_away ? `${num(b.balanced_away)} thinned so one answer doesn't dominate` : "",
  ].filter(Boolean);
  return (
    <>
      <p className="mt-1 text-xs text-slate">
        {parts.join(" − ")} = <b className="font-mono font-medium text-ink">{num(b.trains)}</b> train
        {b.calibration ? ` (the trainer fits on ${num(b.trains - b.calibration)} and uses ${num(b.calibration)} to tune how sure it is)` : ""}.
      </p>
      {b.left_out > 0 && (
        <label className="mt-1 flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={include} onChange={(ev) => onInclude(ev.target.checked)} />
          <span className="text-ink">
            {num(b.left_out)} left out (didn't read like your requests) · include them
          </span>
        </label>
      )}
    </>
  );
}

/** "Check a few labels first": the labels most worth a look before paying for a training (least sure first, then one per
    kind and answer), each one click from the request's label editor. Guidance only: Train stays enabled. */
function CheckLabels({ route, sel, selKey, include, name }: { route: string; sel: Selection; selKey: string; include: boolean; name: (id: string) => string }) {
  const narrow = useNarrow(700);
  const [c, setC] = useState<{ v: LabelCheck | null; err: string | null; busy: boolean }>({ v: null, err: null, busy: true });
  const [open, setOpen] = useState<Req | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setC((x) => ({ ...x, busy: true, err: null }));
    const t = setTimeout(() => {
      checkLabels({ route, ...(include ? { include_left_out: true } : {}), ...sel }, ctrl.signal)
        .then((v) => setC({ v, err: null, busy: false }))
        .catch((e) => !ctrl.signal.aborted && setC({ v: null, err: isMissing(e) ? null : (e as Error).message, busy: false }));
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, selKey, include, tick]);
  const v = c.v;
  if (!v && !c.busy && !c.err) return null; // an older server without the check
  return (
    <section className="rounded-lg border border-line p-3" aria-labelledby="check-h">
      <h3 id="check-h" className="font-medium text-ink">
        Check a few labels first
      </h3>
      {c.err ? (
        <p className="mt-1 text-xs text-stop">Couldn't load them: {c.err}</p>
      ) : !v ? (
        <span className="skel mt-2 block h-16 w-full" />
      ) : (
        <>
          <p className="mt-0.5 text-xs text-slate">
            The model learns whatever the labels say. {num(v.below)} of {plural(v.labelled, "label")} in this pick {v.below === 1 ? "is" : "are"} less than {Math.round(v.below_at * 100)}% sure
            {v.fixed_by_person ? ` · ${num(v.fixed_by_person)} already picked by a person` : ""}. Training works either way.
          </p>
          {v.requests.length > 0 ? (
            <ul className="mt-2 divide-y divide-line rounded border border-line">
              {v.requests.map((r) => {
                const qs = Object.keys(r.questions || {}).filter((q) => labelOf(r, q).raw != null || labelOf(r, q).skip);
                return (
                  <li key={r.id} className="flex items-start gap-3 px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="clamp-2 break-words text-sm text-ink" title={readableState(r.state).slice(0, 400)}>
                        {readableState(r.state) || <span className="text-slate">empty state</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-slate">
                        {qs.slice(0, 3).map((q, i) => {
                          const l = labelOf(r, q);
                          return (
                            <span key={q}>
                              {i > 0 && " · "}
                              {qs.length > 1 ? `${q}: ` : ""}
                              <b className="font-medium text-ink">{l.skip ? "unsure" : l.raw}</b>
                              {l.by === "person" ? " (a person's pick)" : l.a?.p != null ? ` ${Math.round(l.a.p * 100)}%` : ""}
                            </span>
                          );
                        })}
                        {qs.length > 3 ? ` · ${qs.length - 3} more` : ""}
                        {r.labels_from ? ` · from ${name(r.labels_from)}` : ""}
                      </p>
                    </div>
                    <Button size="sm" variant="quiet" onClick={() => setOpen(r)} aria-label={`Fix the label of: ${readableState(r.state).slice(0, 60)}`}>
                      fix
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate">Nothing to check: no labels in this pick yet.</p>
          )}
        </>
      )}
      <RequestDrawer
        r={open}
        onClose={() => {
          setOpen(null);
          setTick((t) => t + 1);
        }}
        name={name}
        narrow={narrow}
        onPatched={(r) => {
          setOpen(r);
          setC((x) => (x.v ? { ...x, v: { ...x.v, requests: x.v.requests.map((y) => (y.id === r.id ? r : y)) } } : x));
        }}
      />
    </section>
  );
}

function TrainPanel({ routes, bases, models, onStarted }: { routes: RoutesPage | null; bases: Base[] | null; models: TrainedModel[]; onStarted: () => void }) {
  const [params] = useSearchParams();
  const toast = useToast();
  const { upstreams } = useCatalog();
  const fromUrl = useMemo(() => filterFromParams(params), [params]);
  const picked = useMemo(() => {
    if (params.get("ids") !== "picked") return null;
    try {
      return JSON.parse(sessionStorage.getItem("understudy_train_ids") || "null") as string[] | null;
    } catch {
      return null;
    }
  }, [params]);
  const [route, setRoute] = useState<string>(fromUrl.route?.[0] || params.get("route") || "");
  useEffect(() => {
    if (!route && routes?.routes.length) setRoute(routes.routes.find((r) => (r.requests_total || 0) > 0)?.id || routes.routes[0].id);
  }, [routes, route]);
  const [which, setWhich] = useState<"all" | "these">(picked?.length || !isEmptyFilter({ ...fromUrl, route: undefined }) ? "these" : "all");
  const [base, setBase] = useState(params.get("base") || "");
  const [baseList, setBaseList] = useState<Base[] | null>(bases);
  const [epochs, setEpochs] = useState(2);
  const [labels, setLabels] = useState("");
  const [inclLeftOut, setInclLeftOut] = useState(false);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [est, setEst] = useState<{ e: ModelEstimate | null; err: string | null; busy: boolean }>({ e: null, err: null, busy: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // bases: the catalog's list; on an older server, the route's setup lists them
  useEffect(() => {
    if (bases === null) return; // still loading
    if (bases.length) return setBaseList(bases);
    if (!route) return;
    let live = true;
    getSetup(route)
      .then((s) => live && setBaseList(s.bases.map((b) => ({ id: b.id, name: b.name }))))
      .catch(() => live && setBaseList([]));
    return () => {
      live = false;
    };
  }, [bases, route]);
  useEffect(() => {
    if (!base && baseList?.length) setBase((baseList.find((b) => b.ready !== false) || baseList[0]).id);
  }, [baseList, base]);
  useEffect(() => {
    if (!route) return;
    fetchFacets({ route: [route] }).then(setFacets).catch(() => setFacets(null));
  }, [route]);

  const filter: ReqFilter = which === "all" ? { route: [route] } : { ...fromUrl, route: [route] };
  const sel: Selection = which === "these" && picked?.length ? { ids: picked } : { filter };
  const selKey = JSON.stringify(sel);
  useEffect(() => {
    if (!route || !base) return;
    const ctrl = new AbortController();
    setEst({ e: null, err: null, busy: true });
    const t = setTimeout(() => {
      estimateModel({ route, base, epochs, ...(labels ? { labels_from: labels } : {}), ...(inclLeftOut ? { include_left_out: true } : {}), ...sel }, ctrl.signal)
        .then((e) => setEst({ e, err: null, busy: false }))
        .catch((e) => !ctrl.signal.aborted && setEst({ e: null, err: isMissing(e) ? "Estimating a training isn't available on this server yet." : (e as Error).message, busy: false }));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, base, epochs, selKey, labels, inclLeftOut]);

  const r = routes?.routes.find((x) => x.id === route);
  const next = Math.max(0, ...models.filter((m) => m.route === route).map((m) => m.version)) + 1;
  const nextName = r ? `${r.name} v${next}` : `v${next}`;
  const b = baseList?.find((x) => x.id === base);
  const names = namesFrom(facets, routes?.routes || null, nameList(upstreams));
  const labelKeys = Object.keys(facets?.answered_by || {});
  const e = est.e;
  const blocked = b && b.ready === false ? b.why_not || "this base can't be trained right now" : e && e.ready === false ? e.why_not || "can't train this right now" : null;
  const otherRoutes = which === "these" && (fromUrl.route || []).some((x) => x !== route);

  return (
    <div className="space-y-4 text-sm">
      <label className="block">
        <span className="font-medium text-ink">Route</span>
        <select className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm" value={route} onChange={(ev) => setRoute(ev.target.value)}>
          {!routes && <option value="">Loading…</option>}
          {(routes?.routes || []).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · {plural(x.requests_total || 0, "request")}
            </option>
          ))}
        </select>
        <span className="mt-0.5 block text-xs text-slate">The model is named after it: {nextName}.</span>
      </label>

      <fieldset>
        <legend className="font-medium text-ink">Which requests</legend>
        <label className="mt-1 flex items-start gap-2">
          <input type="radio" className="mt-1 accent-[var(--accent)]" checked={which === "all"} onChange={() => setWhich("all")} />
          <span>Every labelled request on {r?.name || "the route"}</span>
        </label>
        <label className="mt-1 flex items-start gap-2">
          <input type="radio" className="mt-1 accent-[var(--accent)]" checked={which === "these"} onChange={() => setWhich("these")} disabled={!picked?.length && isEmptyFilter({ ...fromUrl, route: undefined })} />
          <span>
            {picked?.length ? `The ${plural(picked.length, "request")} picked on Requests` : isEmptyFilter({ ...fromUrl, route: undefined }) ? "Only some: pick them on Requests, then “Train a model on these”" : `Only ${filterWords({ ...fromUrl, route: undefined }, names).replace(/^requests: /, "")}`}
            <Link to={`/requests?${filterToParams(filter).toString()}`} className="ml-2 text-accent hover:underline">
              See them
            </Link>
          </span>
        </label>
        {otherRoutes && <p className="mt-1 text-xs text-wait">Only {r?.name}'s requests train it; requests from other routes in that filter are left out.</p>}
      </fieldset>

      <label className="block">
        <span className="font-medium text-ink">Base</span>
        <select className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm" value={base} onChange={(ev) => setBase(ev.target.value)}>
          {!baseList && <option value="">Loading…</option>}
          {(baseList || []).map((x) => (
            <option key={x.id} value={x.id} disabled={x.ready === false}>
              {x.name}
              {x.runs_in_browser ? " · also runs in a browser" : ""}
              {x.ready === false ? ` · ${x.why_not || "not available"}` : ""}
            </option>
          ))}
        </select>
      </label>

      {base === "tiny" ? (
        <p className="text-sm text-slate"><span className="font-medium text-ink">Epochs</span> picked by the trainer from how many requests there are (30 below 300).</p>
      ) : (
      <label className="flex items-center gap-2">
        <span className="font-medium text-ink">Epochs</span>
        <select className="rounded border border-line bg-surface px-2 py-1 font-mono text-sm" value={epochs} onChange={(ev) => setEpochs(Number(ev.target.value))}>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate">passes over the requests</span>
      </label>
      )}

      <label className="block">
        <span className="font-medium text-ink">Labels from</span>
        <select className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 text-sm" value={labels} onChange={(ev) => setLabels(ev.target.value)}>
          <option value="">Each request's labels (the route's “who is right”, a person's fixes first)</option>
          {labelKeys.map((k) => (
            <option key={k} value={k}>
              {names.upstream(k)}'s answers · {num(facets!.answered_by[k])} answered
            </option>
          ))}
        </select>
      </label>

      <div className="rounded-lg border border-line bg-paper p-3" aria-live="polite">
        {est.busy ? (
          <span className="skel h-4 w-2/3" />
        ) : est.err ? (
          <p className="text-stop">{est.err}</p>
        ) : e ? (
          <>
            <p className="text-ink">
              <b className="font-mono font-medium">{num(e.requests)}</b> requests{e.holdout ? <> · {num(e.holdout)} kept aside to measure it</> : null} · ~
              <b className="font-mono font-medium">{Math.max(1, Math.round(e.minutes))}</b> min · <b className="font-mono font-medium">{money(e.cost)}</b>
            </p>
            <p className="mt-0.5 text-xs text-slate">
              {e.gpu === "CPU" ? "On this machine's CPU. " : e.gpu ? `On an ${e.gpu} GPU. ` : ""}
              {e.estimate ? <span className="text-wait">Time and price are a guess ({e.estimate}).</span> : "From the time past trainings took."}
            </p>
            {e.breakdown && <Breakdown b={e.breakdown} include={inclLeftOut} onInclude={setInclLeftOut} />}
            {!e.requests && <p className="mt-1 text-wait">No labelled requests match, so there is nothing to train on.</p>}
          </>
        ) : (
          <p className="text-slate">Pick a route and a base to see the price.</p>
        )}
        {blocked && <p className="mt-1 text-wait">{blocked}</p>}
      </div>

      {route && <CheckLabels key={route} route={route} sel={sel} selKey={selKey} include={inclLeftOut} name={names.upstream} />}

      {err && <ErrorState title="Couldn't start the training." detail={err} />}
      <Button
        variant="primary"
        loading={busy}
        disabled={!e || !e.requests || !!blocked || est.busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const res = await trainModel({ route, base, epochs, ...(labels ? { labels_from: labels } : {}), ...(inclLeftOut ? { include_left_out: true } : {}), ...sel });
            toast.show(`Training ${r?.name || ""} v${res.version}. It shows here with its progress.`);
            onStarted();
          } catch (ex) {
            setErr((ex as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {e ? `Train ${nextName} on ${plural(e.requests, "request")} · ${money(e.cost)}` : `Train ${nextName}`}
      </Button>
      <p className="text-xs text-slate">{e?.gpu === "CPU" ? "Runs on this machine's CPU with the local trainer; nothing is billed. It can't be cancelled from here once started." : "Runs on a rented GPU and is billed by the minute; the price above is what it should cost. It can't be cancelled from here once started."}</p>
    </div>
  );
}
