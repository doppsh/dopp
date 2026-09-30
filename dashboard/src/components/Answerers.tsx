/* Answerers, built from data: Jev, the version our servers run, every version that has browser weights, base Laya in
   this browser, and endpoints. One picker everywhere (Requests' "Compare with", Try it's "Ask"); never one checkbox per
   version. Names are always the model's name with the version: "support-triage v2", "support-triage v2 in this browser". */
import { useMemo } from "react";
import { LayaStatus } from "./LayaStatus";
import { fmtMs, targetName, versionName } from "../lib/domain";
import { LAYA_WEIGHTS } from "../lib/layaWeb";
import type { Answerer, Example, ProjectDetail } from "../lib/types";

/** Every answerer this model has, newest version first. `server` = the ones /try can ask; `browser` = run in this tab. */
export function useAnswerers(proj: ProjectDetail | null) {
  return useMemo(() => {
    const name = proj?.project.name;
    const versions = [...(proj?.model?.versions || [])].sort((a, b) => b.version - a.version);
    const serving = proj?.model?.version || 0;
    const modelOn = proj?.routing?.targets?.model?.on !== false;
    const server: Answerer[] = [
      { key: "jev", name: "Jev", where: "server" },
      ...(serving && modelOn ? [{ key: "model", name: versionName(name, serving), where: "server" as const, version: serving }] : []),
      ...(proj?.endpoints || []).map((e) => ({ key: e.target, name: e.name || "your endpoint", where: "server" as const })),
    ];
    const browser: Answerer[] = [
      ...versions.filter((v) => v.web_status === "ready" && v.web_url).map((v) => ({ key: `web:${v.version}`, name: `${versionName(name, v.version)} in this browser`, where: "browser" as const, base: v.web_url!, version: v.version })),
      { key: "web:laya", name: "base Laya in this browser", where: "browser", base: LAYA_WEIGHTS },
    ];
    // versions without a browser copy to load yet: listed with why, not pickable (the Models page makes a new copy)
    const why = { preparing: "preparing, a few minutes", failed: "its browser copy failed: Models page", needs_copy: "needs a new browser copy: Models page" } as Record<string, string>;
    const preparing = versions.filter((v) => v.web_status && why[v.web_status]).map((v) => `${versionName(name, v.version)} in this browser (${why[v.web_status!]})`);
    return { server, browser, all: [...server, ...browser], name, serving, preparing };
  }, [proj]);
}

/** One select. `extra` options go first (e.g. "nothing", "everyone"). An in-browser pick shows its load control beside it. */
export function AnswererPicker({
  id,
  label,
  value,
  onChange,
  extra = [],
  groups,
  preparing = [],
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  extra?: { key: string; name: string }[];
  groups: { label: string; items: Answerer[] }[];
  /** names of versions whose browser weights aren't ready yet; shown greyed so nobody wonders where they are */
  preparing?: string[];
}) {
  const picked = groups.flatMap((g) => g.items).find((a) => a.key === value);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={id} className="text-slate">
        {label}
      </label>
      <select id={id} className="min-w-0 max-w-full rounded border border-line bg-surface px-2 py-1 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {extra.map((x) => (
          <option key={x.key} value={x.key}>
            {x.name}
          </option>
        ))}
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          ))}
              {preparing.map((p) => (
          <option key={p} value={"preparing:" + p} disabled>
            {p}
          </option>
        ))}
        </select>
      {picked?.where === "browser" && <LayaStatus name={picked.name.replace(/ in this browser$/, "")} base={picked.base} />}
    </span>
  );
}

/** Who actually answered a request, how fast, and (when the chosen answerer failed) why someone else did. */
export function whoAnswered(e: Pick<Example, "served" | "v" | "ms" | "fallback">, proj: ProjectDetail | null) {
  const o = { model: proj?.project.name, v: e.v, endpoints: proj?.endpoints };
  const who = e.served ? targetName(e.served, o) : null;
  const ms = e.served ? e.ms?.[e.served] : undefined;
  const fb = e.fallback;
  const tried = fb ? targetName(fb.from, o) : null;
  const why = fb ? `${tried} was asked first but gave ${fb.reason}, so ${who} answered` : null;
  return { who, ms, tried, why };
}

export function AnsweredBy({ e, proj, long }: { e: Example; proj: ProjectDetail | null; long?: boolean }) {
  const w = whoAnswered(e, proj);
  if (!w.who) return <span className="text-xs text-slate">not answered yet</span>;
  if (long)
    return (
      <span className={`text-sm ${w.why ? "text-wait" : "text-slate"}`}>
        {w.why ? `${w.why}${w.ms != null ? ` in ${fmtMs(w.ms)}` : ""}.` : `${w.who} answered${w.ms != null ? ` in ${fmtMs(w.ms)}` : ""}.`}
      </span>
    );
  return (
    <span className="flex flex-col" title={w.why || undefined}>
      <span className="text-sm text-ink">{w.who}</span>
      {w.why && <span className="text-2xs text-wait">{w.tried} failed: {e.fallback!.reason}</span>}
    </span>
  );
}
