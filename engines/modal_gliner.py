"""GLiNER (fastino, Apache-2.0) as a base for Understudy models: GLiNER2.5-Decide (DeBERTa-v3-large, 486M params) and the small
GLiNER2 base (DeBERTa-v3-base, ~208M; ~212 MB at 8-bit, phone-sized). Same contract as the Kev engine (engines/modal_kev.py):

    modal deploy engines/modal_gliner.py

  POST /train                 {project, version, base ("gliner-decide"|"gliner-small"), rows: [<labelled request>], holdout: [...], epochs?} → {"job": id}
  GET  /train/{job}           {"status": "running", log} | {"status": "done", trained_rows, seconds, holdout_agreement} | {"status": "failed", error}
  POST <predict url>          {project, version, items: [{state, questions}]} → {answers: [...Jev-shaped], ms}
Labelled request = {"state": ..., "questions": {qid: {type, instructions, criteria, "label": <option key | bool | level index>}}}

Measured locally (M3 Max, 24 Sep 2026, 400 support tickets, 3 epochs): Decide 4.2 min, small 1.7 min; held-out 93.3% / 90.0% (Jev 83.3%).
Question kinds map generically: choice -> single-label task (criteria become label descriptions), score -> ordinal task, noul -> yes/no.
"""
import os, re, json, time, modal

# Names of this engine's Modal app, volumes, log and secret, all from one prefix.
PREFIX, SECRET_NAME = "dopp", "dopp-engine"
app = modal.App(f"{PREFIX}-gliner")
ckpt = modal.Volume.from_name(f"{PREFIX}-checkpoints", create_if_missing=True)
hf = modal.Volume.from_name(f"{PREFIX}-hf-cache", create_if_missing=True)
SECRET = modal.Secret.from_name(SECRET_NAME)
TRAIN_GPU = os.environ.get("GLINER_TRAIN_GPU", "A10G")   # $1.10/h on Modal; the whole model fits and trains in minutes
BASES = {"gliner-decide": "fastino/GLiNER2.5-Decide", "gliner-small": "fastino/gliner2-base-v1"}
image = (modal.Image.debian_slim(python_version="3.12")
         .uv_pip_install("gliner2==2.0.0", "torch", "transformers<5", "numpy", "sentencepiece", "tiktoken", "protobuf", "safetensors", "peft", "pyyaml", "fastapi[standard]")
         .env({"HF_HOME": "/hf"}))
VOLS = {"/ckpt": ckpt, "/hf": hf}
LOG = modal.Dict.from_name(f"{PREFIX}-train-log", create_if_missing=True)

clean = lambda s: re.sub(r"[()\[\]]", "", str(s)).strip() or "-"   # GLiNER reserves brackets and parentheses in prompts
crit = lambda q: q["criteria"] if isinstance(q.get("criteria"), list) else list((q.get("criteria") or {}).keys())

def schema_of(questions):
    from gliner2.classification import ClassificationSchema
    s = ClassificationSchema()
    for qid, q in questions.items():
        ins = clean(q.get("instructions") or qid)
        if q["type"] == "choice":
            c = q.get("criteria") or {}
            s.single(clean(qid), {clean(k): clean(v) for k, v in c.items()} if isinstance(c, dict) else [clean(k) for k in c], instruction=ins)
        elif q["type"] == "score": s.ordinal(clean(qid), [clean(c) for c in crit(q)], instruction=ins)
        else: s.single(clean(qid), ["yes", "no"], instruction=ins)
    return s

def jev_shape(questions, res):
    """GLiNER's per-task probabilities -> Jev's answer shape, in the question's own option names."""
    out = {}
    for qid, q in questions.items():
        try: p = dict(res[clean(qid)].probabilities)
        except Exception: continue
        if q["type"] == "noul": out[qid] = {"type": "noul", "noul": round(float(p.get("yes", 0)) / max(1e-9, float(p.get("yes", 0)) + float(p.get("no", 0))), 4)}; continue
        opts = crit(q); probs = {(str(i) if q["type"] == "score" else o): float(p.get(clean(o), 0)) for i, o in enumerate(opts)}
        z = sum(probs.values()) or 1.0; probs = {k: round(v / z, 4) for k, v in probs.items()}; best = max(probs, key=probs.get)
        out[qid] = {"type": "score", "score": int(best), "probabilities": probs} if q["type"] == "score" else {"type": "choice", "choice": best, "probabilities": probs}
    return out

