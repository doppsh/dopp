/* Self-hosted Dopp has no prepaid balance, card checks or subscriptions: you pay your own providers (Modal for GPUs, TypeSafe for Jev,
   OpenRouter or others for LLMs) directly. What each step costs is still recorded (ledger.js, the Usage page) at the providers'
   list prices times PRICE_MARGIN (1 in the template: your own cost), so you can see where the money goes.
   Same exports as the hosted billing module, so the rest of the Worker doesn't change. */
import { servingUsdPerHour } from "./ledger.js";
import { json } from "./lib.js";

export const HOSTED_USD = () => 0;
/** Tells the dashboard this server has no credits or billing (it then never mentions them). */
export const serverInfo = () => ({ billing: false });
export const billingConfig = env => ({ free: 0, allowance: 0, packs: [], margin: +(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1), stripe: false });

/** No balance to spend down: spendable is null (callers show no limit). */
export async function balanceOf() { return { balance: 0, spendable: null, free: 0, allowance: 0, granted: 0, used: 0, card: null, locked: 0, self_hosted: true }; }
export function balanceFrom() { return balanceOf(); }

/** A trained model always may answer; there's no subscription. */
export async function hostingOf() { return { allowed: true, subscribed: false, self_hosted: true }; }

/** 403 for an account marked blocked (workspaces.blocked). */
export function blockedError() { const e = new Error("This account is blocked on this server."); e.status = 403; return e; }

/** Only a blocked account is stopped. */
export async function requireCredit(env, ws) { if (ws && ws.blocked) throw blockedError(); }

/** No cap on how many models an account trains. */
export async function canTrain() { return null; }

/** GET /api/billing: tells the dashboard this is a self-hosted server (no packs, no checkout). */
export async function billingApi(req, env, url) {
  const p = url.pathname;
  if (p === "/api/billing" && req.method === "GET")
    return json({ self_hosted: true, balance: 0, spendable: 0, free: 0, allowance: 0, granted: 0, used: 0, card: null, locked: 0, packs: [], payments: false, purchases: [], hosted_usd: 0, serving_usd_per_hour: servingUsdPerHour(env), subscriptions: [] });
  if (p.startsWith("/api/billing/")) return json({ error: "Payments are part of the hosted service; a self-hosted server has none." }, 404);
  return null;
}
