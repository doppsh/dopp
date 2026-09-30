/* Getting started: the six steps from GET /api/onboarding (worker/src/onboarding.js), shared by the sidebar link, the redirect
   after sign-in and /start. Read once per page load; /start polls while it is open. "See who answered" is also ticked in this
   browser once the person has opened a request (a per-viewer convenience, kept per account in localStorage). */
import { useEffect, useState } from "react";
import { cachedMe, get } from "./api";

export type StepId = "connect" | "watch" | "answers" | "answerers" | "train" | "switch";
export interface OnboardingStep {
  id: StepId;
  done: boolean;
  count?: number;
  link: string;
  route_id?: string | null;
}
export interface Onboarding {
  steps: OnboardingStep[];
  done_count: number;
  total: number;
  watch_n?: number;
}

let STATE: Onboarding | null = null;
let inflight: Promise<Onboarding | null> | null = null;
const listeners = new Set<(s: Onboarding | null) => void>();

const openedKey = () => {
  const ws = cachedMe()?.workspace.id;
  return ws ? `dopp-opened-request:${ws}` : null;
};
function openedHere(): boolean {
  try {
    const k = openedKey();
    return !!k && localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
}
/** The request drawer calls this when it opens. */
export function markRequestOpened() {
  try {
    const k = openedKey();
    if (!k || localStorage.getItem(k) === "1") return;
    localStorage.setItem(k, "1");
  } catch {
    return;
  }
  if (STATE) publish(STATE);
}

function publish(raw: Onboarding) {
  const local = openedHere();
  const steps = raw.steps.map((s) => (s.id === "answers" && local ? { ...s, done: true } : s));
  STATE = { ...raw, steps, done_count: steps.filter((s) => s.done).length, total: raw.total || steps.length };
  listeners.forEach((l) => l(STATE));
}

export const onboardingNow = () => STATE;
export const onboardingComplete = (s: Onboarding | null) => !!s && s.done_count >= s.total;

/** One look. Errors leave the state as it was (never shows the checklist by mistake). */
export function refreshOnboarding(): Promise<Onboarding | null> {
  if (!inflight)
    inflight = get<Onboarding>("/api/onboarding")
      .then((o) => {
        publish(o);
        return STATE;
      })
      .catch(() => STATE)
      .finally(() => {
        inflight = null;
      });
  return inflight;
}

export function useOnboarding(): Onboarding | null {
  const [s, setS] = useState<Onboarding | null>(STATE);
  useEffect(() => {
    listeners.add(setS);
    if (!STATE) refreshOnboarding();
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

/** Shown automatically after sign-in while incomplete, until the person leaves it once in this browser session. */
const DISMISSED = "dopp-start-dismissed";
export function startDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}
export function dismissStart() {
  try {
    sessionStorage.setItem(DISMISSED, "1");
  } catch {
    /* storage blocked: the redirect may show again, which is harmless */
  }
}