def records(rows):
    out = []
    for r in rows:
        cls = []
        for qid, q in r["questions"].items():
            lab = q.get("label"); e = {"task": clean(qid), "prompt": clean(q.get("instructions") or qid)}
            if q["type"] == "choice":
                c = q.get("criteria") or {}; e.update(labels=[clean(k) for k in crit(q)], true_label=[clean(lab)])
                if isinstance(c, dict): e["label_descriptions"] = {clean(k): clean(v) for k, v in c.items()}
            elif q["type"] == "score": L = [clean(c) for c in crit(q)]; e.update(labels=L, true_label=[L[int(lab)]])
            else: e.update(labels=["yes", "no"], true_label=["yes" if lab in (True, "true", "yes", 1, "1") else "no"])
            cls.append(e)
        state = r["state"] if isinstance(r["state"], str) else json.dumps(r["state"], ensure_ascii=False)
        out.append({"input": state, "output": {"classifications": cls}})
    return out

def answer_str(q, a):
    if q["type"] == "noul": return "true" if a["noul"] >= .5 else "false"
    return str(a.get("choice") if q["type"] == "choice" else a.get("score"))

def label_str(q, label):
    if q["type"] == "noul": return "true" if label in (True, "true", "yes", 1, "1") else "false"
    return str(label)

def load(path_or_repo, device):
    from gliner2.classification import Classifier
    return Classifier.from_pretrained(path_or_repo).to(device=device).eval()

def answer_all(clf, items):
    from gliner2.classification import ClassificationConfig
    cfg = ClassificationConfig(decoder="independent"); out = []
    for it in items:
        text = it["state"] if isinstance(it["state"], str) else json.dumps(it["state"], ensure_ascii=False)
        out.append(jev_shape(it["questions"], clf.classify(text, schema_of(it["questions"]), config=cfg)))
    return out


@app.function(image=image, gpu=TRAIN_GPU, cpu=4, memory=32768, timeout=2 * 3600, volumes=VOLS)
def train(project: str, version: int, base: str, rows: list, holdout: list, epochs: int = 3, smoke: bool = False):
    import torch
    from gliner2 import GLiNER2
    from gliner2.training.trainer import ExtractorTrainer, TrainingConfig
    if smoke: rows = rows[:24]; holdout = holdout[:8]; epochs = 1
    d = "/ckpt/%s" % project; os.makedirs(d, exist_ok=True); out = "%s/v%d" % (d, version); t0 = time.time(); key = "%s/v%d" % (project, version)
    try: LOG[key] = ["loading %s" % BASES[base]]
    except Exception: pass
    model = GLiNER2.from_pretrained(BASES[base])
    cfg = TrainingConfig(output_dir=out + "_run", num_epochs=int(epochs), batch_size=8, encoder_lr=1e-5, task_lr=5e-5, warmup_ratio=0.1, eval_strategy="no",
                         num_workers=0, pin_memory=False, logging_steps=10, save_total_limit=1, save_best=False, fp16=False, bf16=True)   # the trainer defaults to fp16; bf16 is steadier on A10G
    try: LOG[key] = ["training on %d requests, %d epochs" % (len(rows), int(epochs))]
    except Exception: pass
    ExtractorTrainer(model, cfg).train(train_data=records(rows))
    final = out + "_run/final"
    if not os.path.exists(final): ckpt.commit(); return {"ok": False, "error": "gliner training finished without a checkpoint"}
    os.replace(final, out); json.dump({"base": base}, open(out + "/understudy.json", "w"))
    pairs = []
    if holdout:
        clf = load(out, "cuda")
        for r, ans in zip(holdout, answer_all(clf, [{"state": h["state"], "questions": {k: {kk: vv for kk, vv in q.items() if kk != "label"} for k, q in h["questions"].items()}} for h in holdout])):
            for qid, q in r["questions"].items():
                if qid in ans: pairs.append((qid, label_str(q, q["label"]), answer_str(q, ans[qid])))
    per = {}; agree = 0
    for qid, lab, a in pairs: k = "%s=%s" % (qid, lab); x = per.setdefault(k, [0, 0]); x[1] += 1; x[0] += a == lab; agree += a == lab
    ckpt.commit()
    return {"ok": True, "version": version, "trained_rows": len(rows), "seconds": round(time.time() - t0),
            "holdout_agreement": {"n": len(pairs), "overall": round(agree / len(pairs), 3) if pairs else None, "per_answer": {k: {"n": v[1], "agree": round(v[0] / v[1], 3)} for k, v in per.items()}}}


