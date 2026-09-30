"""Answers POST /v1/systemone like Jev and Dopp, from the model in this folder, with no network.

    pip install onnxruntime tokenizers numpy
    python serve.py [--port 8787] [--host 127.0.0.1]

Point your app's base URL at http://<this machine>:8787. Any bearer is accepted and ignored.
"""
import argparse, json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
META = json.load(open(os.path.join(HERE, "tiny.json")))
TOK = Tokenizer.from_file(os.path.join(HERE, "tokenizer.json"))
TOK.enable_truncation(META.get("max_tokens", 128))
SESS = ort.InferenceSession(os.path.join(HERE, "model.onnx"), providers=["CPUExecutionProvider"])
OUTS = META["outputs"]
NAMES = [o["output"] for o in OUTS.values()]


def text_of(state):
    f = META.get("text_field")
    if isinstance(state, str): return state
    if isinstance(state, dict) and f and isinstance(state.get(f), str): return state[f]
    return json.dumps(state, ensure_ascii=False)[:2000]


def softmax(x):
    e = np.exp(x - x.max()); return e / e.sum()


def answer(body):
    state, questions = body.get("state"), body.get("questions") or {}
    if not isinstance(questions, dict) or not questions: raise ValueError("questions must be an object of question id to question")
    enc = TOK.encode(text_of(state)); ids = np.array([enc.ids], dtype=np.int64); am = np.array([enc.attention_mask], dtype=np.int64)
    probs = dict(zip(OUTS, (softmax(r[0]) for r in SESS.run(NAMES, {"input_ids": ids, "attention_mask": am}))))
    answers, untrained = {}, []
    for qid, q in questions.items():
        h = OUTS.get(qid)
        if not h or h["type"] != q.get("type"): untrained.append(qid); continue
        p = dict(zip(h["options"], probs[qid].tolist()))
        if q["type"] == "noul":
            answers[qid] = {"type": "noul", "noul": round(p.get("true", 0.0), 4)}; continue
        asked = [str(i) for i in range(len(q.get("criteria") or []))] if q["type"] == "score" else (list(q["criteria"].keys()) if isinstance(q.get("criteria"), dict) else [str(c) for c in q.get("criteria") or []])
        known = [o for o in asked if o in p]
        if not known: untrained.append(qid); continue
        if len(known) < len(asked): untrained.append(qid)   # answered among the options it knows; the rest it never saw
        tot = sum(p[o] for o in known) or 1.0; dist = {o: round(p[o] / tot, 4) for o in known}
        # confidence: the top probability (Dopp's offline contract); TypeSafe's client requires it on choice and score answers
        conf = round(max(dist.values()), 4)
        if q["type"] == "score": answers[qid] = {"type": "score", "score": round(sum(int(o) * v for o, v in dist.items()), 4), "legend": {str(i): str(c) for i, c in enumerate(q.get("criteria") or [])}, "probabilities": dist, "confidence": conf}
        else: answers[qid] = {"type": "choice", "choice": max(dist, key=dist.get), "probabilities": dist, "confidence": conf}
    return answers, untrained, len(enc.ids)


class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""): return self.send(200, {"ok": True, "model": META["model"], "runtime": "onnxruntime " + ort.__version__})
        if self.path.startswith("/v1/models"): return self.send(200, {"data": [{"id": META["model"], "family": "tiny", "base": META["base"]}]})
        self.send(404, {"error": "not found"})
    def do_POST(self):
        if not self.path.startswith("/v1/systemone"): return self.send(404, {"error": "not found"})
        t0 = time.time()
        try: body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        except Exception: return self.send(400, {"error": "the body must be JSON"})
        try: answers, untrained, n = answer(body)
        except ValueError as e: return self.send(400, {"error": str(e)})
        except Exception as e: return self.send(500, {"error": "the model failed: %s" % e})
        u = {"served": "local", "version": META["version"], "ms": round((time.time() - t0) * 1000, 1)}
        if untrained: u["untrained"] = untrained
        self.send(200, {"model": META["model"], "answers": answers, "usage": {"input_tokens": n, "output_tokens": 0}, "understudy": u})
    def log_message(self, fmt, *a): sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % a))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8787); ap.add_argument("--host", default="127.0.0.1"); a = ap.parse_args()
    print("%s answering on http://%s:%d/v1/systemone" % (META["model"], a.host, a.port), flush=True)
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()
