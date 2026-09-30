/* Requests: the pool across every route. Filter (the filter lives in the URL, so a view can be shared), look, then act on
   the requests in batch: ask any upstream, use one upstream's answers as the labels, compare two upstreams, train a model,
   export, remove. Every list in the filter bar comes from GET /api/requests/facets and the upstream catalog. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { Button, LinkButton, QuietLink } from "../components/Button";
import { EmptyState, ErrorState } from "../components/Bits";
import { Drawer } from "../components/Drawer";
import { AddRequests } from "../components/AddRequests";
import type { AddTab } from "../components/AddRequests";
import { ProgressTrack } from "../components/ProgressTrack";
import { exportLine, RequestDrawer, RequestList } from "../components/RequestList";
import { useToast } from "../components/Toast";
import { ConnectFirst } from "../components/ConnectFirst";
import { UpstreamPicker } from "../components/UpstreamPicker";
import {
  askUpstream,
  cachedRoutes,
  estimateAsk,
  exportUrl,
  fetchFacets,
  fetchRequests,
  fetchRoutes,
  isMissing,
  removeRequests,
  pinLabels,
} from "../lib/api";
import { dayOf, daySecs, fmtMs, num, plural, SOURCES, usd } from "../lib/domain";
import { filterChips, filterFromParams, filterToParams, isEmptyFilter, namesFrom, withoutChip } from "../lib/filters";
import { useNarrow } from "../lib/project";
import { answersKey, keyText, nameList, useCatalog } from "../lib/upstreams";
import type { AskEstimate, Facets, Req, ReqFilter, RoutesPage, Selection, Upstream } from "../lib/types";

const PAGE = 50;
const ASK_CHUNK = 25;

type Action = "ask" | "labels" | "compare" | null;

export default function Requests() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  const fkey = filterToParams(filter).toString();
  const cmpParam = params.get("compare");
  const compare = cmpParam && cmpParam.split(",").length === 2 ? (cmpParam.split(",") as [string, string]) : null;
  const nav = useNavigate();
  const toast = useToast();
  const narrow = useNarrow(900);

  const { upstreams, missing: catMissing, reload: reloadCatalog } = useCatalog();
  const [routes, setRoutes] = useState<RoutesPage | null>(cachedRoutes());
  useEffect(() => {
    fetchRoutes().then(setRoutes).catch(() => null);
  }, []);

  const [facets, setFacets] = useState<Facets | null>(null);
  const [rows, setRows] = useState<Req[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [more, setMore] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Req | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [adding, setAdding] = useState(false);
  const [addTab, setAddTab] = useState<AddTab>("paste");
  const [addRoute, setAddRoute] = useState<string>("");
  const busyRef = useRef(false);

  const names = useMemo(() => {
    const list = [...nameList(upstreams)];
    return namesFrom(facets, routes?.routes || Object.entries((facets as Facets & { route_names?: Record<string, string> })?.route_names || {}).map(([id, name]) => ({ id, name })), list);
  }, [facets, routes, upstreams]);
  const name = names.upstream;

  const load = useCallback(() => {
    setErr(null);
    setRows(null);
    setTotal(null);
    setMissing(false);
    const ctrl = new AbortController();
    fetchRequests(filter, 0, PAGE, ctrl.signal)
      .then((p) => {
        setRows(p.requests);
        setTotal(p.total);
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        if (isMissing(e)) setMissing(true);
        else setErr((e as Error).message);
      });
    fetchFacets(filter, ctrl.signal)
      .then(setFacets)
      .catch(() => !ctrl.signal.aborted && setFacets(null));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fkey]);

  useEffect(() => {
    setSel(new Set());
    setAllMatching(false);
    return load();
  }, [load]);

  /** Re-read what's on screen (after a batch action), keeping the scroll. */
  const refresh = useCallback(async () => {
    const n = Math.max(PAGE, rows?.length || 0);
    try {
      const [p, f] = await Promise.all([fetchRequests(filter, 0, n), fetchFacets(filter).catch(() => null)]);
      setRows(p.requests);
      // picked rows that no longer match (e.g. "missing an answer from X" after asking X) are unpicked
      const still = new Set(p.requests.map((r) => r.id));
      setSel((s) => (s.size && [...s].some((id) => !still.has(id)) ? new Set([...s].filter((id) => still.has(id))) : s));
      setTotal(p.total);
      if (f) setFacets(f);
    } catch {
      /* the next poll or a reload shows it */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fkey, rows?.length]);

  // new requests arrive at the top while the page is open
  useEffect(() => {
    if (!rows || missing) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      try {
        const p = await fetchRequests(filter, 0, 20);
        setRows((cur) => {
          if (!cur) return cur;
          const have = new Set(cur.map((r) => r.id));
          const add = p.requests.filter((r) => !have.has(r.id));
          if (!add.length) return cur.map((r) => p.requests.find((x) => x.id === r.id) || r);
          setFresh(new Set(add.map((r) => r.id)));
          return [...add, ...cur.map((r) => p.requests.find((x) => x.id === r.id) || r)];
        });
        setTotal(p.total);
      } catch {
        /* quiet */
      }
    }, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fkey, !!rows, missing]);

  async function loadMore() {
    if (!rows) return;
    setMore(true);
    try {
      const p = await fetchRequests(filter, rows.length, PAGE);
      setRows((cur) => {
        const have = new Set((cur || []).map((r) => r.id));
        return [...(cur || []), ...p.requests.filter((r) => !have.has(r.id))];
      });
      setTotal(p.total);
    } catch (e) {
      toast.show((e as Error).message, "error");
    } finally {
      setMore(false);
    }
  }

  const setFilter = (next: ReqFilter, extra?: Record<string, string | null>) => {
    const p = filterToParams(next, params);
    for (const [k, v] of Object.entries(extra || {})) {
      if (v == null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p);
  };

  const selection: Selection | null = allMatching ? { filter } : sel.size ? { ids: [...sel] } : null;
  const selCount = allMatching ? total ?? 0 : sel.size;
  const allOnPage = !!rows?.length && rows.every((r) => sel.has(r.id));
  const toggle = (id: string) => {
    setAllMatching(false);
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const toggleAll = () => {
    setAllMatching(false);
    setSel(allOnPage ? new Set() : new Set((rows || []).map((r) => r.id)));
  };
  const clearSel = () => {
    setSel(new Set());
    setAllMatching(false);
  };

  function exportSelection() {
    if (!selection || "filter" in selection) {
      window.open(exportUrl(filter), "_blank", "noopener");
      return;
    }
    const lines = (rows || []).filter((r) => sel.has(r.id)).map(exportLine).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines], { type: "application/x-ndjson" }));
    a.download = `requests-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function trainOnThese() {
    if (!selection) return;
    if ("ids" in selection) {
      try {
        sessionStorage.setItem("understudy_train_ids", JSON.stringify(selection.ids));
      } catch {
        /* private mode: fall back to the filter */
      }
      nav("/models?train=1&ids=picked" + (filter.route?.length === 1 ? `&route=${encodeURIComponent(filter.route[0])}` : ""));
    } else nav("/models?train=1&" + filterToParams(filter).toString());
  }

  const answeredKeys = Object.keys(facets?.answered_by || {});
  const empty =
    !isEmptyFilter(filter) ? (
      <span>
        Nothing matches these filters.{" "}
        <QuietLink tone="accent" onClick={() => setFilter({}, { compare: null })}>
          Clear them
        </QuietLink>
      </span>
    ) : (
      <span>
        No requests yet. Point an app at a route, or{" "}
        <Link to="/routes" className="text-accent hover:underline">
          try one on a route
        </Link>
        .
      </span>
    );

  return (
    <Page wide>
      <PageHeader
        title="Requests"
        description="Every request on every route, newest first. Filter them, open one to see every answer, or pick some and act on them together."
        action={
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={!routes?.routes.length}
              title={routes?.routes.length ? undefined : "Make a route first"}
              onClick={() => {
                setAddRoute((filter.route?.length === 1 ? filter.route[0] : "") || addRoute || routes?.routes[0]?.id || "");
                setAdding(true);
              }}
            >
              Add requests
            </Button>
            <Button size="sm" onClick={() => window.open(exportUrl(filter), "_blank", "noopener")} disabled={missing}>
              Export {isEmptyFilter(filter) ? "all" : "these"} as JSONL
            </Button>
          </>
        }
      />
      <Drawer
        open={adding}
        onClose={() => setAdding(false)}
        wide
        title="Add requests"
        subtitle={
          (routes?.routes.length || 0) > 1 ? (
            <label className="flex flex-wrap items-center gap-2 text-sm">
              To route
              <select className="rounded border border-line bg-surface px-2 py-1 text-sm" value={addRoute} onChange={(e) => setAddRoute(e.target.value)}>
                {routes!.routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            routes?.routes[0] && <span>To route {routes.routes[0].name}</span>
          )
        }
      >
        {adding && addRoute && <AddRequests routeId={addRoute} tab={addTab} onTab={setAddTab} onAdded={load} />}
      </Drawer>

      {total === 0 && isEmptyFilter(filter) && (
        <ConnectFirst
          routes={routes}
          routeId={routes?.routes[0]?.id ?? null}
          reload={async () => { setRoutes(await fetchRoutes()); }}
        />
      )}

      <FilterBar filter={filter} facets={facets} routes={routes} upstreams={upstreams} names={names} setFilter={(f) => setFilter(f)} />

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        <span className="font-medium text-ink" aria-live="polite">
          {total == null ? <span className="skel inline-block h-3.5 w-24 align-middle" /> : `${plural(total, "request")} ${isEmptyFilter(filter) ? "in all" : "match"}`}
        </span>
        {filterChips(filter, names).map((c) => (
          <span key={c.key + (c.value || "")} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2.5 pr-1 text-xs text-ink">
            {c.text}
            <button type="button" aria-label={`Remove filter: ${c.text}`} className="grid h-4 w-4 place-items-center rounded-full text-slate hover:bg-panel hover:text-ink" onClick={() => setFilter(withoutChip(filter, c.key, c.value))}>
              ×
            </button>
          </span>
        ))}
        {compare && (
          <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs text-ink">
            comparing {name(compare[0])} with {name(compare[1])}
            <button type="button" aria-label="Stop comparing" className="grid h-4 w-4 place-items-center rounded-full text-slate hover:text-ink" onClick={() => setFilter(filter, { compare: null })}>
              ×
            </button>
          </span>
        )}
        {!isEmptyFilter(filter) && (
          <QuietLink onClick={() => setFilter({}, { compare: null })} className="text-xs">
            Clear all
          </QuietLink>
        )}
      </div>

      <div className="mt-3">
        {missing ? (
          <EmptyState title="The request pool isn't on this server yet." body="Each route's page still lists its latest requests." action={<LinkButton to="/routes">Your routes</LinkButton>} />
        ) : err ? (
          <ErrorState title="Couldn't load requests." detail={err} onRetry={load} />
        ) : (
          <>
            {allOnPage && !allMatching && total != null && total > (rows?.length || 0) && (
              <p className="mb-2 rounded border border-accent/40 bg-accent-soft px-3 py-1.5 text-sm text-ink">
                All {num(rows!.length)} shown are picked.{" "}
                <QuietLink tone="accent" onClick={() => setAllMatching(true)}>
                  Pick all {num(total)} matching this filter
                </QuietLink>
              </p>
            )}
            {allMatching && (
              <p className="mb-2 rounded border border-accent/40 bg-accent-soft px-3 py-1.5 text-sm text-ink">
                All {num(total || 0)} requests matching this filter are picked, including ones not shown.{" "}
                <QuietLink onClick={clearSel}>Clear</QuietLink>
              </p>
            )}
            <RequestList
              rows={rows || []}
              loading={rows ? undefined : 8}
              empty={empty}
              name={name}
              onOpen={setOpen}
              compare={compare}
              selected={allMatching ? new Set((rows || []).map((r) => r.id)) : sel}
              onToggle={toggle}
              onToggleAll={toggleAll}
              allOnPage={allMatching || allOnPage}
              fresh={fresh}
              narrow={narrow}
            />
            {rows && total != null && rows.length < total && (
              <div className="mt-3 flex items-center gap-3">
                <Button loading={more} onClick={loadMore}>
                  Show {Math.min(PAGE, total - rows.length)} more
                </Button>
                <span className="text-sm text-slate">
                  {num(rows.length)} of {num(total)} shown
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {selection && (
        <BatchBar
          count={selCount}
          allMatching={allMatching}
          onClear={clearSel}
          onAsk={() => setAction("ask")}
          onLabels={() => setAction("labels")}
          onCompare={() => setAction("compare")}
          onTrain={trainOnThese}
          onExport={exportSelection}
          selection={selection}
          filter={filter}
          onRemoved={(n) => {
            toast.show(`Removed ${plural(n, "request")}.`);
            clearSel();
            refresh();
          }}
        />
      )}

      <RequestDrawer
        r={open}
        onClose={() => setOpen(null)}
        name={name}
        narrow={narrow}
        onPatched={(r) => {
          setOpen(r);
          setRows((xs) => (xs || []).map((x) => (x.id === r.id ? r : x)));
        }}
        onStep={async (d) => {
          // the next request in this list (loading the next page when it runs out), or the previous one
          if (!open || !rows) return;
          const i = rows.findIndex((x) => x.id === open.id);
          if (d === -1) { if (i > 0) setOpen(rows[i - 1]); return; }
          if (i >= 0 && i + 1 < rows.length) { setOpen(rows[i + 1]); return; }
          if ((total ?? 0) > rows.length) {
            const p = await fetchRequests(filter, rows.length, PAGE).catch(() => null);
            if (p && p.requests.length) { setRows([...rows, ...p.requests]); setTotal(p.total); setOpen(p.requests[0]); return; }
          }
          toast.show("That was the last request in this list.");
        }}
      />

      <Drawer open={action === "ask"} onClose={() => !busyRef.current && setAction(null)} title="Ask an upstream" subtitle={selection ? `${plural(selCount, "request")} picked` : undefined}>
        {action === "ask" && selection && (
          <AskPanel
            selection={selection}
            filter={filter}
            rows={rows || []}
            upstreams={upstreams}
            catMissing={catMissing}
            reloadCatalog={reloadCatalog}
            busyRef={busyRef}
            onProgress={refresh}
            onDone={(msg) => {
              toast.show(msg);
              refresh();
            }}
          />
        )}
      </Drawer>

      <Drawer open={action === "labels"} onClose={() => setAction(null)} title="Use one upstream's answers as the labels" subtitle={selection ? `${plural(selCount, "request")} picked` : undefined}>
        {action === "labels" && selection && (
          <LabelsPanel
            selection={selection}
            keys={answeredKeys}
            name={name}
            onDone={(msg) => {
              toast.show(msg);
              setAction(null);
              refresh();
            }}
          />
        )}
      </Drawer>

      <Drawer open={action === "compare"} onClose={() => setAction(null)} title="Compare two upstreams" subtitle="Two answer columns side by side, differences in red, and only the requests where they disagree.">
        {action === "compare" && (
          <ComparePanel
            keys={[...new Set([...answeredKeys, ...(upstreams || []).map(answersKey)])]}
            counts={facets?.answered_by || {}}
            name={name}
            initial={compare || [filter.answered_by || answeredKeys.sort((a, b) => (facets!.answered_by[b] || 0) - (facets!.answered_by[a] || 0))[0] || "jev", ""]}
            onApply={(a, b) => {
              setFilter({ ...filter, disagree: `${a},${b}` }, { compare: `${a},${b}` });
              setAction(null);
            }}
          />
        )}
      </Drawer>
    </Page>
  );
}

/* ---------- the filter bar ---------- */

const selCls = "min-w-0 max-w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink";

function Pick({ label, value, onChange, options, any = "any", className = "" }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; any?: string; className?: string }) {
  const has = !value || options.some((o) => o.value === value);
  return (
    <label className={`flex min-w-0 flex-col gap-0.5 text-xs text-slate ${className}`}>
      {label}
      <select className={selCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{any}</option>
        {!has && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterBar({
  filter,
  facets,
  routes,
  upstreams,
  names,
  setFilter,
}: {
  filter: ReqFilter;
  facets: Facets | null;
  routes: RoutesPage | null;
  upstreams: Upstream[] | null;
  names: ReturnType<typeof namesFrom>;
  setFilter: (f: ReqFilter) => void;
}) {
  const [q, setQ] = useState(filter.q || "");
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setQ(filter.q || ""), [filter.q]);
  // search as you type, after a pause
  useEffect(() => {
    if ((filter.q || "") === q.trim()) return;
    const t = setTimeout(() => setFilter({ ...filter, q: q.trim() || undefined }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const set = (k: keyof ReqFilter, v: string) => setFilter({ ...filter, [k]: v || undefined });
  const count = (n?: number) => (n == null ? "" : ` · ${num(n)}`);
  const routeIds = [...new Set([...Object.keys(facets?.routes || {}), ...(routes?.routes || []).map((r) => r.id)])];
  const routeOpts = routeIds.map((id) => ({ value: id, label: `${names.route(id)}${count(facets?.routes?.[id])}` }));
  const kindOpts = Object.entries(facets?.kinds || {}).sort((a, b) => b[1].n - a[1].n).map(([id, k]) => ({ value: id, label: `${k.name}${count(k.n)}` }));
  const sourceOpts = SOURCES.filter((s) => facets?.sources?.[s.key] || filter.source === s.key).map((s) => ({ value: s.key, label: `${s.label}${count(facets?.sources?.[s.key])}` }));
  const answered = Object.entries(facets?.answered_by || {}).sort((a, b) => b[1] - a[1]);
  const answeredOpts = answered.map(([id, n]) => ({ value: id, label: `${names.upstream(id)}${count(n)}` }));
  const everyKey = [...new Set([...answered.map(([k]) => k), ...(upstreams || []).map(answersKey)])];
  const missingOpts = everyKey.map((id) => ({ value: id, label: names.upstream(id) }));
  const labelsOpts = Object.entries(facets?.labels_from || {}).map(([id, n]) => ({ value: id, label: `${names.upstream(id)}${count(n)}` }));
  const scope = filter.route?.length ? (routes?.routes || []).filter((r) => filter.route!.includes(r.id)) : routes?.routes || [];
  const keyOpts = facets?.keys
    ? Object.entries(facets.keys).map(([k, n]) => ({ value: k, label: `${k}…${count(n)}` }))
    : [...new Set(scope.flatMap((r) => r.keys.map((k) => k.prefix)))].map((k) => ({ value: k, label: `${k}…` }));
  const [da, db] = (filter.disagree || ",").split(",");
  const moreActive = ["source", "key", "missing", "labelled", "labels_from", "disagree", "maxp", "since", "until", "holdout", "left_out"].filter((k) => filter[k as keyof ReqFilter]).length;

  return (
    <div className="mt-4 rounded-lg border border-line bg-surface p-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end">
        <label className="flex min-w-0 flex-col gap-0.5 text-xs text-slate">
          Search
          <input className={selCls} type="search" placeholder="text in the request" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Pick
          className={moreOpen ? "" : "max-sm:hidden"}
          label="Route"
          value={filter.route?.length === 1 ? filter.route[0] : filter.route?.length ? "__many" : ""}
          onChange={(v) => setFilter({ ...filter, route: v && v !== "__many" ? [v] : undefined })}
          options={[...(filter.route && filter.route.length > 1 ? [{ value: "__many", label: `${filter.route.length} routes` }] : []), ...routeOpts]}
          any="every route"
        />
        <Pick className={moreOpen ? "" : "max-sm:hidden"} label="Kind of request" value={filter.kind || ""} onChange={(v) => set("kind", v)} options={kindOpts} any="every kind" />
        <Pick className={moreOpen ? "" : "max-sm:hidden"} label="Answered by" value={filter.answered_by || ""} onChange={(v) => set("answered_by", v)} options={answeredOpts} any="anyone" />
        <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)} className="h-[30px] self-end whitespace-nowrap rounded border border-line px-2.5 text-sm text-ink hover:bg-panel">
          {moreOpen ? "Fewer filters" : (
            <>
              <span className="sm:hidden">Filters{moreActive + (filter.route?.length ? 1 : 0) + (filter.kind ? 1 : 0) + (filter.answered_by ? 1 : 0) ? ` (${moreActive + (filter.route?.length ? 1 : 0) + (filter.kind ? 1 : 0) + (filter.answered_by ? 1 : 0)})` : ""}</span>
              <span className="max-sm:hidden">More filters{moreActive ? ` (${moreActive})` : ""}</span>
            </>
          )}
        </button>
      </div>
      {moreOpen && (
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4">
          <Pick label="Came from" value={filter.source || ""} onChange={(v) => set("source", v)} options={sourceOpts} any="anywhere" />
          <Pick label="Key" value={filter.key || ""} onChange={(v) => set("key", v)} options={keyOpts} any="any key" />
          <Pick label="Missing an answer from" value={filter.missing || ""} onChange={(v) => set("missing", v)} options={missingOpts} any="—" />
          <Pick
            label="Labelled"
            value={filter.labelled || ""}
            onChange={(v) => set("labelled", v)}
            options={[
              { value: "1", label: "labelled" },
              { value: "0", label: "not labelled" },
            ]}
          />
          <Pick label="Labels from" value={filter.labels_from || ""} onChange={(v) => set("labels_from", v)} options={labelsOpts} any="anyone" />
          <div className="flex min-w-0 flex-col gap-0.5 text-xs text-slate">
            Two upstreams disagree
            <span className="flex min-w-0 items-center gap-1">
              <select aria-label="First upstream" className={`${selCls} flex-1`} value={da || ""} onChange={(e) => setFilter({ ...filter, disagree: e.target.value && db ? `${e.target.value},${db}` : e.target.value ? `${e.target.value},` : undefined })}>
                <option value="">—</option>
                {everyKey.map((k) => (
                  <option key={k} value={k}>
                    {names.upstream(k)}
                  </option>
                ))}
              </select>
              <span>vs</span>
              <select aria-label="Second upstream" className={`${selCls} flex-1`} value={db || ""} onChange={(e) => setFilter({ ...filter, disagree: da && e.target.value ? `${da},${e.target.value}` : da ? `${da},` : undefined })}>
                <option value="">—</option>
                {everyKey.filter((k) => k !== da).map((k) => (
                  <option key={k} value={k}>
                    {names.upstream(k)}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <label className="flex min-w-0 flex-col gap-0.5 text-xs text-slate">
            Least sure answer at most
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={100}
                placeholder="—"
                className={`${selCls} w-20 font-mono`}
                value={filter.maxp ? Math.round(Number(filter.maxp) * 100) : ""}
                onChange={(e) => set("maxp", e.target.value ? String(Math.min(100, Math.max(1, Number(e.target.value))) / 100) : "")}
              />
              %
            </span>
          </label>
          <div className="flex min-w-0 flex-col gap-0.5 text-xs text-slate">
            Dates
            <span className="flex min-w-0 items-center gap-1">
              <input type="date" aria-label="From" className={`${selCls} min-w-0 flex-1`} value={dayOf(filter.since)} onChange={(e) => set("since", String(daySecs(e.target.value) ?? ""))} />
              <span>–</span>
              <input type="date" aria-label="To" className={`${selCls} min-w-0 flex-1`} value={dayOf(filter.until)} onChange={(e) => set("until", String(daySecs(e.target.value, true) ?? ""))} />
            </span>
          </div>
          <Pick
            label="Held out (never trained on)"
            value={filter.holdout || ""}
            onChange={(v) => set("holdout", v)}
            options={[
              { value: "1", label: "only held out" },
              { value: "0", label: "not held out" },
            ]}
          />
          <Pick
            label={`Left out of training${facets?.left_out ? ` (${facets.left_out})` : ""}`}
            value={filter.left_out || ""}
            onChange={(v) => set("left_out", v)}
            options={[
              { value: "1", label: "only left out" },
              { value: "0", label: "not left out" },
            ]}
          />
        </div>
      )}
      {facets === null && <p className="mt-2 text-xs text-slate">Counts for the filter lists are loading or unavailable; the lists fill in when they arrive.</p>}
    </div>
  );
}

/* ---------- the batch bar ---------- */

function BatchBar({
  count,
  allMatching,
  onClear,
  onAsk,
  onLabels,
  onCompare,
  onTrain,
  onExport,
  selection,
  filter,
  onRemoved,
}: {
  count: number;
  allMatching: boolean;
  onClear: () => void;
  onAsk: () => void;
  onLabels: () => void;
  onCompare: () => void;
  onTrain: () => void;
  onExport: () => void;
  selection: Selection;
  filter: ReqFilter;
  onRemoved: (n: number) => void;
}) {
  const [sure, setSure] = useState(false);
  const [removing, setRemoving] = useState<{ done: number; of: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function remove() {
    setErr(null);
    try {
      let ids: string[];
      if ("ids" in selection) ids = selection.ids;
      else {
        // every id matching the filter, page by page
        ids = [];
        for (let off = 0; ; off += 200) {
          const p = await fetchRequests(filter, off, 200);
          ids.push(...p.requests.map((r) => r.id));
          if (p.requests.length < 200 || ids.length >= p.total) break;
        }
      }
      let done = 0;
      setRemoving({ done, of: ids.length });
      for (let i = 0; i < ids.length; i += 100) {
        const r = await removeRequests(ids.slice(i, i + 100));
        done += r.removed;
        setRemoving({ done, of: ids.length });
      }
      setSure(false);
      setRemoving(null);
      onRemoved(done);
    } catch (e) {
      setErr((e as Error).message);
      setRemoving(null);
    }
  }
  return (
    <div className="sticky bottom-0 z-30 -mx-4 mt-4 border-t border-line bg-surface px-4 py-2.5 shadow-[0_-6px_20px_rgb(0_0_0/0.06)] nav:-mx-6 nav:px-6" role="region" aria-label="Act on the picked requests">
      <div className="flex flex-wrap items-center gap-2">
        <b className="mr-1 text-sm font-medium text-ink">
          {allMatching ? `All ${num(count)} matching` : `${num(count)} picked`}
        </b>
        <Button size="sm" variant="primary" onClick={onAsk}>
          Ask an upstream…
        </Button>
        <Button size="sm" onClick={onLabels}>
          Use answers as labels…
        </Button>
        <Button size="sm" onClick={onCompare}>
          Compare…
        </Button>
        <Button size="sm" onClick={onTrain}>
          Train a model on these
        </Button>
        <Button size="sm" onClick={onExport}>
          Export JSONL
        </Button>
        {sure ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-stop">Remove {plural(count, "request")} for good, with their answers and labels?</span>
            <Button size="sm" variant="danger" loading={!!removing} onClick={remove}>
              {removing ? `Removing ${removing.done}/${removing.of}` : `Remove ${num(count)}`}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setSure(false)} disabled={!!removing}>
              Keep them
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setSure(true)}>
            Remove…
          </Button>
        )}
        <QuietLink className="ml-auto" onClick={onClear}>
          Clear
        </QuietLink>
      </div>
      {err && <p className="mt-1 text-sm text-stop">{err}</p>}
    </div>
  );
}

/* ---------- ask an upstream ---------- */

function AskPanel({
  selection,
  filter,
  rows,
  upstreams,
  catMissing,
  reloadCatalog,
  busyRef,
  onProgress,
  onDone,
}: {
  selection: Selection;
  filter: ReqFilter;
  rows: Req[];
  upstreams: Upstream[] | null;
  catMissing: boolean;
  reloadCatalog: () => void;
  busyRef: React.MutableRefObject<boolean>;
  onProgress: () => void;
  onDone: (msg: string) => void;
}) {
  const [up, setUp] = useState<string | null>(null);
  const [est, setEst] = useState<{ e: AskEstimate | null; err: string | null; busy: boolean }>({ e: null, err: null, busy: false });
  const [run, setRun] = useState<{ done: number; of: number; asked: number; failed: { id: string; error: string }[]; started: number; stopped?: boolean; finished?: boolean } | null>(null);
  const stop = useRef(false);
  const u = upstreams?.find((x) => x.id === up) || null;

  useEffect(() => {
    if (!up) return;
    const ctrl = new AbortController();
    setEst({ e: null, err: null, busy: true });
    estimateAsk(selection, up, ctrl.signal)
      .then((e) => setEst({ e, err: null, busy: false }))
      .catch((e) => !ctrl.signal.aborted && setEst({ e: null, err: isMissing(e) ? "Estimating isn't available on this server yet." : (e as Error).message, busy: false }));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [up]);

  async function go() {
    if (!up || !u) return;
    const key = answersKey(u);
    stop.current = false;
    busyRef.current = true;
    const started = Date.now();
    try {
      // only the ones without an answer from it yet: picked rows are checked here; a filter asks the server for them
      let ids: string[];
      if ("ids" in selection) {
        const byId = new Map(rows.map((r) => [r.id, r]));
        ids = selection.ids.filter((id) => !byId.get(id)?.answers?.[key]);
      } else {
        const e = await estimateAsk({ filter: { ...filter, missing: key } }, up);
        ids = e.ids || [];
      }
      const acc = { done: 0, of: ids.length, asked: 0, failed: [] as { id: string; error: string }[], started };
      setRun({ ...acc });
      for (let i = 0; i < ids.length; i += ASK_CHUNK) {
        if (stop.current) {
          setRun({ ...acc, stopped: true, finished: true });
          onDone(`Stopped after ${plural(acc.asked, "request")}. The ones already asked keep their answers.`);
          return;
        }
        const chunk = ids.slice(i, i + ASK_CHUNK);
        try {
          const r = await askUpstream(chunk, up);
          acc.asked += r.asked;
          acc.failed.push(...r.failed);
        } catch (e) {
          acc.failed.push(...chunk.map((id) => ({ id, error: (e as Error).message })));
        }
        acc.done += chunk.length;
        setRun({ ...acc });
        onProgress();
      }
      setRun({ ...acc, finished: true });
      onDone(`${u.name} answered ${plural(acc.asked, "request")}${acc.failed.length ? `; ${acc.failed.length} failed` : ""}.`);
    } catch (e) {
      setRun((r) => ({ ...(r || { done: 0, of: 0, asked: 0, started }), failed: [...(r?.failed || []), { id: "", error: (e as Error).message }], finished: true }));
    } finally {
      busyRef.current = false;
    }
  }

  const e = est.e;
  const running = !!run && !run.finished;
  const left = run && run.done ? ((Date.now() - run.started) / run.done) * (run.of - run.done) : null;
  const blocked = u && !u.ready ? u.why_not || "it can't answer right now" : e && (e as AskEstimate & { ready?: boolean; why_not?: string }).ready === false ? (e as AskEstimate & { why_not?: string }).why_not || "it can't answer right now" : null;
  const listPrice = (e as (AskEstimate & { price_basis?: string }) | null)?.price_basis === "list";

  return (
    <div className="space-y-4">
      {!run && (
        <>
          <p className="text-sm text-slate">Its answers land on each request next to the others. Requests that already have its answer are skipped.</p>
          <UpstreamPicker upstreams={upstreams} missing={catMissing} value={up} onPick={(id) => setUp(id)} onCatalogChanged={reloadCatalog} maxHeight={300} />
        </>
      )}
      {up && !run && (
        <div className="rounded-lg border border-line bg-paper p-3 text-sm" aria-live="polite">
          {est.busy ? (
            <span className="skel h-4 w-2/3" />
          ) : est.err ? (
            <p className="text-stop">{est.err}</p>
          ) : e ? (
            <>
              <p className="text-ink">
                <b className="font-mono font-medium">{num(e.n)}</b> requests · <b className="font-mono font-medium">{num(e.already_answered)}</b> already answered by {u?.name || "it"} ·{" "}
                <b className="font-mono font-medium">{num(e.to_ask)}</b> to ask
              </p>
              <p className="mt-1 text-slate">
                {e.est_usd != null ? `~${usd(e.est_usd)}${listPrice ? " (from the list price)" : ""}` : "no price for it yet"}
                {e.est_minutes != null ? ` · ~${e.est_minutes < 1 ? "under a minute" : `${Math.round(e.est_minutes)} min`}` : ""} · on {keyText(e.key)}
              </p>
              {blocked && <p className="mt-1 text-wait">Can't ask it: {blocked}</p>}
            </>
          ) : null}
        </div>
      )}
      {up && !run && (
        <Button variant="primary" disabled={!e || !e.to_ask || !!blocked || est.busy} onClick={go}>
          {e ? (e.to_ask ? `Ask ${u?.name || "it"} about ${plural(e.to_ask, "request")}${e.est_usd != null ? ` · ~${usd(e.est_usd)}` : ""}` : "Nothing to ask: all answered") : "Ask"}
        </Button>
      )}
      {run && (
        <div className="space-y-2">
          <p className="text-sm text-ink">
            {run.finished ? (run.stopped ? "Stopped." : "Done.") : `Asking ${u?.name || "it"}, ${ASK_CHUNK} at a time…`}
          </p>
          <ProgressTrack value={run.done} max={Math.max(1, run.of)} label={u?.name || ""} unit="requests" done={run.finished && !run.stopped} />
          <p className="text-sm text-slate">
            {plural(run.asked, "answer")}{run.finished ? "" : " so far"}{run.failed.length ? ` · ${run.failed.length} failed` : ""}
            {running && left != null ? ` · about ${fmtMs(left)} left` : ""}
          </p>
          {running && (
            <Button variant="danger" onClick={() => (stop.current = true)}>
              Stop
            </Button>
          )}
          {run.failed.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-stop">What failed ({run.failed.length})</summary>
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto font-mono text-xs text-slate">
                {run.failed.slice(0, 50).map((f, i) => (
                  <li key={i}>
                    {f.id ? `${f.id}: ` : ""}
                    {f.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {run.finished && <p className="text-xs text-slate">The table behind this shows the new answers. Requests whose route treats {u?.name || "it"} as who is right had their labels re-picked.</p>}
        </div>
      )}
    </div>
  );
}

/* ---------- labels ---------- */

function LabelsPanel({ selection, keys, name, onDone }: { selection: Selection; keys: string[]; name: (id: string) => string; onDone: (msg: string) => void }) {
  const [from, setFrom] = useState<string | null>(keys[0] || null);
  const [unpin, setUnpin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate">The labels are what a model trains on. Pin them to one upstream's answers; a person's fix still wins. Requests without an answer from it keep their labels.</p>
      {keys.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line" role="radiogroup" aria-label="Whose answers">
          {keys.map((k) => (
            <li key={k}>
              <button type="button" role="radio" aria-checked={!unpin && from === k} onClick={() => { setFrom(k); setUnpin(false); }} className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-panel ${!unpin && from === k ? "bg-accent-soft" : ""}`}>
                <span className={`h-3 w-3 rounded-full border ${!unpin && from === k ? "border-accent bg-accent" : "border-slate"}`} aria-hidden="true" />
                {name(k)}
              </button>
            </li>
          ))}
          <li>
            <button type="button" role="radio" aria-checked={unpin} onClick={() => setUnpin(true)} className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-panel ${unpin ? "bg-accent-soft" : ""}`}>
              <span className={`h-3 w-3 rounded-full border ${unpin ? "border-accent bg-accent" : "border-slate"}`} aria-hidden="true" />
              Back to each route's own rule (its setup's “who is right”)
            </button>
          </li>
        </ul>
      ) : (
        <p className="text-slate">None of these requests has an answer yet. Ask an upstream first.</p>
      )}
      {err && <p className="text-stop">{err}</p>}
      <Button
        variant="primary"
        loading={busy}
        disabled={!unpin && !from}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await pinLabels(selection, unpin ? null : from);
            onDone(unpin ? `${plural(r.labelled, "request")} back to their route's rule.` : `${plural(r.labelled, "request")} now labelled from ${name(from!)}${r.missing ? `; ${num(r.missing)} had no answer from it` : ""}.`);
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {unpin ? "Use each route's rule" : from ? `Use ${name(from)}'s answers as labels` : "Pick one"}
      </Button>
    </div>
  );
}

