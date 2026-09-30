"""Training a Tiny model: bge-small (33M parameters) plus one head per question, exported to int8 ONNX with an offline folder.

Plain Python with no Modal in it, so the same code trains on Modal's GPUs (modal_tiny.py) and on your own CPU (tiny_local.py).
The rows come from the Worker in its labelled format: [{state, questions: {qid: {type, instructions, criteria, label}}}].
"""
import json, os, random, shutil, time, zipfile

REPO = "BAAI/bge-small-en-v1.5"
MAXLEN = 128
HERE = os.path.dirname(os.path.abspath(__file__))


def text_of(state, field):
    if isinstance(state, str): return state
    if isinstance(state, dict) and field and isinstance(state.get(field), str): return state[field]
    return json.dumps(state, ensure_ascii=False)[:2000]


def heads_of(rows):
    """{qid: {type, options}}: options in the order the question lists them (noul: false, true; score: its levels by index)."""
    h = {}
    for r in rows:
        for qid, q in r["questions"].items():
            t = q["type"]
            if t == "noul": opts = ["false", "true"]
            elif t == "score": opts = [str(i) for i in range(len(q.get("criteria") or []))]
            else: opts = list(q["criteria"].keys()) if isinstance(q.get("criteria"), dict) else [str(x) for x in (q.get("criteria") or [])]
            cur = h.setdefault(qid, {"type": t, "instructions": q.get("instructions", ""), "options": []})
            for o in opts:
                if o not in cur["options"]: cur["options"].append(o)
    return h


def label_index(head, label):
    if head["type"] == "noul": return 1 if (label is True or str(label).lower() == "true") else 0
    s = str(int(label)) if head["type"] == "score" else str(label)
    return head["options"].index(s) if s in head["options"] else None


def agreement(pairs):
    per = {}; agree = 0
    for qid, label, ans in pairs:
        k = "%s=%s" % (qid, label); d = per.setdefault(k, [0, 0]); d[1] += 1; d[0] += str(ans) == str(label); agree += str(ans) == str(label)
    return {"n": len(pairs), "overall": round(agree / len(pairs), 3) if pairs else None, "per_answer": {k: {"n": v[1], "agree": round(v[0] / v[1], 3)} for k, v in per.items()}}


def as_label(head, i):
    return ("true" if i == 1 else "false") if head["type"] == "noul" else head["options"][i]


def safe(s): return "".join(c if c.isalnum() or c in "-_" else "-" for c in str(s or "model")).strip("-") or "model"


