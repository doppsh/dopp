// A BERT WordPiece tokenizer read from a Hugging Face tokenizer.json, written to give exactly the ids that the Rust `tokenizers`
// library gives (what Dopp's serve.py uses: Tokenizer.from_file(...).encode(text) with enable_truncation(max_tokens)).
// Supports what bge-small-style tokenizers use: BertNormalizer, BertPreTokenizer, WordPiece, TemplateProcessing/BertProcessing,
// and added (special) tokens typed literally in the input ("[SEP]" in a line becomes the [SEP] id, as in Rust).
// Anything else in the file is refused with a plain error, rather than tokenized differently. Checked id for id against the Rust
// library by examples/gatekeeper/check.mjs. No dependencies; ~0 KB next to transformers.js's 800 KB.

const CJK = [[0x4e00, 0x9fff], [0x3400, 0x4dbf], [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b920, 0x2ceaf], [0xf900, 0xfaff], [0x2f800, 0x2fa1f]];
const isCJK = (cp) => CJK.some(([a, b]) => cp >= a && cp <= b);
const WS = /^\s$/u;                                   // JS \s is Unicode White_Space plus U+FEFF (handled as a control first)
const isWhitespace = (c) => c === "\t" || c === "\n" || c === "\r" || (c !== "﻿" && WS.test(c));
const OTHER = /^\p{C}$/u;                             // Cc, Cf, Cn, Co, Cs
const isControl = (c) => c !== "\t" && c !== "\n" && c !== "\r" && OTHER.test(c);
const PUNCT = /^\p{P}$/u;
const isPunct = (c) => { const cp = c.codePointAt(0); return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126) || PUNCT.test(c); };
const MN = /^\p{Mn}$/u;

export class WordPiece {
  constructor(json) {
    const n = json.normalizer, pre = json.pre_tokenizer, model = json.model, post = json.post_processor;
    if (!n || n.type !== "BertNormalizer") throw new Error(`tokenizer.json: normalizer ${n && n.type} isn't supported (BertNormalizer only)`);
    if (!pre || pre.type !== "BertPreTokenizer") throw new Error(`tokenizer.json: pre_tokenizer ${pre && pre.type} isn't supported (BertPreTokenizer only)`);
    if (!model || model.type !== "WordPiece") throw new Error(`tokenizer.json: model ${model && model.type} isn't supported (WordPiece only)`);
    this.norm = { clean: n.clean_text !== false, cjk: n.handle_chinese_chars !== false, lower: n.lowercase !== false };
    this.norm.strip = n.strip_accents == null ? this.norm.lower : !!n.strip_accents;
    this.vocab = new Map(Object.entries(model.vocab));
    this.unk = model.unk_token; this.unkId = this.vocab.get(this.unk); this.prefix = model.continuing_subword_prefix ?? "##"; this.maxChars = model.max_input_chars_per_word ?? 100;
    // added tokens: matched in the raw text (normalized: false) or after normalization (normalized: true), longest first
    this.added = (json.added_tokens || []).map((t) => ({ ...t })).sort((a, b) => b.content.length - a.content.length);
    for (const t of this.added) if (t.single_word || t.lstrip || t.rstrip) throw new Error(`tokenizer.json: added token ${t.content} uses single_word/lstrip/rstrip, which isn't supported`);
    // post-processing: [CLS] A [SEP] (and B [SEP] for pairs)
    const special = (tok) => { const id = this.vocab.get(tok) ?? this.added.find((t) => t.content === tok)?.id; if (id == null) throw new Error(`tokenizer.json: special token ${tok} has no id`); return id; };
    if (!post) this.template = { single: [["A", 0]], pair: [["A", 0], ["B", 1]] };
    else if (post.type === "TemplateProcessing") {
      const conv = (seq) => seq.map((p) => (p.Sequence ? [p.Sequence.id, p.Sequence.type_id] : [{ id: post.special_tokens[p.SpecialToken.id].ids[0] }, p.SpecialToken.type_id]));
      this.template = { single: conv(post.single), pair: conv(post.pair) };
    } else if (post.type === "BertProcessing") {
      const cls = { id: post.cls[1] }, sep = { id: post.sep[1] };
      this.template = { single: [[cls, 0], ["A", 0], [sep, 0]], pair: [[cls, 0], ["A", 0], [sep, 0], ["B", 1], [sep, 1]] };
    } else throw new Error(`tokenizer.json: post_processor ${post.type} isn't supported`);
    this.nSpecial = { single: this.template.single.filter(([p]) => typeof p === "object").length, pair: this.template.pair.filter(([p]) => typeof p === "object").length };
  }

