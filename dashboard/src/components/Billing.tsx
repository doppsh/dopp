/* Self-hosted: no prepaid balance, cards or subscriptions. You pay your providers (Modal, TypeSafe, OpenRouter, ...) directly;
   the Usage page still shows what each step cost at their list prices, so you can see where the money goes. */

export function BillingSection() {
  return (
    <section className="rounded-lg border border-line bg-surface p-5 nav:col-span-2">
      <p className="text-sm text-slate">Self-hosted</p>
      <p className="mt-2 text-base text-ink">
        You pay your providers directly: Tiny trains on this machine's CPU, other training and hosted models run on your own Modal account, and Jev and LLM answers use
        the keys set on this server.
      </p>
      <p className="mt-2 text-sm text-slate">Below is what each step cost at the providers' list prices (times PRICE_MARGIN in wrangler.toml).</p>
    </section>
  );
}

/** Hosting subscriptions are a hosted-service feature; a self-hosted model just answers. */
export function HostingBlock(_: { id: string; v: string }) {
  return null;
}