/* ---------- compare ---------- */

function ComparePanel({ keys, counts, name, initial, onApply }: { keys: string[]; counts: Record<string, number>; name: (id: string) => string; initial: [string, string]; onApply: (a: string, b: string) => void }) {
  const [a, setA] = useState(initial[0] || keys[0] || "");
  const [b, setB] = useState(initial[1] || keys.find((k) => k !== (initial[0] || keys[0])) || "");
  const opt = (k: string) => (
    <option key={k} value={k}>
      {name(k)}
      {counts[k] != null ? ` · answered ${num(counts[k])}` : " · not asked yet"}
    </option>
  );
  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-slate">Compare</span>
        <select className={`${selCls} mt-1 w-full`} value={a} onChange={(e) => setA(e.target.value)}>
          {keys.map(opt)}
        </select>
      </label>
      <label className="block">
        <span className="text-slate">with</span>
        <select className={`${selCls} mt-1 w-full`} value={b} onChange={(e) => setB(e.target.value)}>
          <option value="">Pick one</option>
          {keys.filter((k) => k !== a).map(opt)}
        </select>
      </label>
      {b && !counts[b] && <p className="text-wait">{name(b)} hasn't answered these yet: use “Ask an upstream…” first, then compare.</p>}
      <Button variant="primary" disabled={!a || !b} onClick={() => onApply(a, b)}>
        Show where they disagree
      </Button>
      <p className="text-xs text-slate">Sets the table's two answer columns and adds the “disagree” filter; remove the filter to see every request side by side.</p>
    </div>
  );
}
