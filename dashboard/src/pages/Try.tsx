/* Try it: the playground. One request, asked of any answerer this model has: Jev, the version on our servers, your
   endpoints, and (run in this tab) any version with browser weights or base Laya. Answers sit side by side with their
   times. A run on the server is saved as a request tagged "playground", so it shows up on Requests and can train
   later like any other; in-browser answers are shown here only. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { AnswererPicker, useAnswerers } from "../components/Answerers";
import { Button, QuietLink } from "../components/Button";
import { ErrorState, TextArea } from "../components/Bits";
import { WordsByAnswerer, tint } from "../components/Chunks";
import { Answer, answerOf } from "../components/Example";
import { Panel } from "../components/Panel";
import { QuestionsEditor } from "../components/QuestionsEditor";
import { fetchExample, fetchExamples, refreshCredits, tryRequest } from "../lib/api";
import {
  ago,
  bySize,
  chunkDef,
  chunkSource,
  displayAnswer,
  fmtMs,
  isChunkSet,
  labelValue,
  modelName,
  optionsOf,
  paletteOf,
  parseQuestions,
  setName,
  sourceTag,
  spansOf,
  stateText,
  versionName,
  versionOfWire,
  wireToRaw,
  wordQuestions, piecesOf, relistPieces } from "../lib/domain";
import { layaState, loadLaya, predictLabels, useLaya } from "../lib/layaWeb";
import { useProject } from "../lib/project";
import { useCatalog } from "../lib/upstreams";
import type { Ans, Answerer, Example, Questions, QuestionSet } from "../lib/types";

type Col = {
  key: string;
  name: string;
  where: Answerer["where"];
  status: "asking" | "done" | "error";
  started: number;
  ms?: number;
  answers?: Record<string, Ans>;
  error?: string;
};

const EVERYONE = "everyone";
const CUSTOM = "__custom";

/** Where the words live in a per-word kind's state: the string state itself, or one text field of it. */
function textFieldOf(state: unknown, set?: QuestionSet, ex?: Example | null): string | null {
  if (typeof state === "string") return "";
  if (!state || typeof state !== "object") return null;
  const o = state as Record<string, unknown>;
  for (const f of [set?.plan?.seed_field, set?.recipe?.text_field]) if (f && typeof o[f] === "string") return f;
  const t = chunkSource(state, set, ex?.chunks);
  const hit = t != null ? Object.entries(o).find(([, v]) => v === t) : null;
  if (hit) return hit[0];
  const longest = Object.entries(o).filter(([, v]) => typeof v === "string").sort((a, b) => String(b[1]).length - String(a[1]).length)[0];
  return longest ? longest[0] : null;
}

