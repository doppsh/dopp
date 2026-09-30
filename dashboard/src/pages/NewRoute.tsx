/* New route, on one page: a name → what answers (any upstream in the catalog) → how it starts (a preset) → the URL, the
   key (shown once), code to call it, and a test request sent from here. */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { Badge } from "../components/Badge";
import { Button, LinkButton } from "../components/Button";
import { ErrorState, Field, TextInput } from "../components/Bits";
import { FreshKey, SAMPLE, Snippets, TestRequest, UrlRow } from "../components/Connect";
import { UpstreamPicker } from "../components/UpstreamPicker";
import type { FallbackOption } from "../components/UpstreamPicker";
import { cachedRoutes, createRoute, listConnections, rememberFreshKey } from "../lib/api";
import { priceText, speedText, useCatalog, upstreamName } from "../lib/upstreams";
import type { PresetId, RouteSummary, Upstream } from "../lib/types";
import { billingOn, ourKey } from "../lib/server";

interface PresetView {
  id: PresetId;
  title: string;
  line: string;
  blocked: string | null;
}

/** The starting setups POST /api/routes takes, built around the upstream picked above, each in one line. */
function presetsFor(u: Upstream | null, uName: string): PresetView[] {
  const notReady = u && !u.ready ? `${uName} can't answer yet: ${u.why_not || "not ready"}.` : null;
  return [
    {
      id: "learn",
      title: `${uName}, and learn`,
      line: `${uName} answers and its answers are the labels; this route's own model trains on them and practises in the background.`,
      blocked: notReady,
    },
    { id: "only", title: `${uName} only`, line: `${uName} answers every request. Every request is stored; nothing else runs until you ask.`, blocked: notReady },
    {
      id: "model_first",
      title: `Your model first, ${uName} when unsure`,
      line: `This route's trained model answers; below 70% sure, or on an error, ${uName} answers. Until the route has a trained model, ${uName} answers everything.`,
      blocked: notReady,
    },
    {
      id: "model_only",
      title: "Your model only",
      line: `This route's trained model answers everything; ${uName} labels 5% to keep measuring it.`,
      blocked: "Needs a trained model on this route, and a new route has none yet. Start with another and switch in its setup once it has one.",
    },
  ];
}

