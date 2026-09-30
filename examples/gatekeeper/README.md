# The Gatekeeper's brain

[The Gatekeeper](https://gatekeeper.dopp.sh) is a game: a guard at a castle gate, and you have to talk your way past him. Every
line you type goes to a 34 MB model running in your browser tab, which reads how you're trying to get in (friendly, a bribe, a
threat, a trick, or nonsense). This example builds that kind of model with Dopp, on your own machine, and runs it in a bare page.

```sh
npm install
npm run example:gatekeeper        # about two minutes; the first run also installs PyTorch and downloads bge-small
npm run example:gatekeeper:page   # then open http://127.0.0.1:8797/examples/gatekeeper/
```

It needs Node 22+ and [uv](https://docs.astral.sh/uv/). No keys: a stand-in service answers each line with the label written
next to it in `lines.mjs`, and the route uses that service as its labeller.

| File | What |
|---|---|
| `spec.json` | The question: how is the traveller trying to get in, with a description of each option. |
| `lines.mjs` | 240 lines travellers say, written for this example, each with its approach. |
| `run.mjs` | The loop: lines through the proxy and added like the dashboard does, Tiny trained on the CPU, the offline folder downloaded to `model/`. |
| `check.mjs` | Dopp's browser loader (`browser/tiny.js`) in Node against the folder's own `serve.py`, on every line and some edge cases. |
| `index.html` | The bare page: loads `model/` with `browser/tiny.js` and shows the answer for whatever you type. |

A run on an M-series laptop:

```
   7s    training on 212 requests, 1 questions, 30 epochs, text: traveller_says, on CPU
  74s    held-out agreement 1.0 on 28 answers; int8 = fp32 on 1.0; 2.4 ms per request on CPU; 33.8 MB
  82s  browser loader vs serve.py on 256 lines: 0 token differences, 0 answers off (largest probability gap 0.0070)
```

The check allows probabilities to differ by up to 0.05: ONNX Runtime's int8 kernels in WebAssembly and on a native CPU round
differently (up to 0.007 on an M-series Mac, up to 0.026 on GitHub's x64 Linux runners, on low-confidence edge lines). Token ids
have to match exactly, and so does the choice, unless the two top options were within 0.05.

The lines come from short templates, so they're easier than what real players type; the game's own model is trained on more
varied lines. In your own page, use the loader like this:

```js
import { load } from "./browser/tiny.js";           // with browser/wordpiece.js next to it
const model = await load("/model/", { onProgress }); // pass { ort } to use your own copy of onnxruntime-web (works offline)
const { choice, probabilities, confidence } = await model.decide("Here's a gold coin for you.");
```
