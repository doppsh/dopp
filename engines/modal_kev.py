"""Kev (jaredpalmer/kev, Qwen3.5 + LoRA + pointer head) as a second base model for Understudy. Same two jobs as the Laya
engine — train a checkpoint, answer with one — with Kev's own trainer and server code.

    modal deploy engines/modal_kev.py

  POST /train                 {project, version, base ("kev-0.8b"|"kev-4b"), rows: [<labelled request>], holdout: [<labelled request>]} → {"job": id}
  GET  /train/{job}           {"status": "running"} | {"status": "done", ...holdout_agreement} | {"status": "failed", error}
  POST <predict url>          {project, version, items: [{state, questions}]} → {answers: [...], ms}
Labelled request = {"state": ..., "questions": {qid: {type, instructions, criteria, "label": <option key | bool | level index>}}}
"""
import os, modal

# Names of this engine's Modal app, volumes, log and secret, all from one prefix.
PREFIX, SECRET_NAME = "dopp", "dopp-engine"
app = modal.App(f"{PREFIX}-kev")
ckpt = modal.Volume.from_name(f"{PREFIX}-checkpoints", create_if_missing=True)
hf = modal.Volume.from_name(f"{PREFIX}-hf-cache", create_if_missing=True)      # base weights and released Kev runs, downloaded once
SECRET = modal.Secret.from_name(SECRET_NAME)
TRAIN_GPU = os.environ.get("KEV_TRAIN_GPU", "H100")
BASES = {"kev-0.8b": ("Qwen/Qwen3.5-0.8B-Base", "jaredpalmer/kev-0.8b"), "kev-4b": ("Qwen/Qwen3.5-4B-Base", "jaredpalmer/kev-4b")}

# Exactly Kev's own Modal image recipe (jaredpalmer/kev modal_app.py): its locked deps via uv, then the DeltaNet kernels.
KEV_ROOT = os.environ.get("KEV_ROOT", "kev-repo")   # a checkout of github.com/jaredpalmer/kev
image = (modal.Image.debian_slim(python_version="3.13")
         .apt_install("git")
         .uv_sync(uv_project_dir=KEV_ROOT, groups=[])
         .uv_pip_install("flash-linear-attention", "triton>=3.7.1")
         .uv_pip_install("fastapi[standard]")
         .env({"HF_HOME": "/hf"})
         .add_local_dir(os.path.join(KEV_ROOT, "kev"), "/root/kev"))
VOLS = {"/ckpt": ckpt, "/hf": hf}
LOG = modal.Dict.from_name(f"{PREFIX}-train-log", create_if_missing=True)   # job id -> key, key -> last progress lines

def answer_of(q, a):
    if q["type"] == "choice": return a["choice"]
    if q["type"] == "noul": return "true" if a["noul"] >= .5 else "false"
    p = a["probabilities"]; return str(max(p, key=p.get))

def label_str(q, label):
    if q["type"] == "noul": return "true" if label in (True, "true", "yes", 1, "1") else "false"
    return str(label)

def agreement(pairs):
    per = {}; agree = 0
    for qid, label, ans in pairs:
        k = "%s=%s" % (qid, label); d = per.setdefault(k, [0, 0]); d[1] += 1; d[0] += str(ans) == str(label); agree += str(ans) == str(label)
    return {"n": len(pairs), "overall": round(agree / len(pairs), 3) if pairs else None, "per_answer": {k: {"n": v[1], "agree": round(v[0] / v[1], 3)} for k, v in per.items()}}

def serve_answers(run, requests, device="cuda"):
    """Answer Jev-shaped requests with a Kev run, in-process (what kev.serve does per HTTP request)."""
    import torch
    from dataclasses import replace
    from kev.checkpoint import Checkpoint, LoadOptions
    from kev.serve import Server
    from kev.api import SystemOneRequest
    opts = replace(LoadOptions.from_env(), dtype=torch.bfloat16)
    ck = Checkpoint(run); tok, model = ck.load(device, opts); srv = Server(ck, tok, model, device)
    out = []
    for r in requests:
        body = {"model": "kev", "state": r["state"], "questions": {q: {k: v for k, v in d.items() if k != "label"} for q, d in r["questions"].items()}}
        out.append(srv.answer(SystemOneRequest(**body)))
    return out


