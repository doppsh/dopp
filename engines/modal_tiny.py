"""Tiny: a ~35 MB model per route that runs anywhere (a Raspberry Pi, a laptop, a phone's browser), trained in about a minute.

A small English encoder (BAAI/bge-small-en-v1.5, 33M parameters) reads the request's text (the whole state when it is a string,
else the field the Worker names, e.g. a voice command) and one head per question gives that question's answer. Unlike Laya it does
not read the questions at run time: it knows the questions and options it was trained on, and a new option means a new training.

    modal deploy engines/modal_tiny.py

  POST /train          {project, version, route, rows, holdout, text_field, epochs, web_upload_url} -> {"job": id}
                       rows/holdout: [{state, questions: {qid: {type, instructions, criteria, label}}}] (the labelled format)
  GET  /train/{job}    {"status": "running"|"done"|"failed", holdout_agreement, ...}
  GET  /bases          {"bases": ["tiny"]}

After a training the version's folder (int8 ONNX, tokenizer, tiny.json, serve.py, README.md, and the same as one zip) goes to the
Worker through /engine/web/<project>/v<N>/ like a Laya browser copy: private, served only to the route's owner or its key.
"""
import os, modal

# Names of this engine's Modal app, volumes, log and secret, all from one prefix.
PREFIX, SECRET_NAME = "dopp", "dopp-engine"
app = modal.App(f"{PREFIX}-tiny")
ckpt = modal.Volume.from_name(f"{PREFIX}-checkpoints", create_if_missing=True)
SECRET = modal.Secret.from_name(SECRET_NAME)          # UNDERSTUDY_SECRET: shared with the Worker as MODAL_SECRET
REPO = "BAAI/bge-small-en-v1.5"

def download_weights():
    os.environ["HF_HOME"] = "/weights"
    from huggingface_hub import snapshot_download
    snapshot_download(REPO, allow_patterns=["config.json", "*.safetensors", "tokenizer*", "vocab.txt", "special_tokens_map.json"])

image = (modal.Image.debian_slim(python_version="3.12")
         .pip_install("torch==2.8.0", "transformers>=4.48", "safetensors", "huggingface_hub", "tokenizers", "numpy", "fastapi[standard]",
                      "onnx==1.19.0", "onnxruntime==1.22.1")
         .run_function(download_weights)
         .add_local_file("engines/tiny_serve.py", remote_path="/root/tiny_serve.py")
         .add_local_file("engines/tiny_train.py", remote_path="/root/tiny_train.py"))
ENV = {"HF_HOME": "/weights", "HF_HUB_OFFLINE": "1"}
VOLS = {"/ckpt": ckpt}
LOG = modal.Dict.from_name(f"{PREFIX}-tiny-log", create_if_missing=True)


# The training itself is tiny_train.py, the same code tiny_local.py runs on your own CPU.
@app.function(image=image, gpu="T4", timeout=1800, volumes=VOLS, secrets=[SECRET])
def train_tiny(project: str, version: int, route: str, rows: list, holdout: list, text_field: str = None, epochs: int = 0, web_upload_url: str = None):
    import tiny_train
    from huggingface_hub import snapshot_download
    os.environ.update(ENV); key = "%s/v%d" % (project, version); lines = []
    def say(s):
        print("[tiny %s] %s" % (key, s), flush=True); lines.append(s[:200])
        try: LOG[key] = lines[-20:]
        except Exception: pass
    d = "/ckpt/%s/v%d" % (project, version)
    r = tiny_train.train(rows, holdout, d, route=route, version=version, text_field=text_field, epochs=epochs, say=say, weights=snapshot_download(REPO))
    if not r.get("ok"): return r
    ckpt.commit()
    if web_upload_url: tiny_train.upload(project, version, d, web_upload_url, os.environ["UNDERSTUDY_SECRET"], say)
    return r


@app.function(image=modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]"), cpu=0.25, memory=512, secrets=[SECRET], scaledown_window=60, timeout=600)
@modal.asgi_app()
def api():
    import hmac, json
    from fastapi import FastAPI, Request, Response
    app_ = FastAPI()
    def ok(req): return hmac.compare_digest(req.headers.get("x-understudy-secret", ""), os.environ.get("UNDERSTUDY_SECRET", "") or "unset-" + os.urandom(8).hex())
    def denied(): return Response('{"error": "secret required"}', status_code=401, media_type="application/json")

    @app_.post("/train")
    async def start(req: Request):
        if not ok(req): return denied()
        b = await req.json()
        if not b.get("rows"): return Response('{"error": "no rows"}', status_code=400, media_type="application/json")
        call = train_tiny.spawn(b["project"], int(b["version"]), b.get("route") or b["project"], b["rows"], b.get("holdout") or [], b.get("text_field"), int(b.get("epochs") or 0), b.get("web_upload_url"))
        try: LOG[call.object_id] = "%s/v%d" % (b["project"], int(b["version"]))
        except Exception: pass
        return {"job": call.object_id}

    @app_.get("/bases")
    def bases(req: Request):
        if not ok(req): return denied()
        return {"bases": ["tiny"]}

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
