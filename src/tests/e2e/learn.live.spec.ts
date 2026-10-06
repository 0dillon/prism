import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { makeGraph } from "../fixtures/graph";
import { createLiveUser, hasLiveSupabase, liveEnv, type LiveUser } from "./live-session";

// These need a real Supabase project and signed-in users. They skip in CI.
test.skip(!hasLiveSupabase, "Needs Supabase credentials (run `npm run e2e:live`)");
test.describe.configure({ mode: "serial" });

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const admin = () =>
  createClient(liveEnv.url!, liveEnv.serviceKey!, { auth: { persistSession: false } });

let teacher: LiveUser;
let learner: LiveUser;
let publishedId: string;
let draftId: string;

async function makeLesson(status: string): Promise<string> {
  const created = await admin()
    .from("lessons")
    .insert({ owner_id: teacher.id, title: "The Water Cycle", status, graph_version: 1 })
    .select("id")
    .single();
  if (created.error) throw created.error;
  const graph = { ...makeGraph(), lessonId: created.data.id };
  const saved = await admin()
    .from("lessons")
    .update({ graph: graph as never })
    .eq("id", created.data.id);
  if (saved.error) throw saved.error;
  return created.data.id;
}

test.beforeAll(async () => {
  teacher = await createLiveUser("127.0.0.1");
  learner = await createLiveUser("127.0.0.1");
  publishedId = await makeLesson("published");
  draftId = await makeLesson("needs_review");
});

test.afterAll(async () => {
  await admin().from("lessons").delete().in("id", [publishedId, draftId].filter(Boolean));
  await teacher?.cleanup();
  await learner?.cleanup();
});

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  await context.addCookies(learner.cookies);
});

test("an entitled learner sees the published lesson", async ({ page }) => {
  const response = await page.goto(`/learn/${publishedId}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: /The Water Cycle/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});

test("has zero axe violations", async ({ page }) => {
  await page.goto(`/learn/${publishedId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("reloading mid lesson restores the same concept", async ({ page }) => {
  await page.goto(`/learn/${publishedId}`);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Evaporation", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Condensation", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Condensation", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
});

test("a draft lesson that is not yours returns a 403 page", async ({ page }) => {
  const response = await page.goto(`/learn/${draftId}`);
  expect(response?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: /do not have access/ })).toBeVisible();
});

test("a lesson that does not exist looks the same as one you may not see", async ({ page }) => {
  const response = await page.goto("/learn/44444444-4444-4444-8444-444444444444");
  expect(response?.status()).toBe(403);
});

test("a malformed id is a 404", async ({ page }) => {
  const response = await page.goto("/learn/not-a-lesson");
  expect(response?.status()).toBe(404);
});

test("the 403 page has zero axe violations", async ({ page }) => {
  await page.goto(`/learn/${draftId}`);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("a signed-out visitor is sent to sign in and returned afterwards", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto(`/learn/${publishedId}`);
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return [url.pathname, url.searchParams.get("next")];
    })
    .toEqual(["/sign-in", `/learn/${publishedId}`]);
});
