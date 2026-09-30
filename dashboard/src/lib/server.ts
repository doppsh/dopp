/* What kind of server the dashboard talks to (GET /auth/server, public): whether it has prepaid credits and billing (dopp.sh)
   or not (a self-hosted server, which pays its providers directly). Wording about credits, "our key" and prices charged
   follows this, so each server only says what is true there. Until it's known, billing reads as off, so a self-hosted
   server never shows credit wording, even for a moment. */
import { useEffect, useState } from "react";
import { API } from "./api";

export interface ServerInfo {
  billing: boolean;
  /** free credit a new account gets (billing servers only) */
  free_usd?: number;
}

const KEY = "dopp-server";
let INFO: ServerInfo | null = (() => {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? (JSON.parse(s) as ServerInfo) : null;
  } catch {
    return null;
  }
})();
let pending: Promise<ServerInfo> | null = null;

export function fetchServer(): Promise<ServerInfo> {
  if (INFO) return Promise.resolve(INFO);
  return (pending ||= fetch(API + "/auth/server", { credentials: "include" })
    .then((r): Promise<ServerInfo> | ServerInfo => (r.ok ? (r.json() as Promise<ServerInfo>) : { billing: false }))
    .catch((): ServerInfo => ({ billing: false }))
    .then((x) => {
      INFO = { billing: !!x.billing, free_usd: x.free_usd };
      try {
        sessionStorage.setItem(KEY, JSON.stringify(INFO));
      } catch {
        /* private mode */
      }
      return INFO;
    }));
}

/** The server's info; { billing: false } until it has loaded. */
export function useServer(): ServerInfo {
  const [s, setS] = useState<ServerInfo>(INFO || { billing: false });
  useEffect(() => {
    let live = true;
    fetchServer().then((x) => live && setS(x));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/** Whose key "ours" is, in words: Dopp's on a billing server, the server's own otherwise. */
export const ourKey = (billing: boolean) => (billing ? "Dopp's key" : "this server's key");

/** Synchronous read for plain functions and render code: main.tsx loads the info before the first render. */
export const billingOn = (): boolean => !!(INFO && INFO.billing);
export const serverInfo = (): ServerInfo => INFO || { billing: false };
