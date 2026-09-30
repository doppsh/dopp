// Home Assistant voice commands, end to end on this machine: a local Dopp, a local Tiny trainer, and the offline folder it makes.
//
//   node examples/home-assistant/run.mjs            no keys, and no network after the first run's downloads: a stand-in
//                                                   service answers from the labels written in commands.mjs
//   … --keep                                        leave everything running afterwards, to look around the dashboard
//
// The loop itself (traffic through the proxy, more added, Tiny trained on the CPU, the folder downloaded) is scripts/loop.mjs.
// Here: the commands, and a check that the offline folder's serve.py answers them with no network.
import { runLoop, main } from "../../scripts/loop.mjs";
import { commands, stateOf, QUESTIONS } from "./commands.mjs";

const MIN_AGREEMENT = 0.85;
const all = commands();

await main(() => runLoop({
  name: "home-assistant", items: all, questions: QUESTIONS, stateOf, labelsOf: c => c.labels,
  async after({ folder, meta, say, start, up, freePort }) {
    const port = await freePort();
    start("uv", ["run", "--no-project", "--with", "onnxruntime", "--with", "tokenizers", "--with", "numpy<3", "python", "serve.py", "--port", String(port)], { cwd: folder });
    await up(`http://127.0.0.1:${port}/health`, "serve.py");
    let agree = 0, total = 0; const t1 = Date.now();
    for (const c of all) {
      const a = (await (await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", body: JSON.stringify({ state: stateOf(c), questions: QUESTIONS }) })).json()).answers;
      for (const [id, want] of Object.entries(c.labels)) { total++; const got = a[id]; agree += got && (got.type === "noul" ? (got.noul > 0.5) === want : got.choice === want) ? 1 : 0; }
    }
    say(`serve.py answered all ${all.length} commands with no network in ${((Date.now() - t1) / 1000).toFixed(1)}s; agrees with the labels on ${(agree / total * 100).toFixed(1)}% of ${total} answers (these include the ones it trained on)`);
    if (meta.measured.holdout.overall < MIN_AGREEMENT) throw new Error(`held-out agreement ${meta.measured.holdout.overall} is below ${MIN_AGREEMENT}`);
    return { note: `offline model: http://127.0.0.1:${port}/v1/systemone` };
  },
}));