def train(rows, holdout, out_dir, route="model", version=1, text_field=None, epochs=0, say=print, weights=None, device=None):
    """Trains, measures on the held-out rows with the exact int8 file that ships, and writes the offline folder to out_dir
    (model.onnx, tokenizer.json, tiny.json, serve.py, README.md and all of it as offline.zip). Returns what the Worker reads."""
    import numpy as np, torch, torch.nn as nn
    from transformers import AutoModel, AutoTokenizer
    t0 = time.time()
    random.seed(13); torch.manual_seed(13); np.random.seed(13)
    if weights is None:
        from huggingface_hub import snapshot_download
        weights = snapshot_download(REPO, allow_patterns=["config.json", "*.safetensors", "tokenizer*", "vocab.txt", "special_tokens_map.json"])
    tok = AutoTokenizer.from_pretrained(weights)
    dev = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
    heads = heads_of(rows + holdout); qids = list(heads)
    data = []
    for r in rows:
        y = {q: label_index(heads[q], d["label"]) for q, d in r["questions"].items() if q in heads}
        y = {q: i for q, i in y.items() if i is not None}
        if y: data.append((text_of(r["state"], text_field), y))
    if not data: return {"ok": False, "error": "no labelled rows to train on"}
    epochs = int(epochs) if epochs and int(epochs) > 0 else (30 if len(data) < 300 else 15 if len(data) < 1000 else 6)
    say("training on %d requests, %d questions, %d epochs, text: %s, on %s" % (len(data), len(qids), epochs, text_field or "whole state", dev.type.upper()))

    class Tiny(nn.Module):
        def __init__(self):
            super().__init__()
            self.enc = AutoModel.from_pretrained(weights, add_pooling_layer=False); self.drop = nn.Dropout(0.1)
            self.heads = nn.ModuleList([nn.Linear(self.enc.config.hidden_size, len(heads[q]["options"])) for q in qids])
        def forward(self, input_ids, attention_mask, with_emb=False):
            o = self.enc(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=torch.zeros_like(input_ids), output_hidden_states=with_emb)
            h = o.last_hidden_state
            m = attention_mask.unsqueeze(-1).to(h.dtype); v = (h * m).sum(1) / m.sum(1).clamp_min(1e-6); v = self.drop(v)
            heads = tuple(hd(v) for hd in self.heads)
            if not with_emb: return heads
            # emb: the mean over real tokens of the middle encoder layer's output (layer 6 of bge-small's 12), for apps that spot
            # "the same thing, reworded" by comparing lines (The Gatekeeper does). Not trained on; an extra output only.
            mid = o.hidden_states[self.enc.config.num_hidden_layers // 2]
            return heads + ((mid * m).sum(1) / m.sum(1).clamp_min(1e-9),)

    model = Tiny().to(dev)
    opt = torch.optim.AdamW([{"params": model.enc.parameters(), "lr": 5e-5}, {"params": model.heads.parameters(), "lr": 1e-3}], weight_decay=0.01)
    BS = 16; steps = epochs * ((len(data) + BS - 1) // BS)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / max(1, 0.1 * steps)) * max(0.0, (steps - s) / steps))
    lossf = nn.CrossEntropyLoss(label_smoothing=0.05, reduction="none")
    def enc(texts): e = tok(texts, padding=True, truncation=True, max_length=MAXLEN, return_tensors="pt"); return e["input_ids"].to(dev), e["attention_mask"].to(dev)
    for ep in range(epochs):
        model.train(); random.shuffle(data); tot = 0.0
        for i in range(0, len(data), BS):
            b = data[i:i + BS]; ids, am = enc([t for t, _ in b]); outs = model(ids, am); loss = 0.0
            for j, q in enumerate(qids):
                ys = torch.tensor([y.get(q, -1) for _, y in b], device=dev); mask = ys >= 0
                if mask.any(): loss = loss + lossf(outs[j][mask], ys[mask]).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sched.step(); tot += float(loss)
        say("epoch %d/%d loss %.3f" % (ep + 1, epochs, tot / max(1, (len(data) + BS - 1) // BS)))

    @torch.no_grad()
    def predict_torch(texts):
        model.eval(); out = []
        for i in range(0, len(texts), 64):
            ids, am = enc(texts[i:i + 64]); ps = [o.softmax(-1).cpu().numpy() for o in model(ids, am)]
            out += [{q: ps[j][k] for j, q in enumerate(qids)} for k in range(len(texts[i:i + 64]))]
        return out

    # the held-out check, on the exact int8 file that ships
    htexts = [text_of(h["state"], text_field) for h in holdout]; tp = predict_torch(htexts) if holdout else []   # before export, to compare
    d = out_dir; shutil.rmtree(d, ignore_errors=True); os.makedirs(d, exist_ok=True)
    model.eval().cpu()
    class Export(nn.Module):
        def __init__(self, m): super().__init__(); self.m = m
        def forward(self, input_ids, attention_mask): return self.m(input_ids, attention_mask, with_emb=True)
    ex = tok(["turn off the kitchen lights"], return_tensors="pt", padding=True)
    names = ["o%d" % i for i in range(len(qids))]
    torch.onnx.export(Export(model), (ex["input_ids"], ex["attention_mask"]), d + "/model_fp32.onnx", input_names=["input_ids", "attention_mask"], output_names=names + ["emb"],
                      dynamic_axes={"input_ids": {0: "b", 1: "t"}, "attention_mask": {0: "b", 1: "t"}, **{n: {0: "b"} for n in names + ["emb"]}}, opset_version=17, dynamo=False)
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic(d + "/model_fp32.onnx", d + "/model.onnx", weight_type=QuantType.QInt8); os.remove(d + "/model_fp32.onnx")
    tok.backend_tokenizer.save(d + "/tokenizer.json")
    meta = {"family": "tiny", "base": REPO, "route": route, "version": version, "model": "%s v%d" % (route, version), "text_field": text_field, "max_tokens": MAXLEN,
            "outputs": {q: {"output": names[j], **heads[q]} for j, q in enumerate(qids)}, "trained_rows": len(data), "trained_at": int(time.time()),
            "extras": {"emb": "emb"}}   # an embedding of the text (see forward); serve.py ignores it, browser/tiny.js returns it from decide()
    import onnxruntime as ort
    sess = ort.InferenceSession(d + "/model.onnx", providers=["CPUExecutionProvider"])
    def predict_onnx(texts):
        out = []
        for t in texts:
            e = tok([t], truncation=True, max_length=MAXLEN, return_tensors="np")
            res = sess.run(names, {"input_ids": e["input_ids"].astype("int64"), "attention_mask": e["attention_mask"].astype("int64")})
            out.append({q: np.exp(r[0] - r[0].max()) / np.exp(r[0] - r[0].max()).sum() for q, r in zip(qids, res)})
        return out
    hp = predict_onnx(htexts) if holdout else []
    pairs = []; same = 0
    for h, p, pt in zip(holdout, hp, tp):
        for q, dq in h["questions"].items():
            if q not in heads: continue
            li = label_index(heads[q], dq["label"])
            if li is None: continue
            pairs.append((q, as_label(heads[q], li), as_label(heads[q], int(p[q].argmax())))); same += int(p[q].argmax()) == int(pt[q].argmax())
    ms = []
    for t in (htexts or ["turn off the kitchen lights"])[:50]:
        s = time.time(); predict_onnx([t]); ms.append((time.time() - s) * 1000)
    meta["measured"] = {"holdout": agreement(pairs), "int8_same_as_fp32": round(same / max(1, len(pairs)), 3) if pairs else None,
                        "ms_per_request_cpu": round(float(np.median(ms)), 1), "bytes": os.path.getsize(d + "/model.onnx")}
    json.dump(meta, open(d + "/tiny.json", "w"), indent=1)
    shutil.copy(os.path.join(HERE, "tiny_serve.py") if os.path.exists(os.path.join(HERE, "tiny_serve.py")) else "/root/tiny_serve.py", d + "/serve.py")
    open(d + "/README.md", "w").write(readme(meta))
    say("held-out agreement %s on %d answers; int8 = fp32 on %s; %.1f ms per request on CPU; %.1f MB" % (meta["measured"]["holdout"]["overall"], len(pairs), meta["measured"]["int8_same_as_fp32"], meta["measured"]["ms_per_request_cpu"], meta["measured"]["bytes"] / 1e6))
    folder = "%s-v%d" % (safe(route), version)
    with zipfile.ZipFile(d + "/offline.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for f in ["model.onnx", "tokenizer.json", "tiny.json", "serve.py", "README.md"]: z.write(d + "/" + f, folder + "/" + f)
    return {"ok": True, "version": version, "trained_rows": len(data), "seconds": round(time.time() - t0), "holdout_agreement": agreement(pairs), "tiny": meta["measured"]}


def readme(m):
    q = "\n".join("- `%s` (%s): %s" % (k, v["type"], ", ".join(v["options"][:12]) + (" …" if len(v["options"]) > 12 else "")) for k, v in m["outputs"].items())
    h = m["measured"]["holdout"]
    return f"""# {m['model']}, offline

A {m['measured']['bytes'] / 1e6:.0f} MB model trained with Dopp from this route's labelled requests. It answers the same
`POST /v1/systemone` requests your app sends to Jev or Dopp, on your own machine, with no network.

## Run it

```
pip install onnxruntime tokenizers numpy
python serve.py            # listens on http://127.0.0.1:8787 ; add --host 0.0.0.0 to reach it from other machines, --port to move it
```

Then point your app's base URL at `http://<this machine>:8787`. Any bearer is accepted and ignored.
Runs anywhere Python 3.9+ and onnxruntime do: macOS, Linux (x64 and ARM, e.g. a Raspberry Pi), Windows.

## What it knows

It reads {('the `' + m['text_field'] + '` field of each request') if m['text_field'] else 'the whole state'} (up to {m['max_tokens']} tokens) and answers these questions,
with the options it was trained on:

{q}

A question it wasn't trained on, or an option it never saw, is listed under `understudy.untrained` in the reply instead of guessed.

## How good it is

Held-out requests it never trained on: agrees with the labels on {'%.1f%%' % (100 * h['overall']) if h['overall'] is not None else 'n/a'} of {h['n']} answers.
Measured on the training machine's CPU: {m['measured']['ms_per_request_cpu']} ms per request. Trained on {m['trained_rows']} requests.
"""


def upload(project, version, d, url, secret, say):
    """Hands the folder to the Worker (PUT /engine/web/<project>/v<N>/<build>/<file>, then POST done), like a Laya browser copy."""
    import urllib.request
    base = url.rstrip("/") + "/engine/web/%s/v%d/" % (project, version); build = time.strftime("%Y%m%d%H%M%S")
    def send(path, data, method, ctype):
        for attempt in range(4):
            try:
                req = urllib.request.Request(base + path, data=data, method=method, headers={"x-understudy-secret": secret, "content-type": ctype, "user-agent": "Dopp-engine/1.0"})
                with urllib.request.urlopen(req, timeout=300) as r: return r.read()
            except Exception as e: say("upload %s failed (%s), attempt %d" % (path, str(e)[:120], attempt + 1)); time.sleep(5 * (attempt + 1))
        raise RuntimeError("upload of %s failed 4 times" % path)
    try:
        for f in ["model.onnx", "tokenizer.json", "tiny.json", "serve.py", "README.md", "offline.zip"]: send(build + "/" + f, open(d + "/" + f, "rb").read(), "PUT", "application/octet-stream")
        send("done", json.dumps({"build": build}).encode(), "POST", "application/json"); say("files handed to Dopp (build %s)" % build)
    except Exception as e:
        say("hand-off failed: %s" % str(e)[:200])
        try: send("failed", json.dumps({"error": str(e)[:300]}).encode(), "POST", "application/json")
        except Exception: pass
