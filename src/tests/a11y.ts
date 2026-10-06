import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core on a rendered container and fails with a readable list of violations.
 * jsdom has no layout engine, so rules that need rendering (color contrast, target size)
 * are off here; the Playwright suite covers those against a real browser.
 */
export async function expectNoAxeViolations(
  container: Element,
  options: { rules?: string[] } = {},
) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
      ...Object.fromEntries((options.rules ?? []).map((id) => [id, { enabled: false }])),
    },
  });
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.html.slice(0, 80)).join(" | ")}`,
    ),
    "axe violations",
  ).toEqual([]);
}
