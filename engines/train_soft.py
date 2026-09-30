"""Train Laya on the labeller's probability distributions (soft targets). Thin wrapper over laya_ft.train."""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from laya_ft import train as T
data, qpath, out = sys.argv[1:4]; Q = json.load(open(qpath)); rows = [json.loads(l) for l in open(data)]
def build_items(tok, cfg, questions, rows):
    from laya.common import build_sequence, render_options, QTYPES
    items = []
    for r in rows:
        own = r.get("questions") or {}          # templated rows (one question per chunk) carry their own definitions
        for qid, target in r["targets"].items():
            spec = own.get(qid) or questions[qid]; t = spec["type"]; crit = spec.get("criteria", {}); k = len(render_options({"t": t, "crit": crit}))
            seq, markers = build_sequence(tok, r["state"], {"t": t, "ins": spec["instructions"], "crit": crit}, cfg["max_len"], cfg["head_max_len"])
            if len(markers) != k: continue
            s = sum(target) or 1.0; items.append({"ids": seq, "markers": markers, "qtype": QTYPES[t], "target": [v / s for v in target]})
    return items
T.build_items = build_items

# Context window: size the model to the data instead of the shipped 512/192 defaults. The backbones support 8,192
# positions, so max_len is raised to fit the longest recorded state (+ head) and head_max_len to fit the largest option
# list. Saved into the checkpoint config so inference uses the same limits.
import laya.common as C
from transformers import AutoTokenizer
_orig_train = T.train
def train_sized(model_id, questions, train_rows, calib_rows, out_dir, **kw):
    mdir = T.resolve_model_dir(model_id); tok = AutoTokenizer.from_pretrained(os.path.join(mdir, "tokenizer"))
    longest_state = max(len(tok(C.serialize_state(r["state"]), add_special_tokens=False)["input_ids"]) for r in train_rows + calib_rows)
    biggest_head = max(sum(len(tok(" " + o, add_special_tokens=False)["input_ids"][:48]) + 1 for o in C.render_options({"t": q["type"], "crit": q.get("criteria")})) for q in questions.values())
    head_max_len = max(192, min(1024, biggest_head + 32)); need = longest_state + head_max_len + 64
    max_len = min(4096, max(512, -(-need // 256) * 256))        # sized to the data (multiple of 256), capped: longer states are truncated by build_sequence
    kw.setdefault("micro", 8 if max_len <= 1024 else 4)          # bf16 + checkpointing: 4 long sequences per step fit an A10G
    kw.setdefault("accum", 4 if max_len <= 1024 else 8)
    cfg_path = os.path.join(mdir, "rl_agent_config.json"); cfg = json.load(open(cfg_path))
    if (max_len, head_max_len) != (cfg.get("max_len"), cfg.get("head_max_len")):
        sized = os.path.join(os.path.dirname(out_dir), "_base_sized"); os.makedirs(sized, exist_ok=True)
        for f in os.listdir(mdir):
            src = os.path.join(mdir, f); dst = os.path.join(sized, f)
            if not os.path.exists(dst): os.symlink(src, dst)
        cfg.update(max_len=max_len, head_max_len=head_max_len); os.remove(os.path.join(sized, "rl_agent_config.json")) if os.path.islink(os.path.join(sized, "rl_agent_config.json")) else None
        json.dump(cfg, open(os.path.join(sized, "rl_agent_config.json"), "w"), indent=2); model_id = sized
    print("context: longest state %d tokens, largest option list %d tokens -> max_len %d, head_max_len %d" % (longest_state, biggest_head, max_len, head_max_len), flush=True)
    return _orig_train(model_id, questions, train_rows, calib_rows, out_dir, **kw)
T.train = train_sized
n_cal = max(10, len(rows) // 10)
T.train(os.environ.get("LAYA_BASE_REPO", "convaiinnovations/laya"), Q, rows[n_cal:], rows[:n_cal], out, epochs=int(os.environ.get("EPOCHS", "4")))
