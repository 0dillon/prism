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
