# Home Assistant voice commands

A voice assistant has to read each command before it acts on it: what to do, in which room, to what kind of device, and
whether it's for later. This example sends those questions through Dopp, trains a 34 MB model on the answers on this
machine's CPU, and runs the offline folder it makes, which answers the same questions with no network.

```sh
npm install
npm run example:home-assistant
```

It needs Node 22+ and [uv](https://docs.astral.sh/uv/) (for the Python side). Nothing else: it starts its own Dopp with a
throwaway database, its own trainer, and a stand-in upstream that answers from the labels written next to each command in `commands.mjs`, so no keys are
needed. The first
run also installs PyTorch and downloads bge-small, which takes a few minutes.

What it does, all through the same HTTP API the dashboard uses:

1. Makes a route and sends a fifth of the commands through `/v1/systemone`, the way an assistant would.
2. Adds the rest the way the dashboard's **Add requests** does. One in ten of those is held out and never trained on.
3. Trains Tiny on this machine's CPU (`engines/tiny_local.py`) and waits for the offline folder to come back.
4. Downloads the folder, starts its `serve.py`, and asks it every command.

A run on an M-series laptop:

```
   8s  sent 45 commands through the proxy
   9s  added 177 more (17 held out)
  13s    training on 205 requests, 4 questions, 30 epochs, text: command, on CPU
 177s    held-out agreement 1.0 on 68 answers; int8 = fp32 on 1.0; 10.5 ms per request on CPU; 33.8 MB
 188s  serve.py answered all 222 commands with no network in 2.1s
```

The commands are written from templates over Home Assistant's demo devices (`commands.mjs`), so they are easier than a real
house.

It fails (exit code 1) if the held-out agreement drops below 85%, so it doubles as a test of the whole loop.
