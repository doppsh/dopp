"""Understudy's Modal side, reduced to the two things that need a GPU: training a checkpoint and answering with one.
Everything else (examples, routing, stats, the API the app talks to) lives in the Cloudflare Worker.

    modal deploy engines/modal_engine.py

  POST /train                 spawn an H100 job; returns {"job": id}
  GET  /train/{job}           {"status": "running"|"done"|"failed", ...}
  POST /predict               answers from a version's own T4 container (memory-snapshotted per version; gone 10 min after the last call)
  GET  /checkpoint/{p}/{v}    tar of the checkpoint directory (download)
"""
import os, modal

# Names of this engine's Modal app, volumes, log and secret, all from one prefix.
PREFIX, SECRET_NAME = "dopp", "dopp-engine"
app = modal.App(f"{PREFIX}-engine")
ckpt = modal.Volume.from_name(f"{PREFIX}-checkpoints", create_if_missing=True)
SECRET = modal.Secret.from_name(SECRET_NAME)          # UNDERSTUDY_SECRET: shared with the Worker as MODAL_SECRET

# The Laya-family bases this engine trains from: same head, same trainer, same browser export; only the encoder differs.
# The Worker asks GET /bases before it starts a run on anything but "laya", so it never trains English Laya by mistake.
BASE_REPOS = {"laya": "convaiinnovations/laya", "laya-multilingual": "convaiinnovations/laya-multilingual"}

def download_weights():
    import os; os.environ["HF_HOME"] = "/weights"
    from huggingface_hub import snapshot_download
    for repo in BASE_REPOS.values(): snapshot_download(repo)

image = (modal.Image.debian_slim(python_version="3.12")
         .pip_install("laya>=0.3.4", "torch", "transformers>=4.48", "safetensors", "huggingface_hub", "fastapi[standard]", "onnx==1.23.0", "onnxruntime==1.30.0", "onnxconverter-common", "onnxscript", "sympy")
         .run_function(download_weights)
         .add_local_dir("engines", remote_path="/root/proxy", ignore=["state/**", "state", "__pycache__/**", "*.pyc"])
         .add_local_dir("laya_ft", remote_path="/root/laya_ft", ignore=["__pycache__/**", "*.pyc"])
         .add_local_file("browser/export_version.py", remote_path="/root/webgpu/export_version.py"))
