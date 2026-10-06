import { useId, type ComponentPropsWithoutRef } from "react";

interface SelectFieldProps extends Omit<ComponentPropsWithoutRef<"select">, "id" | "className"> {
  label: string;
  options: { value: string; label: string }[];
}

/** A labelled native select. Native selects are the most accessible choice for short lists. */
export function SelectField({ label, options, ...props }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <select
        {...props}
        id={id}
        className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
