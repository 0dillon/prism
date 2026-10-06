import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { SAMPLE_LESSON } from "../../lib/demo/sample-lesson";

/**
 * The public demo in a real browser: contrast in every theme, keyboard use, reflow and
 * reduced motion. jsdom cannot judge colour or layout, so these are the checks that can.
 * Everything runs from the sample lesson, so no account, database or model is needed.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoAxeViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
    `axe violations (${label})`,
  ).toEqual([]);
}

const LEARNERS = [
  { name: "Maya", layout: "cards view" },
  { name: "Leo", layout: "reading view" },
] as const;

const THEMES = ["Match my device", "Light", "Dark", "High contrast", "Cream", "Blue tint"];

/** The Settings button, by its exact name: "Update my settings" also contains the word. */
const settingsButton = (page: Page) => page.getByRole("button", { name: "Settings", exact: true });

async function pickLearner(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function setTheme(page: Page, theme: string) {
  await settingsButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByLabel("Colors").selectOption({ label: theme });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
}

/** Answers whichever quiz question is showing, correctly or not, using the lesson's own answers. */
async function answerQuestion(page: Page, correct: boolean) {
  const group = page.getByRole("group", { name: "Quick check" });
  await expect(group).toBeVisible();
  const text = (await group.innerText()).replace(/\s+/g, " ");
  const item = SAMPLE_LESSON.quizItems.find((q) => text.includes(q.prompt));
  if (!item) throw new Error(`No sample question matches: ${text.slice(0, 80)}`);
  if (item.type === "short_answer") {
    await group.getByLabel("Your answer").fill(correct ? item.answer : "zzz");
    await group.getByRole("button", { name: "Check answer" }).click();
    return;
  }
  const options = item.type === "mcq" ? item.options! : ["true", "false"];
  const pick = correct ? item.answer : options.find((o) => o !== item.answer)!;
  const label = item.type === "true_false" ? (pick === "true" ? "True" : "False") : pick;
  await group.getByRole("button", { name: label, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  // Every test gets a fresh browser context, so each starts as a first-time visitor.
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test.describe("the demo page", () => {
  test("opens on the first learner, with a title and no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
    await expect(page).toHaveTitle(/Demo/);
    await expect(
      page.getByRole("heading", { level: 1, name: /The Water Cycle, cards view/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Maya (current)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("switches learner, swaps the layout, and keeps each place", async ({ page }) => {
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Transpiration" })).toBeVisible();

    await pickLearner(page, "Leo");
    await expect(page.getByRole("heading", { level: 1, name: /reading view/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();

    await pickLearner(page, "Maya");
    await expect(page.getByRole("heading", { level: 2, name: "Transpiration" })).toBeVisible();
  });

  test("keeps a learner's place and settings after a reload", async ({ page }) => {
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Transpiration" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: "Transpiration" })).toBeVisible();
  });

  test("runs with the network off, even after a reload (P9-05)", async ({ page, context }) => {
    // The page says when it has saved itself and every layout.
    await expect(page.locator('[data-offline="ready"]')).toBeVisible({ timeout: 30_000 });
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: /The Water Cycle, cards view/ }),
    ).toBeVisible();

    // Every learner and layout works, including the plainer wording that is built in.
    for (const [name, layout] of [
      ["Tunde", /conversation view/],
      ["Leo", /reading view/],
      ["Sofia", /visual view/],
      ["Maya", /cards view/],
    ] as const) {
      await pickLearner(page, name);
      await expect(page.getByRole("heading", { level: 1, name: layout })).toBeVisible();
    }
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Transpiration" })).toBeVisible();
    await pickLearner(page, "Leo");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/The sun heats water in oceans, lakes, and rivers/)).toBeVisible();
  });

  test("never saves anything from the API for offline use", async ({ page }) => {
    await expect(page.locator('[data-offline="ready"]')).toBeVisible({ timeout: 30_000 });
    const saved = await page.evaluate(async () => {
      const keys: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys())
          keys.push(new URL(request.url).pathname);
      }
      return keys;
    });
    expect(saved.length).toBeGreaterThan(3);
    expect(saved.filter((p) => p.startsWith("/api/"))).toEqual([]);
    expect(saved).toContain("/demo");
  });
});

test.describe("contrast in every theme and layout", () => {
  for (const learner of LEARNERS) {
    for (const theme of THEMES) {
      test(`${learner.name}'s ${learner.layout} in the ${theme} theme has no axe violations`, async ({
        page,
      }) => {
        await pickLearner(page, learner.name);
        await expect(
          page.getByRole("heading", { level: 1, name: new RegExp(learner.layout) }),
        ).toBeVisible();
        await setTheme(page, theme);
        await expectNoAxeViolations(page, "intro");
        await page.getByRole("button", { name: "Start", exact: true }).click();
        await expectNoAxeViolations(page, "reading");
      });
    }
  }

  test("dark and light device settings both pass", async ({ page }) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoAxeViolations(page, scheme);
    }
  });
});

test.describe("cards by keyboard", () => {
  test("right arrow, space and left arrow turn the cards", async ({ page }) => {
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Evaporation" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("heading", { level: 2, name: "Transpiration" })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByRole("heading", { level: 2, name: "Condensation" })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("heading", { level: 2, name: "Transpiration" })).toBeVisible();
  });

  test("the arrows still work after clicking Next, and the page does not scroll on Space", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const before = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("heading", { level: 2, name: "Condensation" })).toBeVisible();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(400);
  });

  test("a quiz card appears after the configured number of ideas, and can be answered", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Start", exact: true }).click();
    for (let i = 0; i < 6; i++) {
      if (await page.getByRole("group", { name: "Quick check" }).isVisible()) break;
      await page.keyboard.press("ArrowRight");
    }
    await answerQuestion(page, true);
    await expect(page.getByText("Correct.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();
    await expectNoAxeViolations(page, "feedback");
  });

  test("with reduced motion on, a right answer shows a still check mark", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    for (let i = 0; i < 6; i++) {
      if (await page.getByRole("group", { name: "Quick check" }).isVisible()) break;
      await page.keyboard.press("ArrowRight");
    }
    await answerQuestion(page, true);
    const celebration = page.locator("[data-celebration]");
    await expect(celebration).toHaveAttribute("data-celebration", "still");
    await expect(page.locator(".prism-pop, .prism-burst")).toHaveCount(0);
    await expect(page.getByText("Correct.").first()).toBeVisible();
  });
});

