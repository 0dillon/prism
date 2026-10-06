import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
    "axe violations",
  ).toEqual([]);
}

test.describe("home page", () => {
  test("loads with a heading and landmarks", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Prism/);
    await expect(page.getByRole("heading", { level: 1, name: "Prism" })).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
  });

  test("has zero axe violations", async ({ page }) => {
    await page.goto("/");
    await expectNoAxeViolations(page);
  });

  test("offers a skip link that moves focus to the main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("exposes polite and assertive live regions", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("status")).toHaveAttribute("aria-live", "polite");
    // Next.js adds its own route announcer with role="alert", so target ours by class.
    await expect(page.locator('.sr-only[role="alert"]')).toHaveAttribute("aria-live", "assertive");
  });
});

test.describe("auth pages", () => {
  for (const path of ["/sign-in", "/sign-up"]) {
    test(`${path} has zero axe violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoAxeViolations(page);
    });
  }

  test("sign-up shows an error for each empty field and focuses the first", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(page.getByLabel("Your name")).toBeFocused();
    await expect(page.getByLabel("Your name")).toHaveAttribute("aria-invalid", "true");
    await expectNoAxeViolations(page);
  });

  test("sign-in keeps the destination in the sign-up link", async ({ page }) => {
    await page.goto("/sign-in?next=/teach/upload");
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/sign-up?next=%2Fteach%2Fupload",
    );
  });
});

test.describe("route protection", () => {
  for (const area of ["/learn", "/teach", "/admin", "/create"]) {
    test(`${area} redirects a signed-out visitor to sign in`, async ({ page }) => {
      await page.goto(area);
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(area)}`));
      await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    });
  }

  test("an off-site next parameter is ignored", async ({ page }) => {
    await page.goto("/sign-in?next=https://evil.example");
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/sign-up?next=%2Flearn",
    );
  });
});

test.describe("onboarding", () => {
  test("loads with a heading, the presets, a preview and the needs box", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { level: 1, name: "How would you like lessons to look?" }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "Pick a starting point" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Preview" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tell Prism what you need" })).toBeVisible();
  });

  test("never asks about or mentions a diagnosis", async ({ page }) => {
    await page.goto("/onboarding");
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/diagnos|disabilit|condition|adhd|dyslex|autis/i);
  });

  test("has zero axe violations", async ({ page }) => {
    await page.goto("/onboarding");
    await expectNoAxeViolations(page);
  });

  for (const preset of [
    "Standard",
    "Talk it through",
    "One idea at a time",
    "Easy reading",
    "Pictures and signs",
  ]) {
    test(`has zero axe violations, including contrast, with the "${preset}" preview`, async ({
      page,
    }) => {
      await page.goto("/onboarding");
      await page.getByRole("button", { name: new RegExp(preset) }).click();
      await expect(page.getByRole("button", { name: new RegExp(preset) })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expectNoAxeViolations(page);
    });
  }

  test("choosing a preset changes the preview immediately", async ({ page }) => {
    await page.goto("/onboarding");
    const preview = page.getByRole("region", { name: "Preview" });
    await expect(preview).toHaveAttribute("data-theme", "system");
    await page.getByRole("button", { name: /Easy reading/ }).click();
    await expect(preview).toHaveAttribute("data-theme", "cream");
    await expect(preview).toHaveAttribute("data-font", "lexend");
    const lineHeight = await preview.evaluate((el) => getComputedStyle(el).lineHeight);
    expect(parseFloat(lineHeight)).toBeGreaterThan(24);
    const font = await preview.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toContain("Lexend");
  });

  test("can be completed with the keyboard alone", async ({ page }) => {
    await page.goto("/onboarding");
    await page.keyboard.press("Tab"); // skip link
    await page.keyboard.press("Tab"); // header link
    await page.keyboard.press("Tab"); // header sign in
    await page.keyboard.press("Tab"); // first preset
    await expect(page.getByRole("button", { name: /Standard/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /One idea at a time/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("remembers the choice after a reload", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByRole("button", { name: /Easy reading/ }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /Easy reading/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("region", { name: "Preview" })).toHaveAttribute(
      "data-theme",
      "cream",
    );
  });

  test("reflows at 320px wide without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/onboarding");
    await expectNoAxeViolations(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("keeps zero axe violations at 200 percent text size", async ({ page }) => {
    await page.goto("/onboarding");
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expectNoAxeViolations(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("an off-site next parameter is ignored by Continue", async ({ page }) => {
    await page.goto("/onboarding?next=https://evil.example");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).not.toHaveURL(/evil\.example/);
  });
});
