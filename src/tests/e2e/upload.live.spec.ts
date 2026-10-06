import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createLiveUser, hasLiveSupabase, type LiveUser } from "./live-session";

// These need a real Supabase project and a signed-in user. They skip in CI.
test.skip(!hasLiveSupabase, "Needs Supabase credentials (run `npm run e2e:live`)");

let user: LiveUser;

test.beforeAll(async () => {
  user = await createLiveUser("127.0.0.1");
});

test.afterAll(async () => {
  await user?.cleanup();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(user.cookies);
});

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("upload page (signed in)", () => {
  test("loads with a heading and an accessible form", async ({ page }) => {
    await page.goto("/teach/upload");
    await expect(page.getByRole("heading", { level: 1, name: "Upload a lesson" })).toBeVisible();
    await expect(page.getByLabel("Lesson title (optional)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose a file" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload and process" })).toBeVisible();
  });

  test("has zero axe violations, including contrast", async ({ page }) => {
    await page.goto("/teach/upload");
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("is operable by keyboard in a sensible order", async ({ page }) => {
    await page.goto("/teach/upload");
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName;
        }),
      );
    }
    const interesting = order.filter((name) =>
      ["Skip to main content", "Prism", "Sign in", "Choose a file", "Upload and process"].includes(
        name,
      ),
    );
    // Skip link comes first, and the form controls follow in reading order.
    expect(interesting[0]).toBe("Skip to main content");
    expect(interesting.indexOf("Choose a file")).toBeLessThan(
      interesting.indexOf("Upload and process"),
    );
  });

  test("selecting a file shows its name, and a bad file shows an error", async ({ page }) => {
    await page.goto("/teach/upload");
    const input = page.locator('input[type="file"]');
    await input.setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Hi\n\nBody."),
    });
    await expect(page.locator("#main-content").getByText("notes.md")).toBeVisible();

    await input.setInputFiles({
      name: "tool.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("x"),
    });
    // The live region repeats messages for screen readers, so look inside the main content.
    await expect(page.locator("#main-content").getByText(/not accepted/)).toBeVisible();
    await expect(page.locator("#main-content").getByText("notes.md")).toHaveCount(0);
  });

  test("submitting with no file asks for one and moves focus to the button", async ({ page }) => {
    await page.goto("/teach/upload");
    await page.getByRole("button", { name: "Upload and process" }).click();
    await expect(page.locator("#main-content").getByText("Choose a file first.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose a file" })).toBeFocused();
  });

  test("keeps zero axe violations with an error showing", async ({ page }) => {
    await page.goto("/teach/upload");
    await page.getByRole("button", { name: "Upload and process" }).click();
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("reflows at 320px wide without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/teach/upload");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