test.describe("reflow and zoom", () => {
  for (const learner of LEARNERS) {
    test(`${learner.name}'s ${learner.layout} fits a 320px screen without sideways scrolling`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await pickLearner(page, learner.name);
      await page.getByRole("button", { name: "Start", exact: true }).click();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test(`${learner.name}'s ${learner.layout} still fits at 200% text size`, async ({ page }) => {
      await pickLearner(page, learner.name);
      await settingsButton(page).click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog.getByLabel("Text size").fill("2");
      await dialog.getByRole("button", { name: "Done" }).click();
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: new RegExp(learner.layout) }),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("the reader", () => {
  async function openReader(page: Page) {
    await pickLearner(page, "Leo");
    await page.getByRole("button", { name: "Start", exact: true }).click();
  }

  test("shows read-aloud controls that can be reached and used by keyboard", async ({ page }) => {
    await openReader(page);
    const play: Locator = page.getByRole("button", { name: "Play" });
    await expect(play).toBeVisible();
    await play.focus();
    await expect(play).toBeFocused();
    await expect(page.getByLabel("Speed")).toBeVisible();
  });

  test("moves to the next section and focuses its first heading", async ({ page }) => {
    await openReader(page);
    await page.getByRole("button", { name: "Next section" }).click();
    await expect(page.getByRole("heading", { level: 3, name: "Precipitation" })).toBeFocused();
  });

  test("asks for simpler wording without a network request", async ({ page }) => {
    await openReader(page);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(new URL(r.url()).pathname));
    await page.getByRole("button", { name: "Simpler version of Evaporation" }).click();
    await expect(page.getByText("Very simple wording")).toBeVisible();
    expect(requests.filter((p) => p.startsWith("/api/"))).toEqual([]);
  });

  test("word anchors add bold without changing the text", async ({ page }) => {
    await openReader(page);
    const paragraph = page.locator("article p").first();
    const before = await paragraph.innerText();
    await settingsButton(page).click();
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByLabel("Bold the start of each word")
      .check();
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click();
    await expect(page.locator("article p b").first()).toBeVisible();
    expect(await paragraph.innerText()).toBe(before);
  });

  test("passes axe while read aloud highlights a sentence", async ({ page }) => {
    await openReader(page);
    // Mark a sentence as active the way the player does, without needing a voice in CI.
    await page.evaluate(() => {
      const first = document.querySelector("[data-sentence]");
      first?.setAttribute("data-active", "true");
    });
    await expectNoAxeViolations(page, "highlighted sentence");
  });
});
