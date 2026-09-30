"""Export a fine-tuned Laya checkpoint (a v<N> directory from training) for the browser runtime:
   laya_fp16.onnx (graph) + laya_fp16.w<i>.bin (weights in ~200 MB shards) + laya_config.json + tokenizer/.
   usage: python webgpu/export_version.py <checkpoint dir> <out dir>"""
import os, sys, json, shutil, numpy as np, torch, onnx
from onnx import external_data_helper, numpy_helper
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("HF_HOME", os.path.join(ROOT, "hf_cache")); os.environ.setdefault("HF_HUB_OFFLINE", "1")
from safetensors.torch import load_file
from laya import Agent
from laya.common import build_sequence, collate_items, QTYPES
torch.backends.mha.set_fastpath_enabled(False)
ck, out_dir = sys.argv[1], sys.argv[2]; os.makedirs(out_dir, exist_ok=True)
import transformers, onnxruntime
print("versions torch %s transformers %s onnx %s onnxruntime %s" % (torch.__version__, transformers.__version__, onnx.__version__, onnxruntime.__version__), flush=True)
SHARD = int(sys.argv[3]) if len(sys.argv) > 3 else 200_000_000   # bytes per weight file (the Worker that stores them takes ≤100 MB bodies)
cfg_ft = json.load(open(os.path.join(ck, "rl_agent_config.json")))
a = Agent("convaiinnovations/laya", device="cpu"); m = a.model.eval()
m.load_state_dict(load_file(os.path.join(ck, "model.safetensors")), strict=True)   # same architecture, the trained weights
class Wrap(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, input_ids, attention_mask, marker_pos, marker_mask, qtype):
        logits, act = s.m(input_ids, attention_mask, marker_pos, marker_mask.bool(), qtype); return logits, act
w = Wrap(m)
state = {"ticket": "Charged twice for my plan, please refund one today."}
qs = {"team": {"type": "choice", "instructions": "Which team should handle this?", "criteria": {"billing": None, "technical": None, "sales": None}},
      "angry": {"type": "noul", "instructions": "Is the customer angry?"}}
items = []
for qid, q in qs.items():
    qi = a._to_internal(q); seq, markers = build_sequence(a.tok, state, qi, a.cfg["max_len"], a.cfg["head_max_len"]); items.append({"ids": seq, "markers": markers, "qtype": QTYPES[qi["t"]]})
b = collate_items([items], a.tok.pad_token_id)
args = (b["input_ids"], b["attention_mask"], b["marker_pos"], b["marker_mask"].to(torch.int64), b["qtype"])
tmp = os.path.join(out_dir, "fp32.onnx")
with torch.no_grad():
    ref = w(*args)[0].numpy()
    torch.onnx.export(w, args, tmp, input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"], output_names=["logits", "act"],
        dynamic_axes={"input_ids": {0: "n", 1: "L"}, "attention_mask": {0: "n", 1: "L"}, "marker_pos": {0: "n", 1: "K"}, "marker_mask": {0: "n", 1: "K"}, "qtype": {0: "n"}, "logits": {0: "n", 1: "K"}, "act": {0: "n"}},
        opset_version=18, dynamo=True)   # the torch.export-based exporter: the TorchScript one (dynamo=False, opset 17) makes a graph onnxruntime-web aborts on
print("fp32 exported", flush=True)
print("loading fp32 graph", flush=True)
model = onnx.load(tmp, load_external_data=True)
print("converting to fp16", flush=True)
from onnxruntime.transformers.onnx_model import OnnxModel
om = OnnxModel(model); om.convert_float_to_float16(keep_io_types=True); model = om.model
print("sharding weights", flush=True)
# weights into ~200 MB shards, referenced by the graph as external data
shards = []; f = None; used = 0; i = -1
for t in model.graph.initializer:
    raw = numpy_helper.to_array(t).tobytes() if not t.raw_data else t.raw_data
    if len(raw) < 65536: continue   # tensors under 64 KB stay inline: onnxruntime-web aborts on small external tensors (found Sep 22, refound Sep 24)
    if f is None or used + len(raw) > SHARD:
        if f: f.close()
        i += 1; name = "laya_fp16.w%d.bin" % i; shards.append(name); f = open(os.path.join(out_dir, name), "wb"); used = 0
    f.write(raw); external_data_helper.set_external_data(t, location=name, offset=used, length=len(raw)); t.ClearField("raw_data"); del t.float_data[:]; del t.int32_data[:]; used += len(raw)
if f: f.close()
onnx.save_model(model, os.path.join(out_dir, "laya_fp16.onnx"))
os.remove(tmp); [os.remove(os.path.join(out_dir, x)) for x in os.listdir(out_dir) if x.startswith("fp32")]
json.dump({"temperature": cfg_ft.get("temperature", a.cfg.get("temperature")), "temperature_by_options": cfg_ft.get("temperature_by_options", {}), "max_len": cfg_ft.get("max_len", a.cfg["max_len"]), "head_max_len": cfg_ft.get("head_max_len", a.cfg["head_max_len"]),
           "mask_token_id": a.tok.mask_token_id, "cls_token_id": a.tok.cls_token_id, "sep_token_id": a.tok.sep_token_id, "pad_token_id": a.tok.pad_token_id, "mask_token": a.tok.mask_token, "shards": shards, "shard_bytes": [os.path.getsize(os.path.join(out_dir, x)) for x in shards]},
          open(os.path.join(out_dir, "laya_config.json"), "w"), indent=1)
tok_src = os.path.join(ck, "tokenizer") if os.path.isdir(os.path.join(ck, "tokenizer")) else os.path.join(ROOT, "webgpu", "tokenizer")
shutil.copytree(tok_src, os.path.join(out_dir, "tokenizer"), dirs_exist_ok=True)
print("parity check", flush=True)
# parity: the sharded fp16 graph against PyTorch. Run in a child process: onnxruntime's CPU build has crashed (SIGSEGV) on
# this fp16 graph on some Linux builds while the same graph runs fine in the browser; a crash here must not lose the export.
import subprocess, pickle
np.save(os.path.join(out_dir, "_ref.npy"), ref); pickle.dump({k: v.numpy() for k, v in zip(["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"], args)}, open(os.path.join(out_dir, "_feed.pkl"), "wb"))
child = subprocess.run([sys.executable, "-c", """
import sys, os, pickle, numpy as np, onnxruntime as ort
d = sys.argv[1]; s = ort.InferenceSession(os.path.join(d, "laya_fp16.onnx"), providers=["CPUExecutionProvider"])
lo = s.run(None, pickle.load(open(os.path.join(d, "_feed.pkl"), "rb")))[0]; ref = np.load(os.path.join(d, "_ref.npy"))
print("PARITY", float(np.abs(lo - ref).max()))
""", out_dir], capture_output=True, text=True)
for f in ["_ref.npy", "_feed.pkl"]: os.remove(os.path.join(out_dir, f))
par = [l for l in child.stdout.splitlines() if l.startswith("PARITY")]
parity = float(par[0].split()[1]) if par else None
print("shards", shards, "| parity max|diff|", parity if parity is not None else "unverified (checker exited %d)" % child.returncode, "| MB", sum(os.path.getsize(os.path.join(out_dir, x)) for x in shards) // 1_000_000)
json.dump({"parity_max_diff": parity, "checker_exit": child.returncode}, open(os.path.join(out_dir, "export_report.json"), "w"))
if parity is not None and parity > 0.05: sys.exit("parity too poor: %s" % parity)
