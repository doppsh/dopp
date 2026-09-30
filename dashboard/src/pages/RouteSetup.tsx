/* A route's setup, drawn as the graph it is (components/SetupGraph): request → branch → who answers, in order → reply, every answer
   kept on the stored request, labels a rule over those answers, training off the stored requests. Click a node to change it in the drawer; everything edits a draft, and nothing is saved
   until "Save as setup vN". Every list here comes from GET /api/routes/:id/setup and the upstream catalog; nothing is
   named by hand. Embedded in the route page. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMe } from "../app/AppShell";
import { Button } from "../components/Button";
import { ErrorState, TextArea, TextInput } from "../components/Bits";
import { Drawer } from "../components/Drawer";
import { ChecksEditor, PlanEditor, RouteEditor, SetupSummary } from "../components/SetupEditors";
import { SetupGraph } from "../components/SetupGraph";
import { useToast } from "../components/Toast";
import { describeSetup, getSetup, previewSetup, saveSetup, setupHistory, setupVersion } from "../lib/api";
import { ago, fmtMs, fmtT, num, versionName } from "../lib/domain";
import { useCatalog } from "../lib/upstreams";
import {
  answererOptions,
  backgroundText,
  chainText,
  matchesEverything,
  matchText,
  nameOf,
  newId,
  normalize,
  oracleText,
  planAnswererId,
  problems,
  stableKey,
  usd,
  usedAnswerers,
} from "../lib/setup";
import type { AnswererOption } from "../lib/setup";
import type { Connection, Setup as SetupT, SetupPlan, SetupPreview, SetupRoute, SetupState, SetupVersion, SetupVersionInfo } from "../lib/types";

type DrawerState =
  | { kind: "route"; id: string; focus?: "oracle" }
  | { kind: "plan"; id: string }
  | { kind: "checks" }
  | { kind: "start" }
  | { kind: "history" };

export function SetupSection({ id, name }: { id: string; name: string | null }) {
  const me = useMe();
  const toast = useToast();
  const { upstreams, reload: reloadCatalog } = useCatalog();

  const [state, setState] = useState<SetupState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [draft, setDraftRaw] = useState<SetupT | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // shown in the page, not a toast: which setup is now in force and when it reaches requests; and which starting point the draft holds
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [pickedFrom, setPickedFrom] = useState<string | null>(null);
  // "Describe it": words → a drafted setup, with the reasons for each block
  const [words, setWords] = useState("");
  const [describing, setDescribing] = useState(false);
  const [described, setDescribed] = useState<{ reasons: { block: string; why: string }[]; note: string | null; err: string | null } | null>(null);

  async function describe() {
    const text = words.trim();
    if (!text || !state) return;
    setDescribing(true);
    setDescribed(null);
    setPickedFrom(null);
    try {
      const r = await describeSetup(id, text);
      setDraftRaw(normalize(r.setup, opts));
      setDescribed({ reasons: r.reasons || [], note: r.note, err: null });
    } catch (e) {
      setDescribed({ reasons: [], note: null, err: (e as Error).message });
    } finally {
      setDescribing(false);
    }
  }

  const load = () => {
    setLoadErr(null);
    getSetup(id)
      .then((s) => {
        setState(s);
        setDraftRaw(s.setup);
      })
      .catch((e) => setLoadErr((e as Error).message));
  };
  useEffect(() => {
    setState(null);
    setDraftRaw(null);
    setDrawer(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const latest = state?.latest_version ?? 0;
  const opts = useMemo(() => answererOptions(state, draft, { model: name, latest, catalog: upstreams, routeId: id }), [state, draft, name, latest, upstreams, id]);
  const setDraft = (fn: (d: SetupT) => SetupT) => setDraftRaw((d) => (d ? normalize(fn(d), opts) : d));

  const saved = state?.setup ?? null;
  const savedKey = useMemo(() => (saved ? stableKey(normalize(saved, opts)) : ""), [saved, opts]);
  const draftKey = useMemo(() => (draft ? stableKey(normalize(draft, opts)) : ""), [draft, opts]);
  const dirty = !!draft && !!saved && savedKey !== draftKey;
  const issues = useMemo(() => (draft ? problems(draft) : []), [draft]);
  // a save error is about the draft it was sent with
  useEffect(() => setSaveErr(null), [draftKey]);
  // the saved note stays until the draft changes again
  useEffect(() => {
    if (dirty) setSavedMsg(null);
  }, [dirty]);

  // leaving with unsaved changes asks first
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", f);
    return () => window.removeEventListener("beforeunload", f);
  }, [dirty]);

  // the draft replayed on the last 100 requests, 600 ms after it settles
  const [preview, setPreview] = useState<{ p: SetupPreview | null; err: string | null; busy: boolean }>({ p: null, err: null, busy: false });
  useEffect(() => {
    if (!dirty || !draft || issues.length) {
      setPreview({ p: null, err: null, busy: false });
      return;
    }
    const ctrl = new AbortController();
    setPreview((x) => ({ ...x, busy: true, err: null }));
    const t = setTimeout(() => {
      previewSetup(id, normalize(draft, opts), ctrl.signal)
        .then((p) => setPreview({ p, err: null, busy: false }))
        .catch((e) => !ctrl.signal.aborted && setPreview({ p: null, err: (e as Error).message, busy: false }));
    }, 600);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, dirty, issues.length, id]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const s = await saveSetup(id, normalize(draft, opts), note.trim() || undefined);
      setState(s);
      setDraftRaw(s.setup);
      setNote("");
      setDescribed(null);
      setPickedFrom(null);
      const within = s.applies_within_s ?? state?.applies_within_s;
      setSavedMsg(`Saved as setup v${s.version}${within ? ` · applies to the next request within about ${within} s` : ""}.`);
      // the Training section above counts against the plans; let it re-read them
      window.dispatchEvent(new Event("understudy:setup-saved"));
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function addConnection(c: Connection) {
    setState((s) => (s ? { ...s, connections: [...s.connections.filter((x) => x.id !== c.id), c] } : s));
    toast.show(`Added ${c.name}. Every route on this account can use it.`);
  }

  const who = state?.saved_by ? (me && state.saved_by === me.user.email ? "you" : state.saved_by) : null;

  // which cards differ from the saved setup
  const changedRoute = (r: SetupRoute) => stableKey(r) !== stableKey(saved?.routes.find((x) => x.id === r.id));
  const changedPlan = (p: SetupPlan) => stableKey(p) !== stableKey(saved?.plans.find((x) => x.id === p.id));

  const route = drawer?.kind === "route" ? draft?.routes.find((r) => r.id === drawer.id) : undefined;
  const plan = drawer?.kind === "plan" ? draft?.plans.find((p) => p.id === drawer.id) : undefined;

  // open a route's drawer at its oracle section
  useEffect(() => {
    if (drawer?.kind !== "route" || drawer.focus !== "oracle") return;
    const t = setTimeout(() => document.getElementById(`route-${drawer.id}-oracle`)?.scrollIntoView({ block: "start" }), 30);
    return () => clearTimeout(t);
  }, [drawer]);

  // linked as /routes/<id>#setup (Getting started): bring the setup into view once it has loaded
  const setupRef = useRef<HTMLElement>(null);
  const loaded = !!state;
  useEffect(() => {
    if (loaded && location.hash === "#setup") setupRef.current?.scrollIntoView({ block: "start" });
  }, [loaded]);
  // "#setup-plan=<plan id>" (the Training section's "Change this plan"): open that plan's drawer. The hash is swapped for #setup at
  // once, so the same link works again after the drawer closes.
  const hasDraft = !!draft;
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    if (!loaded || !hasDraft) return;
    const open = () => {
      // "&base=<id>" (the Training section's base picker) also puts that base on the plan, unsaved, for the person to save
      const m = location.hash.match(/^#setup-plan=([^&]+)(?:&base=([^&]+))?$/);
      if (!m) return;
      nav({ hash: "setup" }, { replace: true });
      setupRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      const pid = decodeURIComponent(m[1]);
      if (m[2]) {
        const b = decodeURIComponent(m[2]);
        setDraft((d) => ({ ...d, plans: d.plans.map((p) => (p.id === pid ? { ...p, base: b } : p)) }));
      }
      setDrawer({ kind: "plan", id: pid });
    };
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, hasDraft, loc.key]);

  return (
    <section id="setup" ref={setupRef} aria-labelledby="setup-h" className="mt-8 scroll-mt-20">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="setup-h" className="text-lg font-semibold text-ink">
            Setup
          </h2>
          <p className="mt-0.5 text-sm text-slate">
            What happens when a request comes in: who answers, whose answer is the label, what trains.{" "}
            {state ? (
              <span className="font-mono text-xs">
                setup v{state.version} · saved {ago(state.saved_at)}
                {who ? ` by ${who}` : ""}
                {state.note ? <span className="font-sans text-slate"> · {state.note}</span> : null}
              </span>
            ) : (
              <span className="skel inline-block h-3 w-44 align-middle" />
            )}
          </p>
          {savedMsg && (
            <p role="status" className="mt-1 text-sm text-go">
              {savedMsg}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!state} onClick={() => setDrawer({ kind: "start" })}>
            Start from…
          </Button>
          <Button size="sm" disabled={!state} onClick={() => setDrawer({ kind: "history" })}>
            History
          </Button>
        </div>
      </div>

      <div className="mb-3 rounded-lg border border-line bg-surface p-3">
        <label htmlFor={`describe-${id}`} className="block text-sm font-medium text-ink">
          Describe what this route should do
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-start">
          <TextArea
            id={`describe-${id}`}
            rows={2}
            className="min-w-0 flex-1 font-sans text-base"
            placeholder="e.g. Answer with my model when it's sure, otherwise Jev. Have Gemini also answer 20% in the background. Train every 200."
            value={words}
            disabled={describing}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) describe();
            }}
          />
          <Button variant="secondary" disabled={!state || !words.trim() || describing} onClick={describe} className="shrink-0">
            {describing ? "Drafting…" : "Draft the setup"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-slate" aria-live="polite">
          {describing ? "Turning your words into a setup; this takes a few seconds." : "It becomes an unsaved draft on the board below: check it, see what it would have done to your last requests, then save."}
        </p>
        {described?.err && <p className="mt-2 text-sm text-stop" role="alert">Couldn't draft it: {described.err}</p>}
        {described && !described.err && (
          <div className="mt-2 rounded border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
            <p className="font-medium text-ink">The draft below comes from your words.{dirty ? "" : " It matches the saved setup, so there is nothing to save."}</p>
            {described.reasons.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {described.reasons.map((r, i) => (
                  <li key={i} className="text-ink">
                    <span className="text-slate">{r.block.replace(/^route\b/, "branch")}:</span> Why: {r.why}
                  </li>
                ))}
              </ul>
            )}
            {described.note && <p className="mt-1 text-wait">{described.note}</p>}
          </div>
        )}
      </div>

      {loadErr && (
        <div className="mt-4">
          <ErrorState title="Couldn't load the setup." detail={loadErr} onRetry={load} />
        </div>
      )}

      <div className="mt-4">
        {state && draft ? (
          <SetupGraph
            state={state}
            draft={draft}
            opts={opts}
            changedRoute={changedRoute}
            changedPlan={changedPlan}
            checksChanged={!!saved && draft.checker !== saved.checker}
            open={setDrawer}
            setDraft={setDraft}
            addRoute={() => {
              const last = draft.routes[draft.routes.length - 1];
              const r: SetupRoute = {
                id: newId("r"),
                name: `Branch ${draft.routes.length + 1}`,
                match: { kinds: [], keys: [], sources: [] },
                allow_header: false,
                steps: last ? last.steps.map((s) => ({ ...s })) : [{ ask: "jev", wait_ms: 30000 }],
                background: [],
                oracle: last ? [...last.oracle] : ["jev"],
                fill_pct: 0,
                cache_s: null,
              };
              setDraft((d) => ({ ...d, routes: [...d.routes.slice(0, -1), r, ...d.routes.slice(-1)] }));
              setDrawer({ kind: "route", id: r.id });
            }}
            addPlan={() => {
              const p: SetupPlan = { id: newId("p"), name: `Plan ${draft.plans.length + 1}`, base: state.bases[0]?.id || draft.plans[0]?.base || "laya", epochs: 2, cohort: null, oracle: null, auto: null };
              setDraft((d) => ({ ...d, plans: [...d.plans, p] }));
              setDrawer({ kind: "plan", id: p.id });
            }}
          />
        ) : !loadErr ? (
          <BoardSkeleton />
        ) : null}
      </div>

      {dirty && draft && state && (
        <SaveBar
          nextVersion={state.version + 1}
          preview={preview}
          opts={opts}
          issues={issues}
          oracleNote={oracleChanges(saved!, draft)}
          pickedFrom={pickedFrom}
          note={note}
          setNote={setNote}
          saving={saving}
          saveErr={saveErr}
          onDiscard={() => {
            setDraftRaw(state.setup);
            setSaveErr(null);
            setDescribed(null);
            setPickedFrom(null);
          }}
          onSave={save}
        />
      )}

      {/* ---------- drawers ---------- */}
      {state && draft && (
        <>
          <Drawer
            open={!!route}
            onClose={() => setDrawer(null)}
            title={route ? route.name || "Branch" : ""}
            subtitle={route ? `Branch ${draft.routes.indexOf(route) + 1} of ${draft.routes.length} · ${matchText(route, state)}` : undefined}
            footer={route && <RouteFooter route={route} draft={draft} setDraft={setDraft} close={() => setDrawer(null)} />}
          >
            {route && (
              <RouteEditor
                key={route.id}
                route={route}
                state={state}
                options={opts}
                onConnectionAdded={addConnection}
                onCatalogChanged={reloadCatalog}
                onChange={(r) => setDraft((d) => ({ ...d, routes: d.routes.map((x) => (x.id === r.id ? r : x)) }))}
              />
            )}
          </Drawer>

          <Drawer
            open={!!plan}
            onClose={() => setDrawer(null)}
            title={plan ? plan.name || "Plan" : ""}
            subtitle="A training plan: which requests, which base, whose answers they learn, and when."
            footer={plan && <PlanFooter plan={plan} draft={draft} opts={opts} setDraft={setDraft} close={() => setDrawer(null)} />}
          >
            {plan && (
              <PlanEditor
                key={plan.id}
                projectId={id}
                plan={plan}
                state={state}
                options={opts}
                modelLabel={versionName(name, latest)}
                defaultOracle={draft.routes[draft.routes.length - 1]?.oracle || []}
                onChange={(p) => setDraft((d) => ({ ...d, plans: d.plans.map((x) => (x.id === p.id ? p : x)) }))}
              />
            )}
          </Drawer>

          <Drawer open={drawer?.kind === "checks"} onClose={() => setDrawer(null)} title="Checks" footer={<Button variant="primary" onClick={() => setDrawer(null)}>Done</Button>}>
            <ChecksEditor setup={draft} options={opts} onChange={(s) => setDraft(() => s)} />
          </Drawer>

          <Drawer
            open={drawer?.kind === "start"}
            onClose={() => setDrawer(null)}
            title="Start from…"
            subtitle={
              dirty
                ? "Picking one replaces the changes you haven't saved. Nothing changes for your requests until you save."
                : "Picking one puts it on the board, where you can change anything. Nothing changes for your requests until you save."
            }
          >
            <StartFrom
              routeId={id}
              state={state}
              opts={opts}
              dirty={dirty}
              savedKey={savedKey}
              draftKey={draftKey}
              onPick={(s, name) => {
                setDraftRaw(normalize(s, opts));
                setDrawer(null);
                // said in the save bar, not a toast: a toast sits bottom right, over the Save button (nothing to say when it's the saved setup)
                setPickedFrom(stableKey(normalize(s, opts)) === savedKey ? null : name);
              }}
            />
          </Drawer>

          <Drawer open={drawer?.kind === "history"} onClose={() => setDrawer(null)} title="History" subtitle="Every save is a version. Open one to see it, or restore it into your draft.">
            {drawer?.kind === "history" && (
              <History
                projectId={id}
                state={state}
                opts={opts}
                me={me?.user.email || null}
                onRestore={(v) => {
                  setDraftRaw(normalize(v.setup, opts));
                  setDrawer(null);
                  setPickedFrom(`setup v${v.version}`);
                }}
              />
            )}
          </Drawer>
        </>
      )}
    </section>
  );
}

