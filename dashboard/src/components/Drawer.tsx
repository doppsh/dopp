/* A panel that slides in from the right over the page: the one place the dashboard uses a shadow. Esc or the backdrop
   closes it, Tab stays inside it, and focus goes back to what opened it. Full width on a phone. */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const open_: object[] = [];

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  wide?: boolean;
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // drawers can stack (a request opened from the Train drawer): Escape and Tab belong to the top one only
    const me = {};
    open_.push(me);
    const before = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    // focus the first field, or the panel itself
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]") || panel.current;
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (open_[open_.length - 1] !== me) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const xs = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
      if (!xs.length) return;
      const a = xs[0], z = xs[xs.length - 1];
      if (e.shiftKey && (document.activeElement === a || document.activeElement === panel.current)) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      open_.splice(open_.indexOf(me), 1);
      if (!open_.length) document.body.style.overflow = "";
      before?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  // on body, so no transformed ancestor (the page's arrival animation) can pin it
  return createPortal(
    <div className="fixed inset-0 z-[55]">
      <button type="button" aria-label="Close" tabIndex={-1} className="drawer-backdrop absolute inset-0 border-0 bg-black/40" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={`drawer-panel absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-surface shadow-[0_0_40px_rgb(0_0_0/0.28)] outline-none ${wide ? "sm:max-w-[860px]" : "sm:max-w-[540px]"}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-md font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="press grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate hover:bg-panel hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="drawer-body min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