@app.cls(image=image, gpu="T4", cpu=2, memory=16384, volumes=VOLS, secrets=[SECRET], scaledown_window=600, timeout=300)
@modal.concurrent(max_inputs=4)
class Predict:
    @modal.enter()
    def setup(self): self.models = {}
    def model(self, project, version, base):
        key = (project, int(version), base if int(version) == 0 else None)   # version 0 = a base model: one per base
        if key not in self.models:
            if key[1] == 0: src = BASES.get(base or "gliner-small")   # version 0 = the base model, untrained on this data
            else:
                ckpt.reload(); src = "/ckpt/%s/v%d" % key[:2]
                if not os.path.exists(src + "/understudy.json"): raise FileNotFoundError("no gliner checkpoint %s v%d" % key[:2])
            while len(self.models) >= 3: self.models.pop(next(iter(self.models)))
            self.models[key] = load(src, "cuda")
        return self.models[key]
    @modal.asgi_app()
    def web(self):
        import hmac
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse
        api = FastAPI()
        @api.post("/")
        async def predict(req: Request):
            if not hmac.compare_digest(req.headers.get("x-understudy-secret", ""), os.environ.get("UNDERSTUDY_SECRET", "") or "unset-" + os.urandom(8).hex()): return JSONResponse({"error": "secret required"}, status_code=401)
            body = await req.json(); t0 = time.time()
            try: m = self.model(body["project"], int(body["version"]), body.get("base"))
            except FileNotFoundError as e: return JSONResponse({"error": str(e)}, status_code=404)
            return {"answers": answer_all(m, body["items"]), "ms": round((time.time() - t0) * 1000)}
        return api


@app.function(image=modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]"), cpu=0.25, memory=512, volumes=VOLS, secrets=[SECRET], scaledown_window=60, timeout=600)
@modal.asgi_app()
def api():
    import hmac
    from fastapi import FastAPI, Request, Response
    app_ = FastAPI()
    def ok(req): return hmac.compare_digest(req.headers.get("x-understudy-secret", ""), os.environ.get("UNDERSTUDY_SECRET", "") or "unset-" + os.urandom(8).hex())
    def denied(): return Response('{"error": "secret required"}', status_code=401, media_type="application/json")
    @app_.post("/train")
    async def start(req: Request):
        if not ok(req): return denied()
        b = await req.json()
        if not b.get("rows"): return Response('{"error": "no rows"}', status_code=400, media_type="application/json")
        if b.get("base") not in BASES: return Response('{"error": "base must be one of %s"}' % ", ".join(BASES), status_code=400, media_type="application/json")
        call = train.spawn(b["project"], int(b["version"]), b["base"], b["rows"], b.get("holdout") or [], int(b.get("epochs") or 3), bool(b.get("smoke")))
        try: LOG[call.object_id] = "%s/v%d" % (b["project"], int(b["version"]))
        except Exception: pass
        return {"job": call.object_id}
    @app_.get("/train/{job}")
    def status(job: str, req: Request):
        if not ok(req): return denied()
        try: r = modal.FunctionCall.from_id(job).get(timeout=0)
        except TimeoutError:
            try: return {"status": "running", "log": LOG.get(LOG.get(job) or "", [])}
            except Exception: return {"status": "running"}
        except Exception as e: return {"status": "failed", "error": str(e)[:500]}
        return {"status": "done", **r} if r.get("ok") else {"status": "failed", "error": r.get("error")}
    return app_
