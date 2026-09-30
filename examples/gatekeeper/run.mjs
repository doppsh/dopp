// The Gatekeeper's brain, end to end on this machine: travellers' lines through a local Dopp, Tiny trained on the CPU, and the
// offline folder checked in the browser loader against serve.py. The folder lands in examples/gatekeeper/model/, where the bare
// page (index.html) runs it in a browser tab.
//
//   npm run example:gatekeeper           no keys: a stand-in service answers each line with the label written in lines.mjs
//   npm run example:gatekeeper:page      then open the printed address and talk to the guard's brain
import { cpSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runLoop, main } from "../../scripts/loop.mjs";
import { lines, stateOf } from "./lines.mjs";
import { check } from "./check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), MIN_AGREEMENT = 0.8;
const spec = JSON.parse(readFileSync(join(HERE, "spec.json"), "utf8"));

await main(() => runLoop({
  name: "gatekeeper", items: lines(), questions: spec.questions, stateOf, labelsOf: x => ({ approach: x.approach }),
  async after({ folder, meta, say }) {
    await check(folder, { say: s => say(s) });
    const dest = join(HERE, "model"); rmSync(dest, { recursive: true, force: true }); cpSync(folder, dest, { recursive: true });
    say("the folder is in examples/gatekeeper/model/; npm run example:gatekeeper:page to try it in a browser");
    if (meta.measured.holdout.overall < MIN_AGREEMENT) throw new Error(`held-out agreement ${meta.measured.holdout.overall} is below ${MIN_AGREEMENT}`);
  },
}));
