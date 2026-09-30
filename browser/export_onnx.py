"""Export the full Laya decision model (encoder + head) to ONNX and check parity against PyTorch."""
import os, sys, json, time, numpy as np, torch
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["HF_HOME"] = os.path.join(ROOT, "hf_cache"); os.environ["HF_HUB_OFFLINE"] = "1"
from laya import Agent
from laya.common import build_sequence, render_options, collate_items, QTYPES
torch.backends.mha.set_fastpath_enabled(False)
a = Agent("convaiinnovations/laya", device="cpu"); m = a.model.eval()
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
out = os.path.join(ROOT, "webgpu", "laya.onnx")
with torch.no_grad():
    ref = w(*args)
    torch.onnx.export(w, args, out, input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"], output_names=["logits", "act"],
        dynamic_axes={"input_ids": {0: "n", 1: "L"}, "attention_mask": {0: "n", 1: "L"}, "marker_pos": {0: "n", 1: "K"}, "marker_mask": {0: "n", 1: "K"}, "qtype": {0: "n"}, "logits": {0: "n", 1: "K"}, "act": {0: "n"}},
        opset_version=17, dynamo=False)
print("exported", out, "%.0f MB" % (os.path.getsize(out) / 1e6))
import onnxruntime as ort
s = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
feed = {k: v.numpy() for k, v in zip(["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"], args)}
t = time.perf_counter(); lo, ac = s.run(None, feed); ms = (time.perf_counter() - t) * 1000
print("parity max|diff| logits:", float(np.abs(lo - ref[0].numpy()).max()), "| onnxruntime CPU %.0f ms for %d questions" % (ms, len(qs)))
print("logits torch:", ref[0].numpy().round(3).tolist()); print("logits onnx: ", lo.round(3).tolist())
json.dump({"temperature": a.cfg.get("temperature"), "temperature_by_options": a.cfg.get("temperature_by_options", {}), "max_len": a.cfg["max_len"], "head_max_len": a.cfg["head_max_len"],
           "mask_token_id": a.tok.mask_token_id, "cls_token_id": a.tok.cls_token_id, "sep_token_id": a.tok.sep_token_id, "pad_token_id": a.tok.pad_token_id, "mask_token": a.tok.mask_token}, open(os.path.join(ROOT, "webgpu", "laya_config.json"), "w"), indent=1)
import shutil; tok_dir = os.path.join(os.path.dirname(a.tok.name_or_path) if os.path.isdir(a.tok.name_or_path) else a.tok.name_or_path); shutil.copytree(a.tok.name_or_path, os.path.join(ROOT, "webgpu", "tokenizer"), dirs_exist_ok=True); print("tokenizer copied from", a.tok.name_or_path)
