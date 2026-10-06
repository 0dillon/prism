interface ProgressBarProps {
  /** How far through, from 0 to 1. */
  value: number;
  /** What the bar measures, in words, for example "Lesson progress". */
  label: string;
  /** Text shown beside the bar, for example "Concept 3 of 7". Never rely on the bar alone. */
  text?: string;
}

/**
 * A progress bar that says what it measures and shows the number in words as well. Uses
 * the native progress element, so it needs no ARIA and respects the learner's system.
 * It does not animate, so there is nothing to turn off for reduced motion.
 */
export function ProgressBar({ value, label, text }: ProgressBarProps) {
  const clamped = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  const percent = Math.round(clamped * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium">{label}</span>
        <span>{text ?? `${percent} percent`}</span>
      </div>
      <progress
        max={100}
        value={percent}
        aria-label={label}
        aria-valuetext={text ?? `${percent} percent`}
        className="h-3 w-full"
      />
    </div>
  );
}
