import { useId, type ComponentPropsWithoutRef } from "react";

interface TextFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "id" | "className"> {
  label: string;
  /** Helper text shown under the label and read with the field. */
  hint?: string;
  /** Error text. When set the field is marked invalid and the text is read with it. */
  error?: string;
}

/**
 * A labelled text input. The label is a real <label>, hint and error text are tied to
 * the input with aria-describedby, and an error is shown as text with an icon so it
 * never depends on color alone.
 */
export function TextField({ label, hint, error, ...inputProps }: TextFieldProps) {
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
      <input
        {...inputProps}
        id={id}
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
