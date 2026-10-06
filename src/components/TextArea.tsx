import { useId, type ComponentPropsWithoutRef } from "react";

interface TextAreaProps extends Omit<ComponentPropsWithoutRef<"textarea">, "id" | "className"> {
  label: string;
  hint?: string;
  error?: string;
}

/** A labelled multi-line field. Hint and error text are tied to it with aria-describedby. */
export function TextArea({ label, hint, error, rows = 3, ...props }: TextAreaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-muted text-sm">
          {hint}
        </p>
      ) : null}
      <textarea
        {...props}
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
      />
      {error ? (
        <p id={errorId} className="text-danger flex items-start gap-1 text-sm font-medium">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
