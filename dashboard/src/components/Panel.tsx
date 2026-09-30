import type { ReactNode } from "react";

export function Panel({
  title,
  description,
  actions,
  children,
  padded = true,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  padded?: boolean;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-slate">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

/** A label + mono value pair. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "go" | "wait" | "stop";
}) {
  const toneCls = tone === "go" ? "text-go" : tone === "wait" ? "text-wait" : tone === "stop" ? "text-stop" : "text-ink";
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate">{label}</dt>
      <dd className={`mt-0.5 font-mono text-base tnum truncate ${toneCls}`} title={typeof value === "string" ? value : undefined}>
        {value}
        {hint && <span className="ml-1 text-sm text-slate">{hint}</span>}
      </dd>
    </div>
  );
}

/** A bordered strip of Stats. */
export function StatRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={`grid gap-x-6 gap-y-3 rounded-lg border border-line bg-panel px-4 py-3 [grid-template-columns:repeat(auto-fit,minmax(92px,1fr))] ${className}`}
    >
      {children}
    </dl>
  );
}

export function SectionHeading({
  children,
  hint,
  action,
  id,
}: {
  children: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-2 mt-8 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id={id} className="text-lg font-semibold text-ink">
        {children}
        {hint && <span className="ml-2 text-sm font-normal text-slate">{hint}</span>}
      </h2>
      {action}
    </div>
  );
}