@app.function(image=image, gpu=TRAIN_GPU, cpu=4, memory=32768, timeout=3 * 3600, volumes=VOLS)
def train(project: str, version: int, base: str, rows: list, holdout: list, smoke: bool = False):
    import sys, json, subprocess, time
    epochs = "2"
    if smoke: rows = rows[:24]; holdout = holdout[:8]; epochs = "1"   # same path end to end, minutes not tens of minutes
    b, init = BASES[base]; d = "/ckpt/%s" % project; os.makedirs(d, exist_ok=True); out = "%s/v%d" % (d, version); data = "%s/train_v%d.jsonl" % (d, version); t0 = time.time()
    with open(data, "w") as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    # state budget: Kev's trainer truncates states to --max_state tokens; size it to the data (Kev's serve limit is 8192)
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(b)
    from kev.api import render
    longest = max(len(tok(render(r["state"]), add_special_tokens=False)["input_ids"]) for r in rows[:2000]) if rows else 384
    max_state = int(min(7552, max(384, longest + 64)))
    cmd = [sys.executable, "-u", "-m", "kev.train", "--data", data, "--base", b, "--init_from", init, "--epochs", epochs, "--lr", "2e-5", "--batch", "1", "--accum", "8",
           "--dtype", "bf16", "--weights_dtype", "bf16", "--checkpointing", "1", "--device", "cuda", "--max_state", str(max_state), "--out", out]
    log = "%s/train_v%d.log" % (d, version)
    with open(log, "w") as lf:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=dict(os.environ))
        key = "%s/v%d" % (project, version); recent = []
        for line in proc.stdout:
            lf.write(line); lf.flush(); print("[kev v%d] %s" % (version, line.rstrip()), flush=True)
            if line.strip():
                recent = (recent + [line.rstrip()[:200]])[-20:]
                try: LOG[key] = recent
                except Exception: pass
        rc = proc.wait()
    if rc != 0 or not os.path.exists(out + "/head.pt"):
        tail = open(log).read()[-1500:]; ckpt.commit(); return {"ok": False, "error": "kev training failed: " + (tail.strip().splitlines()[-1] if tail.strip() else "no output")}
    json.dump({"base": base}, open(out + "/understudy.json", "w"))
    pairs = []
    if holdout:
        for r, resp in zip(holdout, serve_answers(out, holdout)):
            for qid, q in r["questions"].items():
                if qid in resp["answers"]: pairs.append((qid, label_str(q, q["label"]), answer_of(q, resp["answers"][qid])))
    ckpt.commit()
    return {"ok": True, "version": version, "trained_rows": len(rows), "seconds": round(time.time() - t0), "holdout_agreement": agreement(pairs)}


@app.cls(image=image, gpu="T4", cpu=2, memory=16384, volumes=VOLS, secrets=[SECRET], scaledown_window=600, timeout=300)
@modal.concurrent(max_inputs=4)
class Predict:
    @modal.enter()
    def setup(self): self.servers = {}
    def server(self, project, version):
        key = (project, int(version))
        if key not in self.servers:
            import torch
            from dataclasses import replace
            from kev.checkpoint import Checkpoint, LoadOptions
            from kev.serve import Server
            if key[1] == 0: run = "jaredpalmer/kev-0.8b"          # version 0 = the released Kev, untrained on this data
            else:
                ckpt.reload(); run = "/ckpt/%s/v%d" % key
                if not os.path.exists(run + "/head.pt"): raise FileNotFoundError("no kev checkpoint %s v%d" % key)
            while len(self.servers) >= 2: self.servers.pop(next(iter(self.servers)))
            ck = Checkpoint(run); tok, model = ck.load("cuda", replace(LoadOptions.from_env(), dtype=torch.bfloat16)); self.servers[key] = Server(ck, tok, model, "cuda")
        return self.servers[key]
    @modal.asgi_app()
    def web(self):
        import hmac, time
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse
        from kev.api import SystemOneRequest
        api = FastAPI()
        @api.post("/")
        async def predict(req: Request):
            if not hmac.compare_digest(req.headers.get("x-understudy-secret", ""), os.environ.get("UNDERSTUDY_SECRET", "") or "unset-" + os.urandom(8).hex()): return JSONResponse({"error": "secret required"}, status_code=401)
            body = await req.json(); t0 = time.time()
            try: srv = self.server(body["project"], int(body["version"]))
            except FileNotFoundError as e: return JSONResponse({"error": str(e)}, status_code=404)
            return {"answers": [srv.answer(SystemOneRequest(model="kev", state=it["state"], questions=it["questions"]))["answers"] for it in body["items"]], "ms": round((time.time() - t0) * 1000)}
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
        if b.get("base", "kev-0.8b") not in BASES: return Response('{"error": "base must be kev-0.8b or kev-4b"}', status_code=400, media_type="application/json")
        call = train.spawn(b["project"], int(b["version"]), b.get("base", "kev-0.8b"), b["rows"], b.get("holdout") or [], bool(b.get("smoke")))
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
