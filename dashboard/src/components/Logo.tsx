/** The Dopp mark: two sets, Jev (outlined, grey) and your model (outlined, green), with their overlap filled.
 *  `live` makes the overlap breathe (something is training or answering). */
export function LogoMark({ size = 22, live = false }: { size?: number; live?: boolean }) {
  // circles r=10 at x=12 and x=24 in a 36x24 box; the lens is where they overlap
  const lens = "M18 4 A10 10 0 0 1 18 20 A10 10 0 0 1 18 4Z";
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 36 24" aria-hidden="true" className="shrink-0 overflow-visible">
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--slate)" strokeWidth="1.6" />
      <circle cx="24" cy="12" r="10" fill="none" stroke="var(--go)" strokeWidth="1.6" className="logo-model" />
      <path d={lens} fill="var(--go)" className={live ? "logo-lens logo-live" : "logo-lens"} />
    </svg>
  );
}

export function Logo({ size = 20, live = false, className = "" }: { size?: number; live?: boolean; className?: string }) {
  return (
    <span className={`logo inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} live={live} />
      <span className="font-semibold tracking-[-0.02em] text-ink" style={{ fontSize: size * 0.9 }}>
        Dopp
      </span>
    </span>
  );
}
