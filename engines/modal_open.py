"""Open decision models Understudy hosts as upstreams (answering in Jev's shape, untrained), behind the engine secret.

    modal deploy engines/modal_open.py

  POST <predict url>   {model: "jevk5", project, version, items: [{state, questions}]} → {answers: [...Jev-shaped], ms}

JevK5 (alibiserikbay/JevK5, Apache-2.0): a Qwen3.5-4B fine-tune that answers in the Jev request shape, one forward pass per question, per-option probabilities.
JevBench v1.4.1 (benchmarkheaven.com, 23 Sep 2026): 62.0, next to Jev 1.13.0's 63.3. Runtime: github.com/allebee/jevk5 (Apache-2.0),
used in-process exactly as its own `jevk5-serve` does (jevk5/server.py). Needs ~9 GB of GPU memory in bf16: an L4 ($0.80/h on Modal).
"""
import os, time, modal

# Names of this engine's Modal app, volumes, log and secret, all from one prefix.
PREFIX, SECRET_NAME = "dopp", "dopp-engine"
app = modal.App(f"{PREFIX}-open")
hf = modal.Volume.from_name(f"{PREFIX}-hf-cache", create_if_missing=True)
SECRET = modal.Secret.from_name(SECRET_NAME)
JEVK5_REF = "v0.2.2"   # the runtime release the model card documents
image = (modal.Image.debian_slim(python_version="3.12").apt_install("git")
         .uv_pip_install("torch>=2.7", "transformers>=5.17", "accelerate>=1.12", "huggingface-hub>=1.0", "numpy", "jinja2>=3.1", "fastapi[standard]")
         .run_commands(f"pip install --no-deps 'git+https://github.com/allebee/jevk5@{JEVK5_REF}' || pip install --no-deps git+https://github.com/allebee/jevk5")
         .env({"HF_HOME": "/hf"}))
MODELS = {"jevk5": "alibiserikbay/JevK5"}


@app.cls(image=image, gpu="L4", cpu=2, memory=24576, volumes={"/hf": hf}, secrets=[SECRET], scaledown_window=600, timeout=300)
@modal.concurrent(max_inputs=4)
class Open:
    @modal.enter()
    def load(self):
        import threading
        from jevk5.runtime import JevK5
        from jevk5.server import normalized
        self.normalized = normalized
        self.models = {"jevk5": JevK5(MODELS["jevk5"])}
        self.lock = threading.Lock()   # one GPU, one model: questions are answered one at a time, as jevk5-serve does
        hf.commit()

    @modal.asgi_app()
    def web(self):
        import hmac
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse
        api = FastAPI()
        @api.post("/")
        async def predict(req: Request):
            if not hmac.compare_digest(req.headers.get("x-understudy-secret", ""), os.environ.get("UNDERSTUDY_SECRET", "") or "unset-" + os.urandom(8).hex()):
                return JSONResponse({"error": "secret required"}, status_code=401)
            body = await req.json(); name = body.get("model") or body.get("base") or "jevk5"; m = self.models.get(name)
            if not m: return JSONResponse({"error": "unknown open model %r (have: %s)" % (name, ", ".join(self.models))}, status_code=404)
            t0 = time.time(); out = []
            try:
                with self.lock:
                    for it in body["items"]:
                        ans = {qid: m.decide(it["state"], self.normalized(q)) for qid, q in it["questions"].items()}
                        for a in ans.values(): a.pop("input_tokens", None)
                        out.append(ans)
            except (ValueError, KeyError, TypeError) as e: return JSONResponse({"error": str(e)}, status_code=400)
            return {"answers": out, "ms": round((time.time() - t0) * 1000)}
        return api
