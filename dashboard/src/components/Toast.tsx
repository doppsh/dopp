import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

type Tone = "ok" | "error";
interface Item {
  id: number;
  msg: string;
  tone: Tone;
}

const Ctx = createContext<{ show: (msg: string, tone?: Tone) => void }>({ show: () => {} });

export const useToast = () => useContext(Ctx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);

  const show = useCallback((msg: string, tone: Tone = "ok") => {
    const id = ++seq.current;
    setItems((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3600);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* toasts carry text only and never take clicks: one sitting over a button (a sticky Save bar sits bottom right too)
          must not swallow the click meant for it */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2"
      >
        {items.map((i) => (
          <div
            key={i.id}
            className={`max-w-[min(420px,calc(100vw-2rem))] rounded-lg border px-3 py-2 text-sm shadow-[0_4px_20px_rgba(0,0,0,.14)] ${
              i.tone === "error"
                ? "border-stop/40 bg-stop-soft text-stop"
                : "border-line bg-surface text-ink"
            }`}
          >
            {i.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
