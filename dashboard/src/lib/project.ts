/* Hooks shared by pages: the older per-route detail (question sets, versions; Try it reads it), and narrow screens. */
import { useCallback, useEffect, useRef, useState } from "react";
import { cachedProject, fetchProject } from "./api";
import type { ProjectDetail } from "./types";

function errText(e: unknown) {
  return (e as Error).message || "Couldn't load this.";
}

/** One route's older detail (keys, kinds of requests, versions). Paints from the module cache first. */
export function useProject(id: string, pollMs = 0) {
  const [data, setData] = useState<ProjectDetail | null>(() => cachedProject(id));
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await fetchProject(id);
      if (!alive.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      if ((e as { status?: number }).status !== 401) setError(errText(e));
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    setData(cachedProject(id));
    load();
    let t: ReturnType<typeof setInterval> | undefined;
    if (pollMs)
      t = setInterval(() => {
        if (document.visibilityState === "visible") load();
      }, pollMs);
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [id, load, pollMs]);

  return { data, error, reload: load, setData };
}

/** Narrow screens get stacked cards instead of wide tables. */
export function useNarrow(px = 768) {
  const q = `(max-width: ${px - 1}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    on();
    return () => m.removeEventListener("change", on);
  }, [q]);
  return narrow;
}