export default function Try() {
  const { id = "" } = useParams();
  const { data: proj, error: projErr, reload } = useProject(id);
  const [params] = useSearchParams();
  const own = useAnswerers(proj);
  const { upstreams } = useCatalog();
  // every ready upstream in the catalog can be asked too (this route's own model is already "model" above)
  const answerers = useMemo(() => {
    const extra: Answerer[] = (upstreams || [])
      .filter((u) => u.ready && !own.server.some((a) => a.key === u.id) && !(u.kind === "model" && u.route === id) && !(u.kind === "jev"))
      .map((u) => ({ key: u.id, name: u.name, where: "server" as const }));
    const server = [...own.server, ...extra];
    // "everyone" means this route's own answerers; other upstreams (other routes' models wake a GPU) only when picked
    return { ...own, server, everyone: own.server, all: [...server, ...own.browser] };
  }, [own, upstreams, id]);
  const sets = useMemo(() => bySize((proj?.question_sets ?? []).filter((s) => !s.archived)), [proj]);
  const base = `/routes/${encodeURIComponent(id)}`;
  const reqLink = `/requests?route=${encodeURIComponent(id)}&source=typed`;
  const name = modelName(proj?.project.name) || "your model";

  const [schema, setSchema] = useState<string>("");
  const set = sets.find((s) => s.id === schema);
  const chunky = isChunkSet(set);

  // the request being tried: its state, and for per-word kinds the text inside it and the questions for its words
  const [stateText_, setStateText] = useState("");
  const [words, setWords] = useState("");
  const [wordsField, setWordsField] = useState<string | null>(null);
  const [baseState, setBaseState] = useState<unknown>(null);
  const [ownQuestions, setOwnQuestions] = useState<Questions | null>(null);
  const [ownFor, setOwnFor] = useState<string>("");
  const [editQ, setEditQ] = useState(false);
  const [qText, setQText] = useState("");
  const [recent, setRecent] = useState<Example[] | null>(null);
  const [startId, setStartId] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  /* ---------- starting points ---------- */

  const startFrom = useCallback(
    (ex: Example | null, s?: QuestionSet) => {
      setCols({});
      setSaved(null);
      setErr(null);
      if (!ex) {
        setStartId("");
        setBaseState(null);
        setStateText("");
        setWords("");
        setWordsField(isChunkSet(s) ? "" : null);
        setOwnQuestions(null);
        setOwnFor("");
        return;
      }
      setStartId(ex.id);
      setBaseState(ex.state);
      setStateText(typeof ex.state === "string" ? ex.state : JSON.stringify(ex.state, null, 2));
      if (isChunkSet(s)) {
        const f = textFieldOf(ex.state, s, ex);
        setWordsField(f);
        const t = f === "" ? String(ex.state) : f ? String((ex.state as Record<string, unknown>)[f] ?? "") : "";
        setWords(t);
        setOwnQuestions(ex.question_defs || null);
        setOwnFor(t);
      } else {
        setWordsField(null);
        setOwnQuestions(null);
        setOwnFor("");
      }
    },
    [],
  );

  // pick the kind: the one ?from= belongs to, else the biggest
  const from = params.get("from");
  useEffect(() => {
    if (!sets.length || schema) return;
    if (!from) return setSchema(sets[0].id);
    fetchExample(id, from)
      .then((ex) => {
        const s = ex ? sets.find((x) => x.id === ex.schema) : undefined;
        setSchema(s ? s.id : sets[0].id);
        if (ex && s) {
          startFrom(ex, s);
          setStartId(ex.id);
        }
      })
      .catch(() => setSchema(sets[0].id));
  }, [sets, schema, from, id, startFrom]);

  // the kind's latest requests to start from; the newest is loaded unless we came with ?from=
  const loadedFrom = useRef(false);
  useEffect(() => {
    if (!schema || schema === CUSTOM) {
      setRecent([]);
      return;
    }
    let live = true;
    setRecent(null);
    fetchExamples(id, `schema=${encodeURIComponent(schema)}&limit=12&offset=0`)
      .then((r) => {
        if (!live) return;
        setRecent(r.calls);
        const s = sets.find((x) => x.id === schema);
        if (from && !loadedFrom.current) {
          loadedFrom.current = true;
          return;
        }
        startFrom(r.calls[0] || null, s);
      })
      .catch(() => live && setRecent([]));
    return () => {
      live = false;
    };
  }, [id, schema, sets, from, startFrom]);

  /* ---------- what gets asked ---------- */

  const parsedState: { ok: true; value: unknown } | { ok: false; error: string } = useMemo(() => {
    if (chunky && wordsField != null) {
      if (wordsField === "") return { ok: true, value: words };
      const obj = baseState && typeof baseState === "object" ? { ...(baseState as Record<string, unknown>) } : {};
      obj[wordsField] = words;
      // other fields that list the pieces of the old text (a "c0|word" listing, for instance) are rebuilt for the new text
      if (set && words !== ownFor) {
        const oldPieces = piecesOf(ownQuestions), newPieces = piecesOf(wordQuestions(set, words));
        for (const [k, v] of Object.entries(obj)) {
          if (k === wordsField || typeof v !== "string" || !oldPieces.length) continue;
          const again = relistPieces(v, oldPieces, newPieces);
          if (again != null) obj[k] = again;
        }
      }
      return { ok: true, value: obj };
    }
    const t = stateText_;
    if (/^\s*[[{]/.test(t)) {
      try {
        return { ok: true, value: JSON.parse(t) };
      } catch (e) {
        return { ok: false, error: `That looks like JSON but isn't valid: ${(e as Error).message}` };
      }
    }
    return { ok: true, value: t };
  }, [chunky, wordsField, words, baseState, stateText_, set, ownFor, ownQuestions]);
  /** fields of the state that still describe the previous text because their format couldn't be read */
  const staleFields = useMemo(() => {
    if (!chunky || wordsField == null || !set || words === ownFor || !parsedState.ok || !parsedState.value || typeof parsedState.value !== "object") return [];
    const oldPieces = piecesOf(ownQuestions); if (oldPieces.length < 2) return [];
    return Object.entries(parsedState.value as Record<string, unknown>).filter(([k, v]) => k !== wordsField && typeof v === "string" && oldPieces.slice(0, 3).every((p) => (v as string).includes(p)) && !piecesOf(wordQuestions(set, words)).slice(0, 3).every((p) => (v as string).includes(p))).map(([k]) => k);
  }, [chunky, wordsField, set, words, ownFor, parsedState, ownQuestions]);

  const questions: Questions | null = useMemo(() => {
    if (editQ || schema === CUSTOM) {
      const c = qText.trim() ? parseQuestions(qText) : null;
      return c && c.ok ? c.questions : null;
    }
    if (!set) return null;
    if (chunky) return ownQuestions && words === ownFor ? ownQuestions : wordQuestions(set, words);
    return set.question_defs || null;
  }, [editQ, schema, qText, set, chunky, ownQuestions, words, ownFor]);

  const input = JSON.stringify([parsedState.ok ? parsedState.value : null, questions]);
  // new input: the old answers no longer apply
  const lastInput = useRef(input);
  useEffect(() => {
    if (lastInput.current !== input) {
      lastInput.current = input;
      setCols({});
      setSaved(null);
    }
  }, [input]);

  /* ---------- asking ---------- */

  const [cols, setCols] = useState<Record<string, Col>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [ask, setAsk] = useState<string>(EVERYONE);
  const [asQuestions, setAsQuestions] = useState(false);   // per-word kinds: the coloured text, or the questions and answers one by one
  const [, tick] = useState(0);
  const busy = Object.values(cols).some((c) => c.status === "asking");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const pickedBrowser = answerers.browser.find((a) => a.key === ask);
  const pickedState = useLaya(pickedBrowser?.base || "");
  const setCol = (k: string, c: Partial<Col>) => setCols((cs) => ({ ...cs, [k]: { ...(cs[k] as Col), ...c } }));

  async function run() {
    if (!parsedState.ok || !questions) return;
    const state = parsedState.value;
    const server = ask === EVERYONE ? answerers.everyone : answerers.server.filter((a) => a.key === ask);
    const browser = ask === EVERYONE ? answerers.browser.filter((a) => a.base && isReady(a.base)) : answerers.browser.filter((a) => a.key === ask);
    const now = Date.now();
    setErr(null);
    setCols((cs) => {
      const next = { ...cs };
      for (const a of [...server, ...browser]) next[a.key] = { key: a.key, name: a.name, where: a.where, status: "asking", started: now };
      return next;
    });
    await Promise.all([askServer(server, state, questions), ...browser.map((a) => askBrowser(a, state, questions))]);
  }

  async function askServer(server: Answerer[], state: unknown, qs: Questions) {
    if (!server.length) return;
    const [first, ...rest] = server;
    const t0 = performance.now();
    let exId: string | undefined;
    try {
      const r = await tryRequest(id, { state, questions: qs, target: first.key, compare: rest.map((a) => a.key) });
      const answers: Record<string, Ans> = {};
      for (const [q, a] of Object.entries(r.answers || {})) answers[q] = wireToRaw(a);
      const v = versionOfWire(r.model);
      const served = r.understudy?.served || first.key;
      const fb = r.understudy?.fallback;
      const who = served === first.key ? first.name : served === "model" ? versionName(proj?.project.name, v) : served === "jev" ? "Jev" : served;
      setCol(first.key, {
        status: "done",
        ms: Math.round(performance.now() - t0),
        answers,
        name: first.key === "model" && v ? versionName(proj?.project.name, v) : first.name,
        error: fb ? `${first.name} gave ${fb.reason}; ${who} answered instead` : undefined,
      });
      exId = r.understudy?.example || r.example_id || r.id;
      if (exId) setSaved(exId);
      void refreshCredits(id);
    } catch (e) {
      setCol(first.key, { status: "error", error: (e as Error).message, ms: Math.round(performance.now() - t0) });
    }
    if (!rest.length) return;
    if (!exId) {
      for (const a of rest) setCol(a.key, { status: "error", error: "Not asked: the first answer failed, so there was no request to add it to." });
      return;
    }
    // the others answer the same request after the response; watch the saved request until each one lands
    const until = Date.now() + 150_000;
    let left = rest.map((a) => a.key);
    while (left.length && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 2000));
      const ex = await fetchExample(id, exId).catch(() => null);
      if (!ex) continue;
      for (const k of [...left]) {
        const got = Object.fromEntries(ex.questions.map((q) => [q, answerOf(ex, k, q)]).filter(([, a]) => a)) as Record<string, Ans>;
        if (Object.keys(got).length) {
          setCol(k, { status: "done", answers: got, ms: ex.ms?.[k] ?? undefined });
          left = left.filter((x) => x !== k);
        } else if (ex.errors?.[k]) {
          setCol(k, { status: "error", error: `HTTP ${ex.errors[k]}`, ms: ex.ms?.[k] ?? undefined });
          left = left.filter((x) => x !== k);
        }
      }
    }
    for (const k of left) setCol(k, { status: "error", error: "No answer after 2½ minutes. If it arrives, it shows on this request in Requests." });
  }

  async function askBrowser(a: Answerer, state: unknown, qs: Questions) {
    try {
      await loadLaya(a.base!);
      const t0 = performance.now();
      const labels = await predictLabels(a.base!, state, qs);
      const answers = Object.fromEntries(Object.entries(labels).map(([q, l]) => [q, { answer: l.label, p: l.p, dist: l.dist }]));
      setCol(a.key, { status: "done", answers, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      setCol(a.key, { status: "error", error: msg || "The model in this browser failed without saying why. Reload the page and load it again." });
    }
  }

  /* ---------- view ---------- */

  const serving = proj?.model?.serving;
  const colList = Object.values(cols);
  const ref = cols.jev?.status === "done" ? cols.jev : colList.find((c) => c.status === "done") || null;
  const qids = Object.keys(questions || {});
  const opts = chunky && set ? optionsOf(chunkDef(set)) : [];
  const palette = paletteOf(opts);
  const spans = chunky && questions ? spansOf(words, questions) : [];
  const askName = ask === EVERYONE ? "everyone" : answerers.all.find((a) => a.key === ask)?.name || ask;
  const cantAsk = !parsedState.ok || !questions || !(chunky ? words.trim() : stateText_.trim()) || (!!pickedBrowser && pickedState.status === "loading");

  return (
    <Page>
      <PageHeader
        title="Try a request"
        breadcrumb={
          <>
            <Link to="/routes" className="hover:underline">Routes</Link> /{" "}
            <Link to={base} className="hover:underline">{proj ? name : "…"}</Link>
          </>
        }
        description={<>Ask any upstream about one request on {proj ? <b className="font-medium text-ink">{name}</b> : "this route"}, side by side.</>}
        details={
          <>
            A run on the server is saved to{" "}
            <Link to={reqLink} className="text-accent hover:underline">
              Requests
            </Link>{" "}
            tagged "playground", like any other request. Answers from this browser stay on this page. Asking Jev costs a fraction of a cent.
          </>
        }
      />

      {projErr && !proj && (
        <div className="mt-4">
          <ErrorState detail={projErr} onRetry={reload} />
        </div>
      )}

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="The request">
          {!proj ? (
            <div className="space-y-2">
              <span className="skel h-4 w-1/3" />
              <span className="skel h-28 w-full" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {(sets.length > 1 || !sets.length) && (
                  <label className="flex items-center gap-2">
                    <span className="text-slate">Kind of request</span>
                    <select
                      className="min-w-0 max-w-[280px] rounded border border-line bg-surface px-2 py-1 text-sm"
                      value={schema}
                      onChange={(e) => {
                        setSchema(e.target.value);
                        setEditQ(false);
                      }}
                    >
                      {sets.map((s) => (
                        <option key={s.id} value={s.id}>
                          {setName(s)}
                        </option>
                      ))}
                      <option value={CUSTOM}>Other questions (paste them)</option>
                    </select>
                  </label>
                )}
                {schema !== CUSTOM && (
                  <label className="flex min-w-0 items-center gap-2">
                    <span className="text-slate">Start from</span>
                    <select
                      className="min-w-0 max-w-[340px] rounded border border-line bg-surface px-2 py-1 text-sm"
                      value={startId}
                      disabled={!recent}
                      onChange={(e) => startFrom(recent?.find((x) => x.id === e.target.value) || null, set)}
                    >
                      <option value="">{recent === null ? "Loading…" : "a blank request"}</option>
                      {(recent || []).map((x) => (
                        <option key={x.id} value={x.id}>
                          {ago(x.t)} · {sourceTag(x)} · {(chunky ? chunkSource(x.state, set, x.chunks) ?? stateText(x.state) : stateText(x.state)).slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              {chunky && wordsField != null ? (
                <div className="mt-3">
                  <label htmlFor="try-words" className="mb-1 block text-base font-medium text-ink">
                    Text <span className="font-normal text-slate">· every word is asked about: {opts.join(" · ")}</span>
                  </label>
                  <TextArea id="try-words" rows={6} className="font-sans text-base" value={words} onChange={(e) => setWords(e.target.value)} placeholder="e.g. Please call Dana Whitfield at 415-555-0199 about invoice 8831." />
                  <p className="mt-1 text-xs text-slate">
                    {staleFields.length > 0 && <span className="block text-wait">The {staleFields.join(", ")} field still describes the previous text; its format couldn't be read, so answers may not match. Start from a blank request to avoid that.</span>}
                    {ownQuestions && words === ownFor
                      ? "Asked word by word exactly as your app asked."
                      : `Split into ${plural(spans.length || qids.length, "word")} on spaces. Your app may split differently.`}
                    {wordsField ? ` The text goes in the request's "${wordsField}" field; the rest of it is unchanged.` : ""}
                  </p>
                </div>
              ) : (
                <div className="mt-3">
                  <label htmlFor="try-state" className="mb-1 block text-base font-medium text-ink">
                    State <span className="font-normal text-slate">· text, or JSON</span>
                  </label>
                  <TextArea
                    id="try-state"
                    rows={7}
                    value={stateText_}
                    onChange={(e) => setStateText(e.target.value)}
                    placeholder="e.g. The deck arrived cracked. I want a replacement, not a refund."
                  />
                  {!parsedState.ok && <p className="mt-1 text-sm text-stop">{parsedState.error}</p>}
                </div>
              )}

              <div className="mt-3">
                {editQ || schema === CUSTOM ? (
                  <>
                    <QuestionsEditor id="try-q" value={qText} onChange={setQText} rows={8} />
                    <p className="mt-1 text-xs text-slate">Questions that don't match an existing kind start a new kind of request on this route.</p>
                    {schema !== CUSTOM && (
                      <QuietLink className="mt-1" onClick={() => setEditQ(false)}>
                        Use this kind's questions again
                      </QuietLink>
                    )}
                  </>
                ) : chunky ? null : (
                  <>
                    <p className="text-base font-medium text-ink">Questions</p>
                    <ul className="mt-1 space-y-0.5 text-sm">
                      {Object.entries(questions || {}).map(([q, d]) => (
                        <li key={q} className="flex flex-wrap gap-x-2">
                          <code className="font-mono text-ink">{q}</code>
                          <span className="text-slate">{optionsOf(d).map((o, i) => displayAnswer(d, labelValue(d, o, i))).join(" · ")}</span>
                        </li>
                      ))}
                    </ul>
                    <QuietLink
                      className="mt-1"
                      onClick={() => {
                        setQText(JSON.stringify(questions || {}, null, 2));
                        setEditQ(true);
                      }}
                    >
                      Edit questions
                    </QuietLink>
                  </>
                )}
              </div>
            </>
          )}
        </Panel>

        <Panel title="Ask">
          <div className="flex flex-col gap-3">
            <AnswererPicker
              id="try-ask"
              preparing={answerers.preparing}
              label="Ask"
              value={ask}
              onChange={setAsk}
              extra={[{ key: EVERYONE, name: "Everyone on this route" }]}
              groups={[
                { label: "This route", items: answerers.everyone },
                { label: "Other upstreams", items: answerers.server.filter((a) => !answerers.everyone.includes(a)) },
                { label: "In this browser", items: answerers.browser },
              ]}
            />
            <p className="text-sm text-slate">
              {ask === EVERYONE
                ? `${answerers.everyone.map((a) => a.name).join(", ")}${readyNames(answerers.browser).length ? `, and ${readyNames(answerers.browser).join(", ")}` : ""}. Pick any other upstream from the list to ask it alone, or load a model in this browser to add it.`
                : pickedBrowser
                  ? "Runs on your GPU in this tab. Nothing is sent anywhere."
                  : ask === "model"
                    ? "This route's model, hosted on your Modal account, the way your app would get it."
                    : ask === "jev"
                      ? "TypeSafe's model."
                      : "Asked through this server the way your app's requests would be."}
            </p>
            {answerers.server.some((a) => a.key === "model") && serving && (ask === EVERYONE || ask === "model") && (
              <p className={`text-sm ${serving.awake ? "text-go" : "text-wait"}`}>
                {serving.awake
                  ? `${answerers.server.find((a) => a.key === "model")!.name} is awake: it answers in under a second.`
                  : `${answerers.server.find((a) => a.key === "model")!.name} is asleep: its first answer takes about ${serving.wake_seconds} s while it wakes up.`}
              </p>
            )}
            {!proj?.model?.version && <p className="text-sm text-slate">This route has no trained model yet: once you train one on Models, it shows up here by name.</p>}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" loading={busy} disabled={cantAsk} onClick={run}>
                Ask {askName}
              </Button>
              {saved && (
                <Link to={reqLink} className="text-sm text-accent hover:underline">
                  Saved to Requests as a playground request
                </Link>
              )}
            </div>
            {err && <ErrorState title="Couldn't ask." detail={err} />}
          </div>
        </Panel>
      </div>

      {colList.length > 0 && (
        <div className="mt-4">
          <Panel
            title="Answers"
            description={ref && colList.some((c) => c !== ref && c.status === "done") ? `Red: differs from ${ref.name}.` : undefined}
            padded={!((!chunky || asQuestions) && qids.length)}
            actions={
              chunky ? (
                <QuietLink onClick={() => setAsQuestions((v) => !v)}>{asQuestions ? "Show as text" : `Show the ${qids.length} questions`}</QuietLink>
              ) : undefined
            }
          >
            {chunky && !asQuestions ? (
              <div className="space-y-4">
                {colList.map((c) => (
                  <div key={c.key}>
                    <ColHead c={c} waking={c.key === "model" && !!serving && !serving.awake} />
                    {c.status === "done" && c.answers ? (
                      <WordsByAnswerer
                        text={words}
                        spans={spans}
                        labels={Object.fromEntries(Object.entries(c.answers).map(([q, a]) => [q, a.answer]))}
                        reference={ref && ref.key !== c.key && ref.answers ? Object.fromEntries(Object.entries(ref.answers).map(([q, a]) => [q, a.answer])) : null}
                        palette={palette}
                        name=""
                      />
                    ) : null}
                  </div>
                ))}
                <p className="flex flex-wrap gap-x-2 text-xs text-slate">
                  {opts.map((o) => (
                    <span key={o} className="rounded-sm px-1 font-mono" style={tint(palette[o])}>
                      {o}
                    </span>
                  ))}
                </p>
              </div>
            ) : (
              <div className="scroll-x">
                <table className="w-full border-collapse text-left" style={{ minWidth: 320 + colList.length * 170 }}>
                  <caption className="sr-only">Each answerer's answers to this request</caption>
                  <thead>
                    <tr className="bg-panel text-xs text-slate">
                      <th scope="col" className="w-[24%] border-b border-line px-3 py-2 font-medium">
                        Question
                      </th>
                      {colList.map((c) => (
                        <th key={c.key} scope="col" className="border-b border-line px-3 py-2 align-top font-medium">
                          <ColHead c={c} waking={c.key === "model" && !!serving && !serving.awake} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {qids.map((q) => (
                      <tr key={q} className="border-b border-line last:border-b-0">
                        <th scope="row" className="px-3 py-2 align-top font-normal">
                          <code className="font-mono text-sm text-ink">{q}</code>
                          {questions?.[q]?.instructions && <p className="mt-0.5 text-xs text-slate">{questions[q].instructions}</p>}
                        </th>
                        {colList.map((c) => {
                          const a = c.answers?.[q];
                          const r = ref && ref.key !== c.key ? ref.answers?.[q] : undefined;
                          const differs = !!a && !!r && a.answer !== r.answer;
                          return (
                            <td key={c.key} className="px-3 py-2 align-top font-mono text-sm">
                              {c.status === "asking" ? (
                                <span className="skel h-3 w-16" />
                              ) : a ? (
                                <span title={differs ? `${ref!.name}: ${displayAnswer(questions?.[q], r!.answer)}` : undefined}>
                                  <Answer def={questions?.[q]} a={a} differs={differs} all />
                                </span>
                              ) : (
                                <span className="text-slate">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <details className="mt-3 text-sm text-slate">
            <summary className="cursor-pointer hover:text-ink">The request as your app would send it</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded border border-line bg-surface p-3 font-mono text-xs text-ink">{JSON.stringify({ state: parsedState.ok ? parsedState.value : null, questions }, null, 2)}</pre>
          </details>
        </div>
      )}
    </Page>
  );
}

function plural(n: number, one: string) {
  return `${n} ${n === 1 ? one : one + "s"}`;
}

/** A model already loaded in this tab. */
const isReady = (base: string) => layaState(base).status === "ready";
const readyNames = (bs: Answerer[]) => bs.filter((a) => a.base && isReady(a.base)).map((a) => a.name);

/** A column's name, time, and state: asking (with a counter; "waking up" for a sleeping server model), done, or the error. */
function ColHead({ c, waking }: { c: Col; waking: boolean }) {
  const s = Math.round((Date.now() - c.started) / 1000);
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium text-ink">{c.name}</span>
      {c.status === "asking" ? (
        <span className="text-xs font-normal text-wait">{waking && c.where === "server" ? `waking up · ${s} s` : `asking · ${s} s`}</span>
      ) : c.status === "error" ? (
        <span className="text-xs font-normal text-stop">{c.error}</span>
      ) : (
        <span className="text-xs font-normal text-slate">
          {fmtMs(c.ms)}
          {c.where === "browser" ? " in this browser" : ""}
          {c.error ? <span className="block text-wait">{c.error}</span> : null}
        </span>
      )}
    </span>
  );
}
