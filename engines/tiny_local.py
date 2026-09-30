# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["torch==2.8.0", "transformers>=4.48,<5", "huggingface_hub", "safetensors", "tokenizers", "numpy<3", "onnx==1.19.0", "onnxruntime==1.22.1"]
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }      # CPU-only PyTorch: on Linux, PyPI's default build brings gigabytes of CUDA
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""Trains Tiny models on this machine's CPU for a Dopp server running here, so self-hosting needs no Modal account.

    uv run engines/tiny_local.py        # the first run installs PyTorch and friends, and downloads bge-small (about 130 MB)

or, with Python 3.10 to 3.12 and `pip install -r engines/requirements-tiny.txt`: `python engines/tiny_local.py`.

It answers the same three addresses as the Tiny engine on Modal (POST /train, GET /train/<job>, GET /bases), so the Worker
only needs, in worker/.dev.vars:

    TINY_ENGINE_URL=http://127.0.0.1:8788
    SELF_URL=http://localhost:8787
    MODAL_SECRET=<any long random string>     # the Worker and this trainer check it on every call; read from worker/.dev.vars

After a training the offline folder goes back to the Worker (SELF_URL), and a copy stays in ~/.cache/dopp/tiny/.
"""
import argparse, hmac, json, os, sys, threading, time, traceback, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tiny_train  # noqa: E402

JOBS = {}                      # job id → {"status", "log", "result"/"error"}
ONE_AT_A_TIME = threading.Lock()


def dev_var(name):
    """A value from worker/.dev.vars, so the trainer and `npm run dev` share one secret without copying it around."""
    try:
        for line in open(os.path.join(HERE, "..", "worker", ".dev.vars")):
            k, _, v = line.strip().partition("=")
            if k == name and v: return v.strip().strip('"')
    except OSError: pass
    return None


def run(job, b, secret, out_root, device):
    j = JOBS[job]
    def say(s):
        print("[tiny %s/v%s] %s" % (b["project"], b["version"], s), flush=True); j["log"] = (j["log"] + [s[:200]])[-20:]
    with ONE_AT_A_TIME:
        try:
            d = os.path.join(out_root, b["project"], "v%d" % int(b["version"]))
            r = tiny_train.train(b["rows"], b.get("holdout") or [], d, route=b.get("route") or b["project"], version=int(b["version"]),
                                 text_field=b.get("text_field"), epochs=int(b.get("epochs") or 0), say=say, device=device)
            if not r.get("ok"): j.update(status="failed", error=r.get("error")); return
            if b.get("web_upload_url"): tiny_train.upload(b["project"], int(b["version"]), d, b["web_upload_url"], secret, say)
            say("folder: " + d)
            j.update(status="done", result=r)
        except Exception as e:
            traceback.print_exc(); j.update(status="failed", error=str(e)[:500])


def main():
    ap = argparse.ArgumentParser(description="Train Tiny models on this machine for a local Dopp server.")
    ap.add_argument("--port", type=int, default=8788); ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--device", default=None, help="cpu (default), cuda, or mps")
    ap.add_argument("--out", default=os.path.expanduser("~/.cache/dopp/tiny"), help="where trained folders are kept")
    a = ap.parse_args()
    secret = os.environ.get("MODAL_SECRET") or dev_var("MODAL_SECRET")
    if not secret: sys.exit("Set MODAL_SECRET in worker/.dev.vars (any long random string) so the Worker and this trainer trust each other, then start both again.")

    class H(BaseHTTPRequestHandler):
        def send(self, code, obj):
            b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def ok(self): return hmac.compare_digest(self.headers.get("x-understudy-secret", ""), secret)
        def do_GET(self):
            if self.path.rstrip("/") in ("", "/health"): return self.send(200, {"ok": True, "engine": "tiny", "where": "this machine"})
            if not self.ok(): return self.send(401, {"error": "secret required"})
            if self.path == "/bases": return self.send(200, {"bases": ["tiny"]})
            if self.path.startswith("/train/"):
                j = JOBS.get(self.path[len("/train/"):])
                if not j: return self.send(200, {"status": "failed", "error": "this trainer restarted and lost the job; train again"})
                if j["status"] == "running": return self.send(200, {"status": "running", "log": j["log"]})
                if j["status"] == "done": return self.send(200, {"status": "done", **j["result"]})
                return self.send(200, {"status": "failed", "error": j.get("error") or "training failed"})
            self.send(404, {"error": "not found"})
        def do_POST(self):
            if self.path != "/train": return self.send(404, {"error": "not found"})
            if not self.ok(): return self.send(401, {"error": "secret required"})
            try: b = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            except Exception: return self.send(400, {"error": "the body must be JSON"})
            if not b.get("rows"): return self.send(400, {"error": "no rows"})
            job = uuid.uuid4().hex; JOBS[job] = {"status": "running", "log": ["waiting for the trainer"], "t": time.time()}
            threading.Thread(target=run, args=(job, b, secret, a.out, a.device), daemon=True).start()
            self.send(200, {"job": job})
        def log_message(self, fmt, *args): pass

    print("Tiny trainer on http://%s:%d (set TINY_ENGINE_URL to it in worker/.dev.vars); folders in %s" % (a.host, a.port, a.out), flush=True)
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
