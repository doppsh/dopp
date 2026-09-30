import type { ReactNode } from "react";

/**
 * A rail with visible ticks and a `n/max` count. The rail is always drawn, so
 * an empty track reads as "0 of 20", not as a missing element.
 */
export function ProgressTrack({
  value,
  max,
  label,
  unit,
  done,
}: {
  value: number;
  max: number;
  label?: ReactNode;
  /** What the count counts, e.g. "calls". Shown after the fraction. */
  unit?: string;
  done?: boolean;
}) {
  const filled = Math.max(0, Math.min(1, value / max));
  const ok = done ?? value >= max;
  return (
    <div className="grid grid-cols-[minmax(80px,140px)_1fr_auto] items-center gap-3 py-0.5">
      {label !== undefined ? (
        <span className="truncate font-mono text-xs text-slate" title={typeof label === "string" ? label : undefined}>
          {label}
        </span>
      ) : (
        <span />
      )}
      <span
        className="relative block h-2.5 overflow-hidden rounded-sm border border-line bg-panel"
        role="img"
        aria-label={`${value} of ${max}${unit ? " " + unit : ""}`}
      >
        <span
          className={`block h-full ${ok ? "bg-go" : "bg-wait"}`}
          style={{ width: filled * 100 + "%" }}
        />
        {/* visible ticks at 25/50/75% so an empty rail still reads as a scale */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "repeating-linear-gradient(90deg, transparent 0 calc(25% - 1px), var(--line) calc(25% - 1px) 25%)",
          }}
        />
      </span>
      <span className="whitespace-nowrap font-mono text-xs tnum text-ink">
        {value.toLocaleString()}
        <span className="text-slate">
          /{max.toLocaleString()}
          {unit ? " " + unit : ""}
        </span>
      </span>
    </div>
  );
}