/* ---------- the board ---------- */

function BoardSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] rounded-lg border border-line bg-paper min-[900px]:grid-cols-4" aria-busy="true">
      {[3, 2, 2, 2].map((n, i) => (
        <div key={i} className={`space-y-2 border-line p-3 ${i < 3 ? "border-b min-[900px]:border-b-0 min-[900px]:border-r" : ""}`}>
          <span className="skel h-3 w-24" />
          {Array.from({ length: n }).map((_, j) => (
            <div key={j} className="h-[58px] rounded border border-line bg-surface p-2.5">
              <span className="skel h-3 w-1/2" />
              <span className="skel mt-2 h-2.5 w-4/5" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- drawer footers ---------- */

function RouteFooter({ route, draft, setDraft, close }: { route: SetupRoute; draft: SetupT; setDraft: (fn: (d: SetupT) => SetupT) => void; close: () => void }) {
  const i = draft.routes.indexOf(route);
  const n = draft.routes.length;
  const isLast = i === n - 1;
  const [sure, setSure] = useState(false);
  const why = n === 1 ? "Every request needs a branch, so the only one stays. Change it instead." : isLast && matchesEverything(route) ? "The last branch takes every request the others don't, so it stays. Change it instead." : null;
  const move = (d: number) => setDraft((s) => {
    const xs = [...s.routes];
    [xs[i], xs[i + d]] = [xs[i + d], xs[i]];
    return { ...s, routes: xs };
  });
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button size="sm" variant="quiet" disabled={i === 0} onClick={() => move(-1)}>
        Move up
      </Button>
      <Button size="sm" variant="quiet" disabled={isLast} onClick={() => move(1)}>
        Move down
      </Button>
      {sure ? (
        <span className="flex items-center gap-2">
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              close();
              setDraft((s) => ({ ...s, routes: s.routes.filter((r) => r.id !== route.id) }));
            }}
          >
            Delete {route.name}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setSure(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="danger" disabled={!!why} title={why || undefined} onClick={() => setSure(true)}>
          Delete branch
        </Button>
      )}
      <Button variant="primary" className="ml-auto" onClick={close}>
        Done
      </Button>
      {why && <p className="w-full text-xs text-slate">{why}</p>}
    </div>
  );
}

function PlanFooter({ plan, draft, opts, setDraft, close }: { plan: SetupPlan; draft: SetupT; opts: AnswererOption[]; setDraft: (fn: (d: SetupT) => SetupT) => void; close: () => void }) {
  const [sure, setSure] = useState(false);
  const aid = planAnswererId(plan);
  const usedBy = draft.routes.filter((r) => usedAnswerers({ ...draft, routes: [r], plans: [], checker: "" }).has(aid)).map((r) => r.name);
  const why =
    draft.plans.length === 1
      ? "Keep at least one plan."
      : usedBy.length
        ? `${nameOf(aid, opts)} answers in ${usedBy.join(", ")}. Change ${usedBy.length === 1 ? "that branch" : "those branches"} first.`
        : draft.checker === aid
          ? `${nameOf(aid, opts)} runs the checks. Pick another checker first.`
          : null;
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      {sure ? (
        <span className="flex items-center gap-2">
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              close();
              setDraft((s) => ({ ...s, plans: s.plans.filter((p) => p.id !== plan.id) }));
            }}
          >
            Delete {plan.name}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setSure(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="danger" disabled={!!why} title={why || undefined} onClick={() => setSure(true)}>
          Delete plan
        </Button>
      )}
      <Button variant="primary" className="ml-auto" onClick={close}>
        Done
      </Button>
      {why && <p className="w-full text-xs text-slate">{why}</p>}
    </div>
  );
}

/* ---------- save bar ---------- */

/** Branches whose "who is right" changed: saving re-picks what their past requests train on. */
function oracleChanges(saved: SetupT, draft: SetupT): string | null {
  const names = draft.routes.filter((r) => {
    const s = saved.routes.find((x) => x.id === r.id);
    return s && stableKey(s.oracle) !== stableKey(r.oracle);
  }).map((r) => r.name);
  if (!names.length) return null;
  return `Saving re-picks the answer past requests of ${names.join(", ")} train on, from the new "who is right".`;
}

function previewLine(p: SetupPreview, opts: AnswererOption[]): string {
  if (!p.n) return "No requests yet to replay this on.";
  const name = (id: string) => (id === "nobody" ? "nobody" : nameOf(id, opts));
  const by = Object.entries(p.by_answerer).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const parts = by.map(([id, n], i) => (i === 0 ? `${num(n)} answered by ${name(id)}` : `${num(n)} by ${name(id)}`));
  const bg = Object.entries(p.background_by_answerer || {}).filter(([, n]) => n > 0);
  const tail = [
    p.est_cost_per_1000 != null ? `est. ${usd(p.est_cost_per_1000)} per 1,000` : null,
    p.est_p50_ms != null ? `p50 ${fmtMs(p.est_p50_ms)}` : null,
  ].filter(Boolean);
  return (
    `Of your last ${num(p.n)} requests: ${parts.join(", ")}` +
    (bg.length ? ` · also asked in the background: ${bg.map(([id, n]) => `${name(id)} on ${num(n)}`).join(", ")}` : "") +
    (tail.length ? ` · ${tail.join(" · ")}` : "")
  );
}

function SaveBar({
  nextVersion,
  preview,
  opts,
  issues,
  oracleNote,
  pickedFrom,
  note,
  setNote,
  saving,
  saveErr,
  onDiscard,
  onSave,
}: {
  nextVersion: number;
  preview: { p: SetupPreview | null; err: string | null; busy: boolean };
  opts: AnswererOption[];
  issues: string[];
  oracleNote: string | null;
  pickedFrom: string | null;
  note: string;
  setNote: (s: string) => void;
  saving: boolean;
  saveErr: string | null;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-30 -mx-4 mt-6 border-t border-line bg-surface px-4 py-3 nav:-mx-6 nav:px-6" role="region" aria-label="Unsaved changes">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <b className="text-base font-medium text-ink">Unsaved changes</b>
        <span className="min-w-0 text-sm text-slate" aria-live="polite">
          {issues.length
            ? "Fix the points below to see what this would do."
            : preview.busy
              ? "Replaying your last requests through this…"
              : preview.err
                ? `Couldn't preview: ${preview.err}`
                : preview.p
                  ? previewLine(preview.p, opts)
                  : null}
        </span>
      </div>
      {issues.length > 0 && (
        <ul className="mt-1.5 list-disc pl-5 text-sm text-stop">
          {issues.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {pickedFrom && <p className="mt-1 text-sm text-ink">The board now shows “{pickedFrom}”, not saved yet. Nothing changes for your requests until you save it.</p>}
      {oracleNote && <p className="mt-1 text-sm text-wait">{oracleNote}</p>}
      {saveErr && (
        <p className="mt-1.5 text-sm text-stop" role="alert">
          Not saved: {saveErr}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TextInput aria-label="Note for this version" className="min-w-0 flex-1 basis-56 text-sm" placeholder="Note (optional): what changed and why" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        <Button variant="quiet" onClick={onDiscard}>
          Discard
        </Button>
        <Button variant="primary" loading={saving} disabled={issues.length > 0} onClick={onSave}>
          Save as setup v{nextVersion}
        </Button>
      </div>
    </div>
  );
}

/* ---------- start from ---------- */

/** Starting points. With nothing unsaved, "Use this" puts one on the board at once (there is nothing to lose); with unsaved
    changes it asks first. The one that matches the saved setup says so instead of offering itself. */
function StartFrom({
  routeId,
  state,
  opts,
  dirty,
  savedKey,
  draftKey,
  onPick,
}: {
  routeId: string;
  state: SetupState;
  opts: AnswererOption[];
  dirty: boolean;
  savedKey: string;
  draftKey: string;
  onPick: (s: SetupT, name: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const versionReady = opts.some((o) => o.isVersion && o.ready && o.group === "This route's models");
  if (!state.presets.length) return <p className="text-sm text-slate">No starting points on this server yet.</p>;
  return (
    <ul className="space-y-2">
      {state.presets.map((p) => {
        const blocked = p.needs && !versionReady;
        const key = stableKey(normalize(p.setup, opts));
        const inUse = key === savedKey;
        const onBoard = dirty && key === draftKey;
        return (
          <li key={p.id} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <b className="text-base font-medium text-ink">{p.name}</b>
              {inUse && !dirty ? (
                <span className="rounded border border-go/40 bg-go-soft px-1.5 py-0.5 text-xs text-ink">What this route runs now</span>
              ) : onBoard ? (
                <span className="rounded border border-wait/40 bg-wait-soft px-1.5 py-0.5 text-xs text-ink">On the board, not saved</span>
              ) : (
                pending !== p.id && (
                  <Button size="sm" disabled={!!blocked} title={blocked ? `Needs ${p.needs}` : undefined} onClick={() => (dirty ? setPending(p.id) : onPick(p.setup, p.name))}>
                    {inUse ? "Go back to this" : "Use this"}
                  </Button>
                )
              )}
            </div>
            <p className="mt-0.5 text-sm text-slate">{p.summary}</p>
            {blocked && (
              <p className="mt-1 text-xs text-wait">
                Needs {p.needs}.{" "}
                <Link to={`/models?route=${encodeURIComponent(routeId)}&train=1`} className="underline underline-offset-2 hover:text-ink">
                  Train one
                </Link>{" "}
                first.
              </p>
            )}
            <div className="mt-2 space-y-0.5 font-mono text-xs text-slate">
              {p.setup.routes.map((r) => (
                <p key={r.id}>
                  <span className="text-ink">{r.name}</span>: {chainText(r, opts)}
                  {r.background.length > 0 && ` · background: ${backgroundText(r, opts)}`} · who is right: {oracleText(r.oracle, opts)}
                </p>
              ))}
            </div>
            {pending === p.id && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-line bg-panel px-2.5 py-2 text-sm">
                <span className="text-ink">{inUse ? "This drops the changes you haven't saved and goes back to the saved setup." : "This replaces the changes you haven't saved."}</span>
                <Button size="sm" variant="primary" onClick={() => onPick(p.setup, p.name)}>
                  {inUse ? "Drop my changes" : "Replace my changes"}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => setPending(null)}>
                  Keep my changes
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- history ---------- */

function History({ projectId, state, opts, me, onRestore }: { projectId: string; state: SetupState; opts: AnswererOption[]; me: string | null; onRestore: (v: SetupVersion) => void }) {
  const [list, setList] = useState<SetupVersionInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<SetupVersion | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    setupHistory(projectId)
      .then((xs) => live.current && setList(xs))
      .catch((e) => live.current && setErr((e as Error).message));
    return () => {
      live.current = false;
    };
  }, [projectId, state.version]);
  if (err) return <ErrorState title="Couldn't load the history." detail={err} />;
  if (!list)
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <span key={i} className="skel h-9 w-full" />
        ))}
      </div>
    );
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {list.map((v) => (
        <li key={v.version} className="px-3 py-2">
          <button
            type="button"
            className="flex w-full flex-wrap items-baseline gap-x-3 text-left"
            aria-expanded={open?.version === v.version}
            onClick={async () => {
              if (open?.version === v.version) return setOpen(null);
              setOpening(v.version);
              try {
                setOpen(await setupVersion(projectId, v.version));
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setOpening(null);
              }
            }}
          >
            <span className="font-mono text-sm font-medium text-ink">setup v{v.version}</span>
            {v.version === state.version && <span className="text-xs text-go">in use</span>}
            <span className="text-sm text-slate">
              {fmtT(v.saved_at)}
              {v.saved_by ? ` · ${me && v.saved_by === me ? "you" : v.saved_by}` : ""}
            </span>
            {opening === v.version && <span className="text-xs text-slate">opening…</span>}
            {v.note && <span className="w-full text-sm text-ink">{v.note}</span>}
          </button>
          {open?.version === v.version && (
            <div className="mt-2 space-y-2">
              <SetupSummary setup={open.setup} state={state} options={opts} />
              <Button size="sm" onClick={() => onRestore(open)}>
                Restore setup v{v.version} into your draft
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