function Step({ n, title, done, children }: { n: number; title: ReactNode; done?: boolean; children: ReactNode }) {
  return (
    <section className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <h2 className="flex items-baseline gap-2.5 text-md font-semibold text-ink">
        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs ${done ? "bg-go text-white" : "bg-panel text-slate"}`}>{n}</span>
        {title}
      </h2>
      <div className="mt-3 min-w-0 sm:pl-8">{children}</div>
    </section>
  );
}

export default function NewRoute() {
  const { upstreams, missing, reload } = useCatalog();
  const [fallback, setFallback] = useState<FallbackOption[]>([]);
  const [name, setName] = useState("");
  const [upstream, setUpstream] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetId | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ route: RouteSummary; key: string; url: string; legacy?: boolean } | null>(null);

  // no catalog on this server yet: offer what the account is already connected to
  useEffect(() => {
    if (!missing) return;
    listConnections()
      .then((cs) => setFallback(cs.map((c) => ({ id: c.kind === "jev" ? "jev" : `endpoint:${c.id}`, name: c.name, note: c.kind === "jev" ? (c.key_owner === "ours" ? ourKey(billingOn()) : "your key") : "a service that speaks Jev's API" }))))
      .catch(() => setFallback([]));
  }, [missing]);

  // start on Jev when it's there and ready
  useEffect(() => {
    if (upstream) return;
    const jev = upstreams?.find((u) => u.kind === "jev" && u.ready);
    if (jev) setUpstream(jev.id);
    else if (missing && fallback.some((f) => f.id === "jev")) setUpstream("jev");
  }, [upstreams, missing, fallback, upstream]);

  const u = upstreams?.find((x) => x.id === upstream) || null;
  const uName = upstreamName(upstream, upstreams || fallback);
  const presets = useMemo(() => presetsFor(u, uName), [u, uName]);
  // a sensible start for the picked upstream, unless the one picked still works
  useEffect(() => {
    const cur = presets.find((p) => p.id === preset);
    if (cur && !cur.blocked) return;
    setPreset(presets.find((p) => !p.blocked)?.id || null);
  }, [presets, preset]);

  const okName = name.trim().length > 0;
  const chosen = presets.find((p) => p.id === preset);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const r = await createRoute({ name: name.trim(), ...(upstream ? { upstream } : {}), ...(preset ? { preset } : {}) });
      rememberFreshKey(r.route.id, r.key);
      setMade({ route: r.route, key: r.key, url: r.url || cachedRoutes()?.url || location.origin + "/v1/systemone", legacy: r.legacy });
      window.scrollTo(0, 0);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (made) return <Done made={made} upstreamLabel={uName} presetTitle={chosen?.title || null} />;

  return (
    <Page>
      <PageHeader title="New route" description="A URL and a key for your app. Pick what answers; every request is stored either way, and you can change who answers any time." breadcrumb={<Link to="/routes" className="hover:underline">Routes</Link>} />
      <div className="mt-6 max-w-[760px]">
        <Step n={1} title="Name it" done={okName}>
          <Field label="Route name" id="route-name" hint="What your app calls this decision, e.g. the feature it serves. Trained models are named after it: “name v1”.">
            <TextInput id="route-name" autoFocus maxLength={60} placeholder="support-triage" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </Step>

        <Step n={2} title="What answers" done={!!upstream}>
          <p className="mb-2 text-sm text-slate">Anything that answers in Jev's shape. You can add fallbacks, background answers and labels on the route's setup after.</p>
          <UpstreamPicker upstreams={upstreams} missing={missing} fallback={fallback} value={upstream} onPick={(id) => setUpstream(id)} onCatalogChanged={reload} maxHeight={420} />
          {u && (
            <p className="mt-2 text-sm text-slate">
              Picked <b className="font-medium text-ink">{u.name}</b> · {priceText(u)} · {speedText(u)}
            </p>
          )}
        </Step>

        <Step n={3} title="How it starts" done={!!preset}>
          <ul className="space-y-2" role="radiogroup" aria-label="Starting setup">
            {presets.map((p) => {
              const on = preset === p.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!!p.blocked}
                    onClick={() => setPreset(p.id)}
                    className={`block w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-slate"} ${p.blocked ? "opacity-60" : ""}`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className={`mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border ${on ? "border-accent bg-accent" : "border-slate"}`} aria-hidden="true" />
                      <b className="text-base font-medium text-ink">{p.title}</b>
                    </span>
                    <span className="mt-0.5 block pl-5 text-sm text-slate">{p.line}</span>
                    {p.blocked && <span className="mt-0.5 block pl-5 text-xs text-wait">{p.blocked}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </Step>

        {err && <ErrorState title="Couldn't make the route." detail={err} />}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button variant="primary" loading={busy} disabled={!okName || !upstream || !preset} onClick={create}>
            Create route
          </Button>
          <span className="text-sm text-slate">
            {!okName ? "Name it first." : !upstream ? "Pick what answers." : !preset ? "Pick how it starts." : "Makes the route and its first key. Nothing is billed until requests arrive."}
          </span>
        </div>
      </div>
    </Page>
  );
}

function Done({ made, upstreamLabel, presetTitle }: { made: { route: RouteSummary; key: string; url: string; legacy?: boolean }; upstreamLabel: string; presetTitle: string | null }) {
  const nav = useNavigate();
  const { route, key, url } = made;
  const e = encodeURIComponent(route.id);
  return (
    <Page>
      <PageHeader
        title={`${route.name} is ready`}
        description={<>{upstreamLabel} answers{presetTitle ? ` (${presetTitle})` : ""}. Put the URL and key in your app where it calls Jev today.</>}
        breadcrumb={<Link to="/routes" className="hover:underline">Routes</Link>}
        action={
          <LinkButton to={`/routes/${e}`}>
            Open the route
          </LinkButton>
        }
      />
      <div className="mt-6 max-w-[860px] space-y-5">
        {made.legacy && <p className="rounded border border-wait/40 bg-wait-soft px-3 py-2 text-sm text-ink">Made through this server's older endpoints (it has no /api/routes yet); the route and key are the same.</p>}
        <section>
          <UrlRow label="URL" value={url} />
          {url.endsWith("/v1/systemone") && <UrlRow label="Base address" value={url.slice(0, -"/v1/systemone".length)} />}
          <p className="text-xs text-slate sm:pl-[122px]">SDKs and integrations that ask for an address or base URL (the TypeSafe SDK, most plugins) take the base address; they add /v1/systemone themselves.</p>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1 py-2 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-3">
            <span className="pt-1 text-sm text-slate">Key</span>
            <FreshKey value={key} />
          </div>
        </section>

        <section>
          <h2 className="text-md font-semibold text-ink">Check it works</h2>
          <TestRequest url={url} keyValue={key} />
        </section>

        <section>
          <h2 className="mb-2 text-md font-semibold text-ink">Call it from your app</h2>
          <Snippets proxy={url} keyNote="the key above" questions={SAMPLE} own={false} />
        </section>

        <section className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button variant="primary" onClick={() => nav(`/routes/${e}`)}>
            Open {route.name}
          </Button>
          <LinkButton to={`/routes/${e}/try`}>Try a request</LinkButton>
          <LinkButton to="/routes/new" variant="quiet">
            Make another route
          </LinkButton>
        </section>
        <p className="text-xs text-slate">
          <Badge>tip</Badge> The first real request teaches the route your questions; it shows up on Requests within a second.
        </p>
      </div>
    </Page>
  );
}
