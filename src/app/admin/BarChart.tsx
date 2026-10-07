import { useId } from "react";

export interface BarPoint {
  label: string;
  value: number;
  /** The value in words for the table and the labels, for example "3 hours". */
  text: string;
}

interface BarChartProps {
  title: string;
  /** What the numbers are, for the table's value column. */
  valueHeading: string;
  /** A sentence that says what the chart shows, for people who cannot see it. */
  summary: string;
  points: BarPoint[];
}

const WIDTH = 640;
const HEIGHT = 220;
const MARGIN = { top: 24, right: 8, bottom: 40, left: 8 };

/**
 * A bar chart with its data stated three ways, so nothing depends on seeing the bars: a
 * sentence that summarises it, the value written above every bar, and the same numbers in a
 * table. The drawing itself is hidden from assistive technology because those do the job.
 */
export function BarChart({ title, valueHeading, summary, points }: BarChartProps) {
  const id = useId();
  const max = Math.max(1, ...points.map((p) => p.value));
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const slot = points.length === 0 ? plotWidth : plotWidth / points.length;
  const barWidth = Math.min(48, slot * 0.7);

  return (
    <figure aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <figcaption id={`${id}-title`} className="text-lg font-semibold">
        {title}
      </figcaption>
      <p>{summary}</p>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        aria-hidden="true"
        focusable="false"
        className="h-auto w-full max-w-2xl"
      >
        <line
          x1={MARGIN.left}
          x2={WIDTH - MARGIN.right}
          y1={HEIGHT - MARGIN.bottom}
          y2={HEIGHT - MARGIN.bottom}
          stroke="currentColor"
          strokeWidth={1}
        />
        {points.map((point, index) => {
          const height = (point.value / max) * plotHeight;
          const x = MARGIN.left + slot * index + (slot - barWidth) / 2;
          const y = HEIGHT - MARGIN.bottom - height;
          return (
            <g key={point.label}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(height, point.value > 0 ? 1 : 0)}
                fill="var(--accent)"
              />
              <text
                x={x + barWidth / 2}
                y={y - 6}
                textAnchor="middle"
                fontSize={13}
                fill="currentColor"
              >
                {point.value}
              </text>
              <text
                x={x + barWidth / 2}
                y={HEIGHT - MARGIN.bottom + 18}
                textAnchor="middle"
                fontSize={12}
                fill="currentColor"
              >
                {point.label}
              </text>
            </g>
          );
        })}
      </svg>
      <details>
        <summary className="min-h-11 cursor-pointer font-medium underline">View as a table</summary>
        <table className="mt-2 w-full max-w-2xl border-collapse text-start">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col" className="border-line border-b p-2 text-start">
                Week starting
              </th>
              <th scope="col" className="border-line border-b p-2 text-start">
                {valueHeading}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.label} className="border-line border-b">
                <th scope="row" className="p-2 text-start font-normal">
                  {point.label}
                </th>
                <td className="p-2">{point.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
