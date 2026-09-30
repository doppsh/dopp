/* One route: its name, URL and keys, the setup (what happens when a request comes in), and its latest requests. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { AddRequests, addInitFromHash, tabFromHash } from "../components/AddRequests";
import type { AddTab } from "../components/AddRequests";
import { Page, PageHeader } from "../app/AppShell";
import { Badge } from "../components/Badge";
import { Button, LinkButton } from "../components/Button";
import { CodeBlock, ErrorState, TextInput } from "../components/Bits";
import { Keys, Snippets, snippetQuestions, UrlRow } from "../components/Connect";
import { Stat, StatRow } from "../components/Panel";
import { RequestDrawer, RequestList } from "../components/RequestList";
import { useToast } from "../components/Toast";
import { deleteRoute, fetchRequests, fetchRoute, fetchRoutes, isMissing, renameRoute } from "../lib/api";
import { modelName, num, plural, usd } from "../lib/domain";
import { useNarrow, useProject } from "../lib/project";
import { nameList, upstreamName, useCatalog } from "../lib/upstreams";
import type { Req, RouteSummary } from "../lib/types";
import { SetupSection } from "./RouteSetup";
import { Training } from "../components/Training";
import { HostingBlock } from "../components/Billing";
import { ServingLine } from "../components/ServingLine";
import { AgentPrompt } from "../components/ConnectFirst";
import { getSetup, saveSetup } from "../lib/api";
import { versionName } from "../lib/domain";

export default function RoutePage() {
  const { id = "" } = useParams();
  const [route, setRoute] = useState<RouteSummary | null>(null);
  const [url, setUrl] = useState<string>("");
  const [err, setErr] = useState<{ msg: string; gone: boolean } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetchRoute(id);
      setRoute(r.route);
      setUrl(r.url);
      setErr(null);
    } catch (e) {
      setErr({ msg: (e as Error).message, gone: isMissing(e) });
    }
  }, [id]);
  useEffect(() => {
    setRoute(null);
    load();
  }, [load]);

  if (err && !route)
    return (
      <Page>
        <PageHeader title="Route" breadcrumb={<Link to="/routes" className="hover:underline">Routes</Link>} />
        <div className="mt-6">
          <ErrorState title={err.gone ? "No such route." : "Couldn't load this route."} detail={err.msg} onRetry={err.gone ? undefined : load} />
        </div>
      </Page>
    );

  return (
    <Page wide>
      <Header id={id} route={route} onRenamed={load} />
      <Numbers route={route} />
      {/* once requests arrive, training is what the page is for; before that, connecting is */}
      {route && route.requests_total ? (
        <>
          <Training id={id} name={route.name} />
          <Connect id={id} route={route} url={url} reload={load} />
        </>
      ) : (
        <>
          <Connect id={id} route={route} url={url} reload={load} />
          <Training id={id} name={route?.name ?? null} />
        </>
      )}
      <SetupSection id={id} name={route?.name ?? null} />
      <Hosting id={id} name={route?.name ?? null} />
      <AddSection id={id} />
      <Latest id={id} />
      <Danger id={id} route={route} />
    </Page>
  );
}

