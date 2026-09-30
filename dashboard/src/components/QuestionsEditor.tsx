import { useMemo } from "react";
import { QuietLink } from "./Button";
import { TextArea } from "./Bits";
import { parseQuestions, SAMPLE_QUESTIONS } from "../lib/domain";

/** A questions-JSON textarea with live validation and a "use the sample" link. */
export function QuestionsEditor({
  id,
  value,
  onChange,
  optional,
  rows = 10,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  rows?: number;
}) {
  const check = useMemo(() => (value.trim() ? parseQuestions(value) : null), [value]);
  const count = check && check.ok ? Object.keys(check.questions).length : 0;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-base font-medium text-ink">
          Questions <span className="font-normal text-slate">· JSON{optional ? ", optional" : ""}</span>
        </label>
        <QuietLink tone="accent" onClick={() => onChange(JSON.stringify(SAMPLE_QUESTIONS, null, 2))}>
          Use the sample (support tickets)
        </QuietLink>
      </div>
      <p className="mb-1 text-sm text-slate">
        The same <code className="font-mono">questions</code> object you send to Jev: id → {"{"} type, instructions, criteria {"}"}.
        {optional && " You can add these later, or let them arrive with your first request."}
      </p>
      <TextArea
        id={id}
        rows={rows}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste a questions object here, or use the sample."
        aria-invalid={check ? !check.ok : undefined}
        aria-describedby={id + "-check"}
      />
      <p id={id + "-check"} className={`mt-1 min-h-[20px] text-sm ${check && !check.ok ? "text-stop" : "text-slate"}`}>
        {check ? (check.ok ? `${count} question${count === 1 ? "" : "s"}: ${Object.keys(check.questions).join(", ")}` : check.error) : ""}
      </p>
    </div>
  );
}
