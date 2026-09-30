"""Fine-tune Laya on a data.jsonl. The recipe is the author's RLCD script from the Laya repo's Kaggle notebook
(policy gradient with proper-scoring-rule reward + cross-entropy, then temperature fitting), made to run in one
process on CUDA, Apple MPS or CPU."""
import os, json, time, random, torch
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer
from laya.common import build_model, build_sequence, render_options, proper_reward, QTYPES
from laya.agent import _fix_tokenizer_config
from .data import answer_index


def resolve_model_dir(model_id):
    if os.path.isdir(model_id): return model_id
    from huggingface_hub import snapshot_download
    return snapshot_download(model_id)


def pick_device(name=None):
    if name: return torch.device(name)
    if torch.cuda.is_available(): return torch.device("cuda")
    if torch.backends.mps.is_available(): return torch.device("mps")
    return torch.device("cpu")


def build_items(tok, cfg, questions, rows):
    items = []
    for r in rows:
        for qid, a in (r.get("answers") or {}).items():
            spec = questions[qid]; t = spec["type"]; crit = spec.get("criteria", {})
            k = len(render_options({"t": t, "crit": crit})); label = answer_index(spec, a)
            seq, markers = build_sequence(tok, r["state"], {"t": t, "ins": spec["instructions"], "crit": crit}, cfg["max_len"], cfg["head_max_len"])
            if len(markers) != k:
                raise SystemExit("question %r has too many options for head_max_len=%d; raise it in the base config" % (qid, cfg["head_max_len"]))
            target = [0.0] * k; target[label] = 1.0
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES[t], "target": target})
    return items


def collate(items, pad_id):
    n, L = len(items), max(len(i["ids"]) for i in items); kmax = max(len(i["markers"]) for i in items)
    ids = torch.full((n, L), pad_id); att = torch.zeros((n, L), dtype=torch.long); mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool); target = torch.zeros((n, kmax))
    for i, it in enumerate(items):
        ids[i, :len(it["ids"])] = torch.tensor(it["ids"]); att[i, :len(it["ids"])] = 1; k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"]); mmask[i, :k] = True; target[i, :k] = torch.tensor(it["target"])
    return {"input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask, "target": target, "qtype": torch.tensor([i["qtype"] for i in items])}


def fit_temperature(sel):
    if len(sel) < 10: return 1.0
    kmax = max(len(z) for z, _ in sel); Z = torch.full((len(sel), kmax), -1e4); T = torch.zeros((len(sel), kmax))
    for i, (z, t) in enumerate(sel): Z[i, :len(z)] = torch.tensor(z); T[i, :len(t)] = torch.tensor(t)
    log_t = torch.zeros(1, requires_grad=True); o = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)
    def closure():
        o.zero_grad(); L = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean(); L.backward(); return L
    o.step(closure); return float(torch.clamp(log_t.exp(), 0.1, 10.0).item())


