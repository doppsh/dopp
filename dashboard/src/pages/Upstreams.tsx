/* Upstreams: everything that can answer, as one page. Jev (the server's key or yours), LLMs (the ones in your list, more from
   OpenRouter; your OpenRouter key; Gemini on ours), services that speak Jev's API, and your trained models. Prices and
   times are measured on your requests where there is history, and marked as list prices or guesses where not. */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { Badge } from "../components/Badge";
import { Button, LinkButton, QuietLink } from "../components/Button";
import { EmptyState, ErrorState, Field, TextInput } from "../components/Bits";
import { AddConnectionForm, JevConnection, ServiceRow } from "../components/Connections";
import { useToast } from "../components/Toast";
import { OpenRouterSearch } from "../components/UpstreamPicker";
import { addConnection, cachedRoutes, deleteConnection, fetchRoutes, listConnections, pinUpstream, unpinUpstream } from "../lib/api";
import { pct1 } from "../lib/domain";
import { benchText, holdoutPct, keyText, priceText, speedText, useCatalog } from "../lib/upstreams";
import type { Connection, Provider, RoutesPage, Upstream } from "../lib/types";
import { billingOn, ourKey } from "../lib/server";

function Section({ id, title, line, action, children }: { id: string; title: string; line: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="mt-8 scroll-mt-20 first:mt-6">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`${id}-h`} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          <p className="mt-0.5 max-w-[80ch] text-sm text-slate">{line}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One upstream as a row: name, where it runs and whose key, price and speed (measured or marked), and why it can't answer. */
function Row({ u, children, extra }: { u: Upstream; children?: ReactNode; extra?: ReactNode }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-line px-3 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center">
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink" title={u.id}>
          {u.name}
        </span>
        <span className="block truncate font-mono text-2xs text-slate">{u.id}</span>
        {extra}
      </span>
      <span className="font-mono text-xs text-slate">
        <span className="block">{priceText(u)}</span>
        <span className="block">{speedText(u)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2 text-sm">
        {u.ready ? <Badge tone="go">ready</Badge> : <Badge tone="wait" title={u.why_not || undefined}>{u.why_not || "not ready"}</Badge>}
        {children}
      </span>
    </li>
  );
}

const List = ({ children }: { children: ReactNode }) => <ul className="rounded-lg border border-line bg-surface">{children}</ul>;

export default function Upstreams() {
  const { upstreams, providers, missing, error, reload } = useCatalog();
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [routes, setRoutes] = useState<RoutesPage | null>(cachedRoutes());
  const [adding, setAdding] = useState<"service" | "openai" | "search" | "orkey" | null>(null);
  const [tab, setTab] = useState<string>(() => (typeof location !== "undefined" && location.hash ? location.hash.slice(1) : "all"));
  const show = (id: string) => tab === "all" || tab === id;
  const toast = useToast();

  const loadConns = useCallback(() => {
    listConnections()
      .then((xs) => {
        setConns(xs);
        setConnErr(null);
      })
      .catch((e) => setConnErr((e as Error).message));
  }, []);
  useEffect(() => {
    loadConns();
    fetchRoutes().then(setRoutes).catch(() => null);
  }, [loadConns]);

  const by = (k: Upstream["kind"]) => (upstreams || []).filter((u) => u.kind === k);
  const jevU = by("jev")[0];
  const jevC = conns?.find((c) => c.kind === "jev");
  const llms = by("llm"), opens = by("open");
  const tabs: [string, string, number | null][] = [["all", "All", null], ["jev", "Jev", null], ["open", "Open models", opens.length || null], ["llms", "LLMs", llms.length || null], ["services", "Services", null], ["models", "Your models", null]];
  const models = by("model");
  const services = (conns || []).filter((c) => c.kind === "systemone");
  const openais = (conns || []).filter((c) => c.kind === "openai");
  const orProvider = providers.find((p) => p.id === "openrouter");
  const orConn = (conns || []).find((c) => c.kind === "openrouter");
  const routeName = (id: string) => routes?.routes.find((r) => r.id === id)?.name || "a route";
  const loading = !upstreams && !missing && !error;

  const skel = (
    <div className="space-y-2 rounded-lg border border-line bg-surface p-3" aria-busy="true">
      <span className="skel h-4 w-1/3" />
      <span className="skel h-3 w-2/3" />
    </div>
  );

  return (
    <Page wide>
      <PageHeader
        title="Upstreams"
        description="One URL, any answerer. Each route picks who answers: Jev, open models on your Modal GPUs (Fastino's GLiNER, Kev, Laya, JevK5), any OpenRouter model, a service of yours, or a model you trained. Compare them on your real traffic, then keep the one that wins."
      />
      <div role="tablist" aria-label="Kinds of upstream" className="mt-4 flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([id, t, n]) => (
          <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`-mb-px rounded-t px-3 py-1.5 text-sm ${tab === id ? "border border-line border-b-surface bg-surface text-ink" : "text-slate hover:text-ink"}`}>
            {t}{n != null ? <span className="ml-1 text-2xs text-slate">{n}</span> : null}
          </button>
        ))}
      </div>
      {missing && <p className="mt-4 rounded border border-wait/40 bg-wait-soft px-3 py-2 text-sm text-ink">The upstream catalog isn't on this server yet, so prices, LLMs and models don't show here. Keys to Jev and services still work below.</p>}
      {error && (
        <div className="mt-4">
          <ErrorState title="Couldn't load the upstreams." detail={error} onRetry={reload} />
        </div>
      )}

      {show("jev") && (
        <Section id="jev" title="Jev" line={billingOn() ? "TypeSafe's model. Reached with Dopp's key (billed through your credits) or your own TypeSafe key (billed by TypeSafe)." : "TypeSafe's model. Reached with this server's key or your own TypeSafe key (billed by TypeSafe)."}>
          {loading ? skel : jevU ? <List><Row u={jevU} extra={jevU.jevbench != null ? <span className="block text-2xs text-slate">{benchText(jevU)} (the one to beat)</span> : undefined}><span className="text-xs text-slate">{keyText(jevU.key)}</span></Row></List> : null}
          <div className="mt-3 rounded-lg border border-line bg-surface p-4">
            {connErr ? <ErrorState detail={connErr} onRetry={loadConns} /> : jevC ? <JevConnection c={jevC} onSaved={(c) => { setConns((xs) => (xs || []).map((x) => (x.id === c.id ? c : x))); reload(); }} /> : skel}
          </div>
        </Section>
      )}

      {show("open") && (
        <Section id="open" title="Open models" line="Open-weight decision models served from your Modal account, answering in Jev's shape with no training and no key. You pay the GPU time they run; the ones marked trainable are also bases you can fine-tune on your requests (Models).">
          {loading ? skel : opens.length ? (
            <List>
              {opens.map((u) => (
                <Row key={u.id} u={u} extra={<span className="block text-2xs text-slate">{[u.license, benchText(u), u.trainable ? "trainable" : null, u.note].filter(Boolean).join(" · ")}{u.repo && <> · <a className="text-accent hover:underline" href={`https://huggingface.co/${u.repo}`} target="_blank" rel="noreferrer">{u.repo}</a></>}</span>} />
              ))}
            </List>
          ) : <p className="text-sm text-slate">No open models on this server yet.</p>}
          <p className="mt-2 text-xs text-slate">JevBench scores: v1.4.1 on benchmarkheaven.com (23 Sep 2026), where the exact model is listed; Jev 1.13.0 scores 63.3 there.</p>
        </Section>
      )}

      {show("llms") && (
        <Section
          id="llms"
          title="LLMs"
          line="Asked with your questions and a JSON-schema answer. An LLM states one option and how sure it is; the rest of the probability is spread evenly over the other options."
          action={
            <Button size="sm" onClick={() => setAdding(adding === "search" ? null : "search")}>
              {adding === "search" ? "Close search" : "+ Add from OpenRouter"}
            </Button>
          }
        >
          <ProviderLine providers={providers} />
          {adding === "search" && (
            <div className="mb-3 rounded-lg border border-line bg-surface p-3">
              <OpenRouterSearch
                pinned={llms.map((u) => u.id)}
                onPinned={(id) => {
                  toast.show("Added to your list. Pick it on any route or on Requests.");
                  reload();
                  void id;
                }}
              />
              {!orProvider?.connected && <p className="mt-2 text-xs text-wait">Answering with OpenRouter needs your OpenRouter key (below); until then its models are listed but can't answer.</p>}
            </div>
          )}
          {loading ? (
            skel
          ) : llms.length ? (
            <List>
              {llms.map((u) => (
                <Row key={u.id} u={u} extra={<span className="block text-2xs text-slate">{u.provider} · {keyText(u.key)}</span>}>
                  {(u as Upstream & { pinned?: boolean }).pinned && (
                    <QuietLink
                      tone="danger"
                      onClick={async () => {
                        try {
                          await unpinUpstream(u.id);
                          toast.show(`Removed ${u.name} from your list.`);
                          reload();
                        } catch (e) {
                          toast.show((e as Error).message, "error");
                        }
                      }}
                    >
                      Remove
                    </QuietLink>
                  )}
                </Row>
              ))}
            </List>
          ) : !missing ? (
            <EmptyState title="No LLMs in your list yet." body="Add one from OpenRouter's list, with its price per 1,000 requests." />
          ) : null}
  
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
            <OpenRouterKey provider={orProvider} conn={orConn} onChanged={() => { loadConns(); reload(); }} />
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="font-medium text-ink">An OpenAI-compatible URL</p>
              <p className="mt-0.5 text-sm text-slate">vLLM, Ollama, Together, your own gateway: anything that takes OpenAI's chat format. Then add a model from it by name.</p>
              {openais.map((c) => (
                <OpenAiModels key={c.id} c={c} have={llms.map((u) => u.id)} onChanged={() => { loadConns(); reload(); }} />
              ))}
              {adding === "openai" ? (
                <OpenAiForm onCancel={() => setAdding(null)} onAdded={() => { setAdding(null); loadConns(); reload(); }} />
              ) : (
                <Button size="sm" className="mt-2" onClick={() => setAdding("openai")}>
                  + Connect a URL
                </Button>
              )}
            </div>
          </div>
        </Section>
      )}

      {show("services") && (
        <Section id="services" title="Services that speak Jev's API" line="Any URL that takes a /v1/systemone request and answers in Jev's shape: your own model server, an offline folder, another router.">
          {connErr ? (
            <ErrorState detail={connErr} onRetry={loadConns} />
          ) : !conns ? (
            skel
          ) : (
            <>
              {services.length ? (
                <ul className="rounded-lg border border-line bg-surface px-3 text-sm [&>li:first-child]:border-t-0">
                  {services.map((c) => {
                    const u = (upstreams || []).find((x) => x.id === `endpoint:${c.id}` || x.id === `url:${c.id}`);
                    return (
                      <ServiceRow
                        key={c.id}
                        c={c}
                        extra={u && <p className="mt-0.5 font-mono text-2xs text-slate">{priceText(u)} · {speedText(u)}</p>}
                        onRemoved={() => {
                          setConns((xs) => (xs || []).filter((x) => x.id !== c.id));
                          toast.show(`Removed ${c.name}.`);
                          reload();
                        }}
                      />
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-slate">None yet.</p>
              )}
              <div className="mt-3">
                {adding === "service" ? (
                  <AddConnectionForm
                    onCancel={() => setAdding(null)}
                    onAdded={(c) => {
                      setConns((xs) => [...(xs || []), c]);
                      setAdding(null);
                      toast.show(`Added ${c.name}. Pick it on any route.`);
                      reload();
                    }}
                  />
                ) : (
                  <Button size="sm" onClick={() => setAdding("service")}>
                    + Add a service
                  </Button>
                )}
              </div>
            </>
          )}
        </Section>
      )}

      {show("models") && (
        <Section
          id="models"
          title="Your models"
          line="Models trained on your routes' requests. Each can answer on any route; its answers are stored under its route, whichever version answered."
          action={<LinkButton to="/models" size="sm">Models</LinkButton>}
        >
          {loading ? (
            skel
          ) : models.length ? (
            <List>
              {models.map((u) => {
                const p = holdoutPct(u.holdout_agreement);
                return (
                  <Row
                    key={u.id}
                    u={u}
                    extra={
                      <span className="block text-2xs text-slate">
                        trained on{" "}
                        <Link to={`/routes/${encodeURIComponent(u.route || "")}`} className="hover:underline">
                          {u.route_name || routeName(u.route || "")}
                        </Link>
                        {u.trained_rows != null ? ` · ${u.trained_rows.toLocaleString()} requests` : ""}
                        {p != null ? ` · ${pct1(p)} held-out agreement` : ""}
                        {u.used_by?.length ? ` · answers on ${u.used_by.map(routeName).join(", ")}` : ""}
                      </span>
                    }
                  />
                );
              })}
            </List>
          ) : !missing ? (
            <EmptyState title="No trained models yet." body="Train one on a route's requests; it shows up here and in every picker." action={<LinkButton to="/models?train=1" variant="primary">Train a model</LinkButton>} />
          ) : null}
        </Section>
      )}
    </Page>
  );
}

function ProviderLine({ providers }: { providers: Provider[] }) {
  const llm = providers.filter((p) => p.id !== "jev");
  if (!llm.length) return null;
  return (
    <p className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {llm.map((p) => (
        <span key={p.id} className="text-slate">
          {p.name}: {p.connected ? <span className="text-go">connected, {p.key_owner === "ours" ? ourKey(billingOn()) : "your key"}</span> : <span className="text-wait">not connected</span>}
        </span>
      ))}
    </p>
  );
}

function OpenRouterKey({ provider, conn, onChanged }: { provider?: Provider; conn?: Connection; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const toast = useToast();
  const connected = !!provider?.connected;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="font-medium text-ink">OpenRouter key</p>
      <p className="mt-0.5 text-sm text-slate">
        {connected
          ? provider?.key_owner === "ours"
            ? (billingOn() ? "OpenRouter models answer on Dopp's key, billed through your credits." : "OpenRouter models answer on this server's key.")
            : "Connected with your key: OpenRouter bills you directly."
          : "Hundreds of LLMs through one key. Paste yours to let its models answer; OpenRouter bills you directly."}
      </p>
      {connected && conn && provider?.key_owner !== "ours" ? (
        sure ? (
          <span className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-stop">OpenRouter models stop answering until a key is added again.</span>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await deleteConnection(conn.id);
                  toast.show("OpenRouter key removed.");
                  onChanged();
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                  setSure(false);
                }
              }}
            >
              Remove key
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setSure(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <QuietLink tone="danger" className="mt-2" onClick={() => setSure(true)}>
            Remove your key
          </QuietLink>
        )
      ) : !connected ? (
        <>
          <Field label="Key" id="or-key" hint="Stored encrypted; never shown again.">
            <TextInput id="or-key" type="password" autoComplete="off" placeholder="sk-or-…" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Button
            size="sm"
            variant="primary"
            className="mt-2"
            loading={busy}
            disabled={!key.trim()}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await addConnection({ kind: "openrouter", key: key.trim() });
                setKey("");
                toast.show("OpenRouter connected. Its models in your list can answer now.");
                onChanged();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Connect OpenRouter
          </Button>
        </>
      ) : null}
      {err && <p className="mt-2 text-sm text-stop">{err}</p>}
    </div>
  );
}

function OpenAiForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const urlOk = /^https?:\/\/\S+$/.test(url.trim());
  return (
    <div className="mt-2 rounded border border-line p-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-3 sm:grid-cols-2">
        <Field label="Name" id="oai-name">
          <TextInput id="oai-name" value={name} maxLength={40} placeholder="Our vLLM" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Base URL" id="oai-url" error={url && !urlOk ? "Use a full URL, starting with http:// or https://." : undefined}>
          <TextInput id="oai-url" value={url} placeholder="https://llm.example.com/v1" onChange={(e) => setUrl(e.target.value)} />
        </Field>
      </div>
      <Field label="Key" id="oai-key" hint="Sent as Authorization: Bearer …; stored encrypted.">
        <TextInput id="oai-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      {err && <p className="mt-2 text-sm text-stop">{err}</p>}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={!name.trim() || !urlOk || !key}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await addConnection({ kind: "openai", name: name.trim(), url: url.trim(), key });
              onAdded();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Connect {name.trim() || "it"}
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One OpenAI-compatible connection: add a model from it by name (pinned as llm:openai/<connection>/<model>), or remove it. */
function OpenAiModels({ c, have, onChanged }: { c: Connection; have: string[]; onChanged: () => void }) {
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const prefix = `llm:openai/${c.id}/`;
  const mine = have.filter((x) => x.startsWith(prefix));
  return (
    <div className="mt-3 border-t border-line pt-2 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <b className="font-medium text-ink">{c.name}</b>
        <code className="break-all font-mono text-2xs text-slate">{c.url}</code>
        <QuietLink
          tone="danger"
          className="ml-auto"
          onClick={async () => {
            try {
              await deleteConnection(c.id);
              onChanged();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Remove
        </QuietLink>
      </p>
      {mine.length > 0 && <p className="mt-0.5 font-mono text-2xs text-slate">{mine.map((x) => x.slice(prefix.length)).join(", ")}</p>}
      <span className="mt-1 flex flex-wrap gap-2">
        <TextInput aria-label={`Model name on ${c.name}`} className="!w-auto min-w-0 flex-1 text-sm" placeholder="model name, e.g. llama-3.1-8b" value={model} onChange={(e) => setModel(e.target.value)} />
        <Button
          size="sm"
          loading={busy}
          disabled={!model.trim()}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await pinUpstream(prefix + model.trim());
              setModel("");
              onChanged();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Add model
        </Button>
      </span>
      {err && <p className="mt-1 text-stop">{err}</p>}
    </div>
  );
}