function Header({ id, route, onRenamed }: { id: string; route: RouteSummary | null; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const e = encodeURIComponent(id);
  async function save() {
    const n = name.trim();
    if (!n || n === route?.name) return setEditing(false);
    setBusy(true);
    try {
      await renameRoute(id, n);
      toast.show(`Renamed to ${n}. Its models are named after it from now on.`);
      setEditing(false);
      onRenamed();
    } catch (err) {
      toast.show((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageHeader
      breadcrumb={<Link to="/routes" className="hover:underline">Routes</Link>}
      tab={route ? modelName(route.name) : undefined}
      title={
        editing ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              save();
            }}
          >
            <TextInput aria-label="Route name" autoFocus onFocus={(ev) => ev.target.select()} maxLength={60} value={name} onChange={(ev) => setName(ev.target.value)} onKeyDown={(ev) => ev.key === "Escape" && setEditing(false)} className="!w-auto min-w-0 font-sans text-lg" />
            <Button size="sm" variant="primary" type="submit" loading={busy}>
              Save
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : route ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-3">
            {modelName(route.name)}
            <button
              type="button"
              className="font-sans text-sm text-slate underline decoration-line underline-offset-2 hover:text-ink"
              onClick={() => {
                setName(route.name);
                setEditing(true);
              }}
            >
              Rename
            </button>
            <Link to={`/analytics?route=${encodeURIComponent(route.id)}`} className="font-sans text-sm text-slate underline decoration-line underline-offset-2 hover:text-ink">
              Analytics for this route
            </Link>
          </span>
        ) : (
          <span className="skel inline-block h-7 w-48 align-middle" />
        )
      }
      description={route ? <span className="font-mono text-sm">{route.setup_summary || "no setup yet"}</span> : <span className="skel inline-block h-3.5 w-64 align-middle" />}
      action={
        <>
          <TrainButton id={id} />
          <LinkButton to={`/routes/${e}/try`}>Try a request</LinkButton>
          <LinkButton to={`/routes/${e}#add-requests?tab=paste`}>Add requests</LinkButton>
          <LinkButton to={`/requests?route=${e}`}>View requests</LinkButton>
        </>
      }
    />
  );
}

function Numbers({ route }: { route: RouteSummary | null }) {
  const sk = <span className="skel mt-1 h-4 w-12" />;
  return (
    <StatRow className="mt-4">
      <Stat label="Requests, 24h" value={route ? (route.requests_24h == null ? "—" : num(route.requests_24h)) : sk} />
      <Stat label="Requests, all" value={route ? num(route.requests_total) : sk} />
      <Stat label="Cost, 24h" value={route ? (route.cost_24h_usd == null ? "—" : usd(route.cost_24h_usd)) : sk} />
      <Stat label="Latest model" value={route ? route.latest_model?.name || "none yet" : sk} />
      <Stat label="Live keys" value={route ? num(route.keys.filter((k) => !k.revoked_at).length) : sk} />
    </StatRow>
  );
}

function Connect({ id, route, url, reload }: { id: string; route: RouteSummary | null; url: string; reload: () => Promise<void> }) {
  const { data: proj } = useProject(id);
  const [code, setCode] = useState(false);
  const { upstreams } = useCatalog();
  const sq = snippetQuestions(proj);
  // one real upstream id for the "pick it per request" example: an LLM if the catalog has one
  const pickId = (upstreams || []).find((u) => u.kind === "llm" && u.ready)?.id || (upstreams || []).find((u) => u.ready && u.kind !== "jev")?.id || "jev";
  return (
    <section id="connect" aria-labelledby="connect-h" className="mt-6 scroll-mt-20 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="connect-h" className="text-base font-semibold text-ink">
          Connect
        </h2>
        <button type="button" className="text-sm text-accent hover:underline" aria-expanded={code} onClick={() => setCode((v) => !v)}>
          {code ? "Hide the code" : "Code to call it"}
        </button>
      </div>
      <UrlRow label="URL" value={url || "…"} />
      <Keys routeId={id} keys={route?.keys ?? null} reload={reload} url={url} />
      <AgentPrompt routeId={id} url={url} reload={reload} />
      {code && (
        <div className="mt-2 space-y-3 border-t border-line pt-3">
          <p className="text-sm text-slate">{sq.own ? "With this route's own questions." : "With sample questions until your app sends its own."} Put the key in DOPP_KEY.</p>
          <Snippets proxy={url} keyNote="a key from above" questions={sq.questions} own={sq.own} />
          <div>
            <p className="text-sm text-slate">
              Pick the upstream per request, like OpenRouter: add <code className="font-mono">model</code> to the body (or send the <code className="font-mono">x-dopp-target</code> header). Works when a branch of the setup lets callers pick.
            </p>
            <CodeBlock code={`{"model": "${pickId}", "state": "…", "questions": {…}}`} />
          </div>
        </div>
      )}
    </section>
  );
}

function Latest({ id }: { id: string }) {
  const [rows, setRows] = useState<Req[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Req | null>(null);
  const { upstreams } = useCatalog();
  const narrow = useNarrow(900);
  const names = useMemo(() => nameList(upstreams), [upstreams]);
  const name = useCallback((x: string) => upstreamName(x, names), [names]);
  const load = useCallback(() => {
    setErr(null);
    fetchRequests({ route: [id] }, 0, 10)
      .then((p) => {
        setRows(p.requests);
        setTotal(p.total);
      })
      .catch((e) => setErr((e as Error).message));
  }, [id]);
  useEffect(() => {
    load();
    window.addEventListener("understudy:requests-added", load);
    return () => window.removeEventListener("understudy:requests-added", load);
  }, [load]);
  return (
    <section aria-labelledby="latest-h" className="mt-8">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="latest-h" className="text-lg font-semibold text-ink">
          Latest requests {total != null && <span className="ml-1 text-sm font-normal text-slate">{plural(total, "request")} in all</span>}
        </h2>
        <Link to={`/requests?route=${encodeURIComponent(id)}`} className="text-sm text-accent hover:underline">
          Open in Requests →
        </Link>
      </div>
      {err ? (
        <ErrorState title="Couldn't load its requests." detail={err} onRetry={load} />
      ) : (
        <RequestList
          rows={rows || []}
          loading={rows ? undefined : 4}
          empty={
            <span>
              No requests yet. Send one from your app with a key above, or{" "}
              <Link to={`/routes/${encodeURIComponent(id)}/try`} className="text-accent hover:underline">
                try one here
              </Link>
              .
            </span>
          }
          name={name}
          onOpen={setOpen}
          showRoute={false}
          narrow={narrow}
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
      />
    </section>
  );
}

function Danger({ id, route }: { id: string; route: RouteSummary | null }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  if (!route) return null;
  const n = route.requests_total || 0;
  return (
    <section className="mt-10 border-t border-line pt-4">
      {!open ? (
        <button type="button" className="text-sm text-slate underline decoration-line underline-offset-2 hover:text-stop" onClick={() => setOpen(true)}>
          Delete this route…
        </button>
      ) : (
        <div className="max-w-[620px] rounded-lg border border-stop/40 bg-stop-soft p-3">
          <p className="text-sm font-medium text-stop">Delete {route.name}?</p>
          <p className="mt-1 text-sm text-ink">
            Its keys stop working at once{n ? <> and its {plural(n, "request")} are removed</> : null}. This can't be undone.
          </p>
          {n > 0 && (
            <label className="mt-2 block text-sm text-ink">
              Type <b className="font-mono">{route.name}</b> to confirm
              <TextInput className="mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
          )}
          {err && <p className="mt-2 text-sm text-stop">{err}</p>}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              disabled={n > 0 && typed !== route.name}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await deleteRoute(id, n > 0 ? typed : undefined);
                  await fetchRoutes().catch(() => null);
                  toast.show(`Deleted ${route.name}.`);
                  nav("/routes");
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete {route.name}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>
              Keep it
            </Button>
          </div>
          {!n && <p className="mt-2 text-xs text-slate"><Badge>empty</Badge> It has no requests, so nothing else is removed.</p>}
        </div>
      )}
    </section>
  );
}

/** The trained version this route serves from our GPUs: who pays for it (credit or a hosting subscription), whether it is awake, and keep-awake. */
function Hosting({ id, name }: { id: string; name: string | null }) {
  const { data: proj, reload } = useProject(id);
  const toast = useToast();
  const [keep, setKeep] = useState<boolean | null>(null);
  const [modelFirst, setModelFirst] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const version = proj?.model?.version || 0;
  useEffect(() => {
    if (!version) return;
    getSetup(id)
      .then((s) => {
        setKeep(!!s.setup.keep_awake);
        // does any route of the setup ask this route's own model first? Then a sleeping model makes the caller wait for it to wake
        const own = (a: string) => a === "model" || a.startsWith("plan:") || /^model@\d+$/.test(a) || a.startsWith(`model:${id}@`);
        setModelFirst(s.setup.routes.some((r) => { const f = r.steps[0]; return !!f && (f.split ? Object.keys(f.split) : f.ask ? [f.ask] : []).some(own); }));
      })
      .catch(() => setKeep(null));
  }, [id, version]);
  if (!version) return null;
  const v = versionName(name || "", version);
  const serving = proj?.model?.serving;
  return (
    <section aria-label="Hosting" className="mt-6">
      <HostingBlock id={id} v={v} />
      {serving && keep === false && modelFirst && (
        <p className="mt-3 text-sm text-wait">
          {v} answers first here. The first request after a quiet spell can take up to ~{serving.wake_seconds} s while it wakes; keep it awake below to avoid that.
        </p>
      )}
      {serving && keep !== null && (
        <ServingLine
          id={id}
          v={v}
          s={serving}
          onWoke={() => void reload()}
          keepAwake={keep}
          onKeepAwake={async (on) => {
            try {
              const cur = await getSetup(id);
              const next = await saveSetup(id, { ...cur.setup, keep_awake: on }, on ? `Keep ${v} awake` : `Let ${v} sleep`);
              setKeep(!!next.setup.keep_awake);
              toast.show(on ? `${v} stays awake until you turn this off.` : `${v} goes to sleep ${serving.idle_minutes} minutes after its last request.`);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        />
      )}
      {err && <p className="mt-2 text-sm text-stop">{err}</p>}
    </section>
  );
}

/** Add requests without an app: paste, public datasets, generated. Opened (and the tab picked) by #add-requests?tab=find|generate|paste. */
function AddSection({ id }: { id: string }) {
  const loc = useLocation();
  const nav = useNavigate();
  const fromHash = tabFromHash(loc.hash);
  const [open, setOpen] = useState(!!fromHash);
  const [tab, setTab] = useState<AddTab>(fromHash || "paste");
  useEffect(() => {
    const t = tabFromHash(loc.hash);
    if (!t) return;
    setTab(t);
    setOpen(true);
    requestAnimationFrame(() => document.getElementById("add-requests")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [loc.hash]);
  const pick = (t: AddTab) => {
    setTab(t);
    nav({ hash: `add-requests?tab=${t}` }, { replace: true });
  };
  return (
    <section id="add-requests" aria-labelledby="add-h" className="mt-6 scroll-mt-20 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="add-h" className="text-base font-semibold text-ink">
          Add requests
        </h2>
        <button type="button" className="text-sm text-accent hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Paste, find a public dataset, or generate"}
        </button>
      </div>
      {open && (
        <div className="mt-2">
          <AddRequests routeId={id} tab={tab} onTab={pick} init={addInitFromHash(loc.hash)} onAdded={() => window.dispatchEvent(new Event("understudy:requests-added"))} />
        </div>
      )}
    </section>
  );
}

/** The header's way into training, with where it stands: "Training now…", "Train · 49/100", or "Train a model". */
function TrainButton({ id }: { id: string }) {
  const { data: proj } = useProject(id);
  const m = proj?.model;
  const p = m?.auto?.[0];
  const label = m?.status === "training" || p?.waiting === "training" ? "Training now…" : p ? `Train · ${num(p.have)}/${num(p.need)}` : "Train a model";
  return (
    <Button variant="primary" onClick={() => document.getElementById("training")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
      {label}
    </Button>
  );
}