  normalize(s) {
    const o = this.norm; let out = "";
    for (const c of s) {
      if (o.clean) { if (c === "\0" || c === "�" || isControl(c)) continue; if (isWhitespace(c)) { out += " "; continue; } }
      if (o.cjk && isCJK(c.codePointAt(0))) { out += " " + c + " "; continue; }
      out += c;
    }
    if (o.strip) { let t = ""; for (const c of out.normalize("NFD")) if (!MN.test(c)) t += c; out = t; }
    if (o.lower) { let t = ""; for (const c of out) t += c.toLowerCase(); out = t; }   // per character, like Rust (no final-sigma rule)
    return out;
  }

  // one piece of text (no added tokens in it) -> ids
  #words(text) {
    const ids = [];
    for (const chunk of this.normalize(text).split(" ")) {
      let word = "";
      const flush = () => { if (word) { this.#wordpiece(word, ids); word = ""; } };
      for (const c of chunk) { if (isWhitespace(c)) { flush(); continue; } if (isPunct(c)) { flush(); this.#wordpiece(c, ids); } else word += c; }
      flush();
    }
    return ids;
  }
  #wordpiece(word, ids) {
    const chars = Array.from(word);
    if (chars.length > this.maxChars) { ids.push(this.unkId); return; }
    const out = []; let start = 0;
    while (start < chars.length) {
      let end = chars.length, cur = null;
      while (start < end) { let sub = chars.slice(start, end).join(""); if (start > 0) sub = this.prefix + sub; const id = this.vocab.get(sub); if (id != null) { cur = id; break; } end--; }
      if (cur == null) { ids.push(this.unkId); return; }
      out.push(cur); start = end;
    }
    ids.push(...out);
  }
  // added tokens typed in the text: split around them (raw-text ones first, then the rest after normalization)
  #sequence(text) {
    const raw = this.added.filter((t) => !t.normalized), norm = this.added.filter((t) => t.normalized);
    const ids = [];
    const splitOn = (s, list, then) => {
      let i = 0, last = 0;
      while (i < s.length) {
        const hit = list.find((t) => s.startsWith(t.content, i));
        if (hit) { if (i > last) then(s.slice(last, i)); ids.push(hit.id); i += hit.content.length; last = i; } else i++;
      }
      if (last < s.length) then(s.slice(last));
    };
    splitOn(text, raw, (piece) => { if (!norm.length) ids.push(...this.#words(piece)); else splitOn(this.normalize(piece), norm, (p) => ids.push(...this.#words(p))); });
    return ids;
  }

  // -> { ids, typeIds } with [CLS]/[SEP], truncated to maxLength like Rust's LongestFirst (right side)
  encode(text, { pair = null, maxLength = null } = {}) {
    let a = this.#sequence(String(text)), b = pair != null ? this.#sequence(String(pair)) : null;
    if (maxLength) {
      const room = maxLength - (b ? this.nSpecial.pair : this.nSpecial.single);
      if (!b) { if (a.length > room) a = a.slice(0, Math.max(0, room)); }
      else if (a.length + b.length > room) {
        let n1 = a.length, n2 = b.length, swap = false;
        if (n1 > n2) { swap = true; [n1, n2] = [n2, n1]; }
        n2 = n1 > room ? n1 : Math.max(n1, room - n1);
        if (n1 + n2 > room) { n1 = Math.floor(room / 2); n2 = n1 + (room % 2); }
        if (swap) [n1, n2] = [n2, n1];
        a = a.slice(0, n1); b = b.slice(0, n2);
      }
    }
    const ids = [], typeIds = [];
    for (const [p, type] of b ? this.template.pair : this.template.single) {
      const seq = typeof p === "object" ? [p.id] : p === "A" ? a : b;
      for (const id of seq) { ids.push(id); typeIds.push(type); }
    }
    return { ids, typeIds };
  }
}
