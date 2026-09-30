import { Button } from "./Button";
import { hasWebGPU, isMobile, LAYA_WEIGHTS, loadLaya, useLaya } from "../lib/layaWeb";

/** One control for a model running in this browser: a load button that becomes a progress bar, then a ready line.
    `base` is the weights URL (default: base Laya); `name` is what to call it ("base Laya", "your model v1"). */
export function LayaStatus({ label, name = "base Laya", base = LAYA_WEIGHTS, onReady }: { label?: string; name?: string; base?: string; onReady?: () => void }) {
  const s = useLaya(base);
  if (s.status === "ready") {
    return (
      <span className="font-mono text-xs text-go" title="Runs on your GPU in this tab. Nothing is sent anywhere.">
        {name} ready · {s.backend}
      </span>
    );
  }
  if (s.status === "loading") {
    const mb = (b: number) => Math.round(b / 1e6);
    const total = s.phase === "download" && s.total ? s.total : 846e6;
    const pct = s.phase === "download" ? Math.min(100, (100 * s.loaded) / total) : 100;
    return (
      <span className="inline-flex items-center gap-2 text-xs text-slate" aria-live="polite">
        <span className="h-1.5 w-28 overflow-hidden rounded bg-line">
          <span className={`block h-full bg-accent ${s.phase === "start" ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
        </span>
        {s.phase === "download" ? (
          <>
            Downloading {name} <span className="font-mono tnum">{mb(s.loaded)} of {mb(total)} MB</span>
          </>
        ) : (
          <>Starting on your GPU…</>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        onClick={() => loadLaya(base).then(() => onReady?.()).catch(() => {})}
        title={`Downloads the 846 MB model once (cached after), then runs it on your GPU. Nothing leaves this tab.`}
      >
        {label ?? `Load ${name}`}
      </Button>
      {s.status === "error" ? (
        <span className="text-xs text-stop">{s.message}</span>
      ) : (
        <span className="text-xs text-slate">
          {isMobile() ? "846 MB and ~2 GB of memory: phones usually can't hold it and the tab may crash" : hasWebGPU() ? "846 MB once, runs on your GPU" : "no WebGPU here: slow CPU fallback"}
        </span>
      )}
    </span>
  );
}