def train(model_id, questions, train_rows, calib_rows, out_dir, epochs=4, micro=8, accum=4, group=4,
          lr_encoder=2.5e-5, lr_head=1e-4, sigma=(0.4, 0.1), device=None, log=print):
    model_dir = resolve_model_dir(model_id); _fix_tokenizer_config(model_dir)
    cfg = json.load(open(os.path.join(model_dir, "rl_agent_config.json")))
    tok = AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer")); dev = pick_device(device)
    items = build_items(tok, cfg, questions, train_rows); calib = build_items(tok, cfg, questions, calib_rows)
    model = build_model(cfg, encoder_dir=os.path.join(model_dir, "encoder"))
    model.load_state_dict(load_file(os.path.join(model_dir, "model.safetensors")), strict=True)
    try: model.encoder.config.reference_compile = False
    except Exception: pass
    model.to(dev).train()
    # long states (per-word tasks carry the whole text) need memory more than speed: recompute activations, run the encoder in bf16
    try: model.encoder.gradient_checkpointing_enable()
    except Exception: pass
    use_bf16 = str(dev).startswith("cuda") and torch.cuda.is_bf16_supported()
    enc = [p for n, p in model.named_parameters() if "encoder." in n]; head = [p for n, p in model.named_parameters() if "encoder." not in n]
    opt = torch.optim.AdamW([{"params": enc, "lr": lr_encoder}, {"params": head, "lr": lr_head}], weight_decay=0.01)
    total_updates = max(1, (len(items) // (micro * accum)) * epochs)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=total_updates, eta_min=1e-6)
    log("device %s | %d training sequences from %d rows | %d epochs" % (dev, len(items), len(train_rows), epochs)); t0 = time.time()
    total_seq = len(items) * epochs; done_seq = 0; last_log = time.time()
    for ep in range(epochs):
        random.seed(42 + ep); random.shuffle(items); sig = sigma[0] + (sigma[1] - sigma[0]) * ep / max(1, epochs - 1); step = 0; tot = 0.0; nb = 0
        opt.zero_grad(set_to_none=True)
        for b in range(0, len(items), micro):
            B = {k: v.to(dev) for k, v in collate(items[b:b + micro], tok.pad_token_id).items()}
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=use_bf16):
                logits, act = model(B["input_ids"], B["attention_mask"], B["marker_pos"], B["marker_mask"], B["qtype"])
            logits = logits.float(); mask = B["marker_mask"]; k = mask.sum(-1, keepdim=True).float(); target = B["target"]
            eps = torch.randn((group,) + logits.shape, device=dev) * sig * mask; eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps; q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                r = proper_reward(q, target.unsqueeze(0), B["qtype"], mask, w_sph=0.75, w_rps=1.0); adv = r - r.mean(0, keepdim=True); adv = adv / (adv.std() + 1e-6)
            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sig ** 2)
            loss = (-(adv * logp).mean() - (target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()) / accum + 0.0 * act.sum()
            loss.backward(); step += 1; tot += loss.item() * accum; nb += 1
            done_seq += min(micro, len(items) - b)
            if time.time() - last_log > 30:   # a progress line every half minute: where it is and how long is left
                left = (time.time() - t0) / max(1, done_seq) * (total_seq - done_seq); last_log = time.time()
                log("epoch %d/%d  %d of %d sequences  about %d min left" % (ep + 1, epochs, done_seq, total_seq, max(1, round(left / 60))))
            if step % accum == 0 or b + micro >= len(items):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
        log("epoch %d/%d  loss %.3f  %.0fs" % (ep + 1, epochs, tot / max(1, nb), time.time() - t0))
    model.eval(); preds = []
    # weights first: calibration is cheap to redo, an hour of training is not
    os.makedirs(out_dir, exist_ok=True)
    save_file({k: (v.to(torch.bfloat16) if v.is_floating_point() else v).contiguous().cpu() for k, v in model.state_dict().items()}, os.path.join(out_dir, "model.safetensors"))
    model.encoder.config.save_pretrained(os.path.join(out_dir, "encoder")); tok.save_pretrained(os.path.join(out_dir, "tokenizer"))
    opt = None; torch.cuda.empty_cache() if str(dev).startswith("cuda") else None
    cb_n = max(1, min(16, 16 * 1024 // max(1, max(len(it["ids"]) for it in calib) if calib else 1)))   # ~16k tokens per calibration batch
    with torch.no_grad():
        for c in range(0, len(calib), cb_n):
            ch = calib[c:c + cb_n]; cb = {k: v.to(dev) for k, v in collate(ch, tok.pad_token_id).items()}
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=use_bf16):
                l, _ = model(cb["input_ids"], cb["attention_mask"], cb["marker_pos"], cb["marker_mask"], cb["qtype"])
            l = l.float().cpu()
            for i, it in enumerate(ch): preds.append((it["qtype"], l[i, :len(it["markers"])].tolist(), it["target"]))
    temps = [fit_temperature([(z, t) for qt_, z, t in preds if qt_ == qt]) for qt in range(3)]
    cfg.update(fine_tuned=True, base_model=model_id, temperature=temps); cfg.pop("temperature_by_options", None)
    json.dump(cfg, open(os.path.join(out_dir, "rl_agent_config.json"), "w"), indent=2)
    json.dump(questions, open(os.path.join(out_dir, "questions.json"), "w"), indent=2)
    log("saved %s  (temperatures %s, %.0fs total)" % (out_dir, [round(t, 2) for t in temps], time.time() - t0))
    return out_dir
