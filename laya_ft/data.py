"""Data format for fine-tuning Laya.

questions.json  — the questions you'll ask at inference, exactly as you'd send them to Laya:
    {"department": {"type": "choice", "instructions": "...", "criteria": {"billing": "...", ...}},
     "urgency":    {"type": "score",  "instructions": "...", "criteria": ["can wait", "this week", "today"]},
     "needs_human":{"type": "noul",   "instructions": "..."}}

data.jsonl — one line per example: the state (text or JSON) and the correct answer for each question:
    {"state": "Charged twice, fix it today.", "answers": {"department": "billing", "urgency": 2, "needs_human": false}}
  choice -> the option name; score -> level index (0 = first level); noul -> true/false.
  Rows may omit an answer (that question is skipped for that row)."""
import json


def load_questions(path):
    q = json.load(open(path))
    if not isinstance(q, dict) or not q:
        raise SystemExit("questions.json must be a non-empty object of question_id -> question")
    for qid, spec in q.items():
        t = spec.get("type")
        if t not in ("choice", "score", "noul"):
            raise SystemExit("question %r: type must be choice, score or noul (got %r)" % (qid, t))
        if not isinstance(spec.get("instructions"), str):
            raise SystemExit("question %r: 'instructions' must be a string" % qid)
        if t == "choice" and not (isinstance(spec.get("criteria"), dict) and len(spec["criteria"]) >= 2):
            raise SystemExit("question %r: choice needs 'criteria': {option: description-or-null, ...} with >= 2 options" % qid)
        if t == "score" and not (isinstance(spec.get("criteria"), list) and len(spec["criteria"]) >= 2):
            raise SystemExit("question %r: score needs 'criteria': [level0, level1, ...] with >= 2 levels" % qid)
    return q


def load_rows(path, questions, require_answers=True):
    rows, problems = [], []
    for n, line in enumerate(open(path), 1):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError as e:
            problems.append("line %d: not valid JSON (%s)" % (n, e)); continue
        if "state" not in r:
            problems.append("line %d: missing 'state'" % n); continue
        ans = r.get("answers") or {}
        if require_answers and not ans:
            problems.append("line %d: missing 'answers'" % n); continue
        for qid, a in ans.items():
            if qid not in questions:
                problems.append("line %d: answer for unknown question %r" % (n, qid)); continue
            spec = questions[qid]; t = spec["type"]
            if t == "choice" and a not in spec["criteria"]:
                problems.append("line %d: %r must be one of %s, got %r" % (n, qid, list(spec["criteria"]), a))
            elif t == "score" and not (isinstance(a, int) and 0 <= a < len(spec["criteria"])):
                problems.append("line %d: %r must be a level index 0..%d, got %r" % (n, qid, len(spec["criteria"]) - 1, a))
            elif t == "noul" and not isinstance(a, bool):
                problems.append("line %d: %r must be true or false, got %r" % (n, qid, a))
        rows.append(r)
    return rows, problems


def answer_index(spec, a):
    """Answer value -> option index, in Laya's option order."""
    if spec["type"] == "choice": return list(spec["criteria"]).index(a)
    if spec["type"] == "noul": return 1 if a else 0
    return int(a)


def predicted(spec, laya_answer):
    """Laya's answer dict -> answer value in the same form as the data file."""
    if spec["type"] == "choice": return laya_answer["choice"]
    if spec["type"] == "noul": return laya_answer["noul"] >= 0.5
    p = laya_answer["probabilities"]; return int(max(p, key=p.get))


def top_prob(spec, laya_answer):
    if spec["type"] == "choice": return max(laya_answer["probabilities"].values())
    if spec["type"] == "noul": return max(laya_answer["noul"], 1 - laya_answer["noul"])
    return max(laya_answer["probabilities"].values())
