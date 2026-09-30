# Dopp API

Dopp is a drop-in proxy for Jev-compatible decision APIs (`POST /v1/systemone`, the shape of TypeSafe's Jev). Send the same request you send to Jev and get the same response shape back. Each key belongs to a **route**. The route's **setup** decides who answers: Jev, another Jev-compatible service, an LLM, or a model trained on the route's own requests. Every request is kept, so a model can learn from it later.

Base URL: `http://localhost:8787`

## Authentication

Every request carries a route key as a bearer token. Keys start with `us_` and are made on a route's page in this server's dashboard. A key is shown once, when it is made. Requests through a key are kept under its route and follow that route's setup.

```
Authorization: Bearer us_...
```

Nothing else is accepted as a bearer. Calls to Jev use this server's TypeSafe key (or the Jev-compatible server it is set to use). To have TypeSafe bill your own key for a request instead, send it as `x-jev-key: <your key>`; it is forwarded and never stored.

## Endpoint

`POST /v1/systemone`

Request body (the same as Jev's):

```json
{
  "model": "jev-latest",
  "state": "Board arrived with a cracked deck. I want a replacement, not a refund.",
  "questions": {
    "issue":  { "type": "choice", "instructions": "What is the main issue?",
                "criteria": { "damaged": "arrived broken", "wrong item": null, "late": null, "billing": null, "question": null } },
    "wants":  { "type": "choice", "instructions": "What does the customer want?",
                "criteria": { "replacement": null, "refund": null, "repair": null, "information": null } },
    "angry":  { "type": "noul",   "instructions": "Is the customer angry?" },
    "urgency":{ "type": "score",  "instructions": "How urgent is this?", "criteria": ["can wait", "this week", "today"] }
  }
}
```

- `state`: a string, object or array. Anything JSON.
- `questions`: an object of question id → question. Three types:
  - `choice`: pick one of `criteria` (option name → description or `null`).
  - `noul`: yes or no. Returns the probability of yes.
  - `score`: an ordered scale; `criteria` is the list of levels, lowest first.

Response:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "issue":   { "type": "choice", "choice": "damaged", "probabilities": { "damaged": 0.97, "wrong item": 0.01, "late": 0.01, "billing": 0.0, "question": 0.01 }, "confidence": 0.97 },
    "wants":   { "type": "choice", "choice": "replacement", "probabilities": { "replacement": 0.95, "refund": 0.03, "repair": 0.02, "information": 0.0 }, "confidence": 0.95 },
    "angry":   { "type": "noul",   "noul": 0.81 },
    "urgency": { "type": "score",  "score": 1.4, "probabilities": { "0": 0.1, "1": 0.4, "2": 0.5 }, "confidence": 0.5 }
  },
  "usage": { "input_tokens": 118, "output_tokens": 0 }
}
```

Dopp adds a block named `understudy` that says what happened:

```json
{
  "model": "understudy/ab12cd34-v3",
  "understudy": {
    "served": "model:ab12cd34",
    "route": "all",
    "path": { "route": "all", "steps": [{ "ask": "model:ab12cd34", "ok": true, "ms": 41, "conf": 0.93 }], "background": ["jev"], "served": "model:ab12cd34" },
    "shadow": ["jev"],
    "recorded": true
  }
}
```

- `model`: who answered. Jev's own model name for Jev, `understudy/<route>-v<N>` for a model trained on the route, otherwise the id of the upstream that answered.
- `understudy.served`: the upstream that answered (`jev`, `model:<route>`, `llm:…`, `endpoint:<id>`).
- `understudy.path`: every upstream asked, in order, with how long each took and how sure it was. `background` lists upstreams that also ran and were kept for comparison but not returned (also in `shadow`).
- `understudy.fallback`: present when the first upstream didn't answer (it failed, timed out or was unsure) and a later one did.
- `understudy.recorded`: whether the request was kept.

A client that rejects unknown fields can get Jev's shape exactly: send `x-dopp-meta: off`, or set `RESPONSE_META=off` on the server.

### Choosing an upstream per request

Send `x-dopp-target: <upstream id>` (for example `jev` or `model:ab12cd34`), or put the id in `model`. It is honoured only when the route's setup lets callers pick; otherwise it is ignored. `x-dopp-test: 1` sends a request that is answered but not kept. (The older header names `x-understudy-target` and `x-understudy-test` still work.)

Errors: `401` with `{"error": "..."}` for a missing, unknown or revoked key; `400` for a body without `state` or `questions`; `429` past the rate limit. When an upstream fails, the reply says which one and why.

## Examples

curl:

```bash
DOPP_KEY=us_...   # a key from a route's page
curl -s http://localhost:8787/v1/systemone \
  -H "Authorization: Bearer $DOPP_KEY" \
  -H "content-type: application/json" \
  -d '{"state":"Trucks are loose, can you send new ones?","questions":{"wants":{"type":"choice","instructions":"What does the customer want?","criteria":{"replacement":null,"refund":null,"repair":null,"information":null}}}}'
```

Python:

```python
import os, requests

def decide(state, questions):
    r = requests.post("http://localhost:8787/v1/systemone",
                      headers={"Authorization": "Bearer " + os.environ["DOPP_KEY"]},
                      json={"model": "jev-latest", "state": state, "questions": questions}, timeout=30)
    r.raise_for_status()
    return r.json()["answers"]
```

Node:

```js
const answers = await fetch("http://localhost:8787/v1/systemone", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.DOPP_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "jev-latest", state, questions }),
}).then(r => r.json()).then(r => r.answers);
```

TypeSafe's own SDK works unchanged: set its base URL to `http://localhost:8787` and its API key to your route key.

## Routes, requests, models

These are managed in the dashboard.

- **Route**: a name, its keys, its requests and its setup. Make one per product or use case.
- **Requests**: every request through a key is kept. You can also add requests by pasting a file (text, CSV, JSON, JSONL), pulling rows from a public dataset, or generating them. Each gets a label from the route's labeller: you by default (fix or confirm an answer on the Requests page), or an LLM or any upstream you pick. You can correct any label.
- **Held-out requests**: some requests are kept aside and never trained on, so a model's agreement is measured on requests it never saw.
- **Models**: train Laya, GLiNER, Kev or Tiny on a route's labelled requests. Each training makes a new version, compared with what answers today on the held-out requests.
- **Setup**: who answers first, how long to wait, when to ask someone else (on an error, a timeout, or an unsure answer), who else runs in the background for comparison, whose answer is the label, and when to train.

Keep questions and options stable. Renaming an option makes a new kind of request with no labelled examples of its own.

## For agents

If you are an AI agent connecting an app to Dopp on someone's behalf:

- Replace the Jev base URL with the one above, and the TypeSafe key with a Dopp route key. Nothing else changes.
- The person may give you a one-time link instead of a key: `curl -sf <link> >> .env` adds `DOPP_BASE_URL` and `DOPP_KEY`. It works once, for 15 minutes.
- Never print, log or commit the key.
- Read `model` in each response to know who answered. Don't send `x-dopp-target` unless the person asks for it.
- Don't rename options once a model is trained on them.

## Limits

- At most 120 requests a minute per key by default (`REQUESTS_PER_MINUTE_PER_KEY`); past that the reply is 429.
- Choice questions with more than about 50 options learn poorly; keep routing those to Jev.