ENV = {"HF_HOME": "/weights", "HF_HUB_OFFLINE": "1", "PYTHONPATH": "/root", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
VOLS = {"/ckpt": ckpt}
LOG = modal.Dict.from_name(f"{PREFIX}-train-log", create_if_missing=True)   # job id -> key, key -> last progress lines (read by the api while a run is going)

def answer_of(q, a):
    if q["type"] == "choice": return a["choice"]
    if q["type"] == "noul": return "true" if a["noul"] >= .5 else "false"
    p = a["probabilities"]; return str(max(p, key=p.get))

def agreement(pairs):
    """pairs: [(qid, label, answer)] -> {n, overall, per_answer{qid=label: {n, agree}}}"""
    per = {}; agree = 0
    for qid, label, ans in pairs:
        k = "%s=%s" % (qid, label); d = per.setdefault(k, [0, 0]); d[1] += 1; d[0] += str(ans) == str(label); agree += str(ans) == str(label)
    return {"n": len(pairs), "overall": round(agree / len(pairs), 3) if pairs else None, "per_answer": {k: {"n": v[1], "agree": round(v[0] / v[1], 3)} for k, v in per.items()}}


@app.function(image=image, gpu="H100", timeout=3 * 3600, volumes=VOLS)
def train(project: str, version: int, questions: dict, rows: list, holdout: list, smoke: bool = False, epochs: int = 4, web_upload_url: str = None, base: str = "laya"):
    """rows: [{state, targets: {qid: [p...]}}]; holdout: [{state, labels: {qid: label}}]. Writes /ckpt/<project>/v<version>.
    smoke: 24 rows, 8 held-out, 1 epoch — the same code path end to end in a few minutes, to prove save/calibration/eval before a long run."""
    import sys, json, subprocess, time, shutil
    os.environ.update(ENV); sys.path.insert(0, "/root")
    if smoke: rows = rows[:24]; holdout = holdout[:8]; epochs = 1
    env = dict(os.environ, EPOCHS=str(int(epochs)), LAYA_BASE_REPO=BASE_REPOS[base])
    d = "/ckpt/%s" % project; os.makedirs(d, exist_ok=True); out = "%s/v%d" % (d, version); data = "%s/train_v%d.jsonl" % (d, version); t0 = time.time()
    json.dump(questions, open("%s/questions_v%d.json" % (d, version), "w"), indent=1)
    with open(data, "w") as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    log = "%s/train_v%d.log" % (d, version)
    # stream the trainer's output to Modal's logs as well as the log file, so progress is visible while it runs
    with open(log, "w") as lf:
        proc = subprocess.Popen([sys.executable, "-u", "/root/proxy/train_soft.py", data, "%s/questions_v%d.json" % (d, version), out], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd="/root", env=env, text=True)
        key = "%s/v%d" % (project, version); recent = []
        for line in proc.stdout:
            lf.write(line); lf.flush(); print("[train v%d] %s" % (version, line.rstrip()), flush=True)
            if line.strip():
                recent = (recent + [line.rstrip()[:200]])[-20:]
                try: LOG[key] = recent
                except Exception: pass
        rc = proc.wait()
    if rc != 0:
        tail = open(log).read()[-1500:]; ckpt.commit(); return {"ok": False, "error": "training failed: " + tail.strip().splitlines()[-1] if tail.strip() else "training failed"}
    shutil.copy("%s/questions_v%d.json" % (d, version), out + "/questions.json")
    import torch, gc; gc.collect(); torch.cuda.empty_cache()
    from laya import Agent
    agent = Agent(out); pairs = []
    for h in holdout:
        own = h.get("questions") or {}; qs = {qid: (own.get(qid) or questions.get(qid)) for qid in h["labels"] if qid in own or qid in questions}
        if not qs: continue
        ans = agent.system_one(h["state"], qs)["answers"]
        pairs += [(qid, h["labels"][qid], answer_of(qs[qid], ans[qid])) for qid in qs if qid in ans]
    ckpt.commit()
    if web_upload_url and not smoke: export_web.spawn(project, version, web_upload_url)   # browser weights, so the version can run in a tab too
    return {"ok": True, "version": version, "trained_rows": len(rows), "seconds": round(time.time() - t0), "holdout_agreement": agreement(pairs)}


@app.function(image=image, cpu=4, memory=32768, timeout=1800, volumes=VOLS, secrets=[SECRET])
def export_web(project: str, version: int, upload_url: str):
    """Export /ckpt/<project>/v<version> to the browser format (fp16 ONNX in ~90 MB shards) and PUT every file to the Worker,
    which stores them and marks the version as runnable in the browser. Runs on CPU after every successful training.
    A failure is reported to the Worker too, so the version's page can say so and offer a retry."""
    import urllib.request, json
    base = upload_url.rstrip("/") + "/engine/web/%s/v%d/" % (project, version)
    try: return _export_web(project, version, base)
    except Exception as e:
        print("[export v%d] FAILED %s" % (version, str(e)[:500]), flush=True)
        try:
            req = urllib.request.Request(base + "failed", data=json.dumps({"error": str(e)[:300]}).encode(), method="POST", headers={"x-understudy-secret": os.environ["UNDERSTUDY_SECRET"], "content-type": "application/json", "user-agent": "Understudy-engine/1.0"})
            urllib.request.urlopen(req, timeout=60).read()
        except Exception as e2: print("[export v%d] couldn't report the failure: %s" % (version, e2), flush=True)
        return {"ok": False, "error": str(e)[:500]}

def _export_web(project, version, base):
    import sys, subprocess, urllib.request, json
    os.environ.update(ENV); sys.path.insert(0, "/root"); ckpt.reload()
    src = "/ckpt/%s/v%d" % (project, version); out = "/tmp/web_%s_v%d" % (project, version)
    r = subprocess.run([sys.executable, "/root/webgpu/export_version.py", src, out, "90000000"], capture_output=True, text=True, cwd="/root", env=dict(os.environ))
    print("[export v%d] %s" % (version, r.stdout[-1500:]), flush=True)
    if r.returncode != 0: raise RuntimeError("conversion failed (exit %d): %s" % (r.returncode, (r.stderr.strip().splitlines() or ["?"])[-1][:200]))
    # every export lands at its own build path, so a browser that cached an older export of this version never mixes files
    import time as _t; build = _t.strftime("%Y%m%d%H%M%S")
    sec = os.environ["UNDERSTUDY_SECRET"]
    def put(name, path):   # a 100 MB PUT through the Worker into R2 occasionally fails on the way; try a few times before giving up
        import time as _tm
        for attempt in range(4):
            try:
                req = urllib.request.Request(base + name, data=open(path, "rb").read(), method="PUT", headers={"x-understudy-secret": sec, "content-type": "application/octet-stream", "user-agent": "Understudy-engine/1.0"})
                with urllib.request.urlopen(req, timeout=600) as resp: assert resp.status == 200, resp.status
                return
            except Exception as e:
                print("[export] put %s failed (%s), attempt %d" % (name, str(e)[:120], attempt + 1), flush=True); _tm.sleep(5 * (attempt + 1))
        raise RuntimeError("upload of %s failed 4 times" % name)
    for root, _, files in os.walk(out):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), out); put(build + "/" + rel, os.path.join(root, f)); print("[export v%d] uploaded %s/%s" % (version, build, rel), flush=True)
    req = urllib.request.Request(base + "done", data=json.dumps({"build": build}).encode(), method="POST", headers={"x-understudy-secret": sec, "content-type": "application/json", "user-agent": "Understudy-engine/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp: print("[export v%d] %s" % (version, resp.read()[:200]), flush=True)
    return {"ok": True}

@app.cls(image=image, gpu="T4", cpu=2, memory=8192, volumes=VOLS, secrets=[SECRET], scaledown_window=600, timeout=300, enable_memory_snapshot=True)
class Served:
    """One container pool PER (project, version): the weights are loaded on the CPU before the memory snapshot is taken, so a
    cold start restores the snapshot (seconds) instead of reading the checkpoint off the volume (~40 s), then moves to the GPU.
    Stays up 10 minutes after the last answer. version 0 = the untrained base, for before/after comparisons."""
    project: str = modal.parameter()
    version: int = modal.parameter(default=0)

    @modal.enter(snap=True)
    def load(self):
        import sys; os.environ.update(ENV); sys.path.insert(0, "/root")
        from laya import Agent
        if self.version == 0: path = "convaiinnovations/laya"
        else:
            ckpt.reload(); path = "/ckpt/%s/v%d" % (self.project, self.version)
            if not os.path.exists(path + "/model.safetensors"): raise FileNotFoundError("no checkpoint %s v%d" % (self.project, self.version))
        self.agent = Agent(path, device="cpu")
        if self.version and os.path.getsize(path + "/model.safetensors") > 1_200_000_000:   # fp32 from an older run: keep bf16 on the volume, halving the next load
            try:
                import torch; from safetensors.torch import save_file
                save_file({k: (v.to(torch.bfloat16) if v.is_floating_point() else v).contiguous().cpu() for k, v in self.agent.model.state_dict().items()}, path + "/model.safetensors"); ckpt.commit()
                print("[serve] re-saved %s v%d in bf16" % (self.project, self.version), flush=True)
            except Exception as e: print("[serve] bf16 re-save failed: %s" % e, flush=True)

    @modal.enter(snap=False)
    def to_gpu(self):
        import torch
        if torch.cuda.is_available():
            self.agent.device = torch.device("cuda"); self.agent.model.to(self.agent.device).eval()
            self.agent.dtype = torch.float16 if torch.cuda.get_device_capability(0)[0] < 8 else self.agent.dtype

    @modal.method()
    def predict(self, items: list):
        return [self.agent.system_one(it["state"], it["questions"])["answers"] for it in items]


MAX_SHARED = int(os.environ.get("MAX_SHARED_MODELS", "15"))   # Laya-size versions held at once on one T4 (16 GB; ~0.85 GB each plus working room)

@app.cls(image=image, gpu="T4", cpu=2, memory=12288, volumes=VOLS, secrets=[SECRET], scaledown_window=120, timeout=300, enable_memory_snapshot=True)
class Shared:
    """One box for many customers' models: versions are loaded on demand into one process and the least recently used is
    evicted when the box is full. The cost is per box (awake while ANY of its models has traffic, asleep 10 minutes after
    the last request), not per model, so quiet models cost next to nothing and rarely see a cold start. Customers who turn
    keep-awake on get their own container (Served) instead."""
    @modal.enter(snap=True)
    def warm(self):
        import sys; os.environ.update(ENV); sys.path.insert(0, "/root")
        import torch, transformers, laya  # noqa: heavy imports go into the snapshot
    @modal.enter(snap=False)
    def setup(self): self.agents = {}; self.last = {}

    def agent(self, project, version):
        import time
        from laya import Agent
        key = (project, int(version))
        if key not in self.agents:
            if key[1] == 0: path = "convaiinnovations/laya"
            else:
                ckpt.reload(); path = "/ckpt/%s/v%d" % key
                if not os.path.exists(path + "/model.safetensors"): raise FileNotFoundError("no checkpoint %s v%d" % key)
            while len(self.agents) >= MAX_SHARED:   # evict the least recently used
                old = min(self.last, key=self.last.get); self.agents.pop(old, None); self.last.pop(old, None)
                import gc, torch; gc.collect(); torch.cuda.empty_cache()
            self.agents[key] = Agent(path)
            print("[shared] loaded %s v%d (%d models on this box)" % (project, version, len(self.agents)), flush=True)
        self.last[key] = time.time()
        return self.agents[key]

    @modal.method()
    def predict(self, project: str, version: int, items: list):
        a = self.agent(project, version)
        return [a.system_one(it["state"], it["questions"])["answers"] for it in items]

@app.function(image=modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]"), cpu=0.25, memory=512, volumes=VOLS, secrets=[SECRET], scaledown_window=60, timeout=600)
@modal.asgi_app()
def api():
    """Tiny CPU front door: auth, job bookkeeping, checkpoint download. No model here."""
    import hmac, json, io, tarfile
    from fastapi import FastAPI, Request, Response
    from fastapi.responses import StreamingResponse
    app_ = FastAPI()
    def ok(req): return hmac.compare_digest(req.headers.get("x-understudy-secret", ""), os.environ.get("UNDERSTUDY_SECRET", "") or "unset-" + os.urandom(8).hex())
    def denied(): return Response('{"error": "secret required"}', status_code=401, media_type="application/json")

    @app_.post("/train")
    async def start(req: Request):
        if not ok(req): return denied()
        b = await req.json()
        if not b.get("rows"): return Response('{"error": "no rows"}', status_code=400, media_type="application/json")
        base = b.get("base") or "laya"
        if base not in BASE_REPOS: return Response(json.dumps({"error": "this engine doesn't train %s" % base}), status_code=400, media_type="application/json")
        call = train.spawn(b["project"], int(b["version"]), b["questions"], b["rows"], b.get("holdout") or [], bool(b.get("smoke")), int(b.get("epochs") or 4), b.get("web_upload_url"), base)
        try: LOG[call.object_id] = "%s/v%d" % (b["project"], int(b["version"]))
        except Exception: pass
        return {"job": call.object_id}

    @app_.get("/bases")
    def bases(req: Request):
        if not ok(req): return denied()
        return {"bases": list(BASE_REPOS)}

    @app_.post("/predict")
    async def predict(req: Request):
        """{project, version, items: [{state, questions}], dedicated?} -> {answers: [...], ms}. Shared box by default; a
        version's own container (Served) when dedicated is set (keep-awake customers)."""
        import time
        if not ok(req): return denied()
        b = await req.json(); t0 = time.time(); v = int(b.get("version") or 0)
        try: answers = await (Served(project=b["project"], version=v).predict.remote.aio(b["items"]) if b.get("dedicated") else Shared().predict.remote.aio(b["project"], v, b["items"]))
        except FileNotFoundError as e: return Response(json.dumps({"error": str(e)}), status_code=404, media_type="application/json")
        return {"answers": answers, "ms": round((time.time() - t0) * 1000)}

    @app_.post("/export/{project}/{version}")   # export an existing version for the browser (backfill)
    async def export(project: str, version: int, req: Request):
        if not ok(req): return denied()
        b = await req.json(); call = export_web.spawn(project, int(version), b["web_upload_url"]); return {"job": call.object_id}

    @app_.get("/train/{job}")
    def status(job: str, req: Request):
        if not ok(req): return denied()
        try: r = modal.FunctionCall.from_id(job).get(timeout=0)
        except TimeoutError:
            try: return {"status": "running", "log": LOG.get(LOG.get(job) or "", [])}
            except Exception: return {"status": "running"}
        except Exception as e: return {"status": "failed", "error": str(e)[:500]}
        return {"status": "done", **r} if r.get("ok") else {"status": "failed", "error": r.get("error")}


    @app_.get("/checkpoint/{project}/{version}")
    def checkpoint(project: str, version: int, req: Request):
        if not ok(req): return denied()
        ckpt.reload(); path = "/ckpt/%s/v%d" % (project, version)
        if not os.path.isdir(path): return Response('{"error": "no checkpoint"}', status_code=404, media_type="application/json")
        def gen():
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w|") as tar:
                for root, _, files in os.walk(path):
                    for f in files:
                        tar.add(os.path.join(root, f), arcname=os.path.relpath(os.path.join(root, f), os.path.dirname(path)))
                        yield buf.getvalue(); buf.seek(0); buf.truncate()
            yield buf.getvalue()
        return StreamingResponse(gen(), media_type="application/x-tar", headers={"content-disposition": 'attachment; filename="%s-v%d.tar"' % (project, version)})
    return app_
