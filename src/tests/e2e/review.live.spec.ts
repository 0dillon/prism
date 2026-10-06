import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import type { KnowledgeGraph } from "../../lib/schemas/knowledge-graph";
import { makeGraph } from "../fixtures/graph";
import { createLiveUser, hasLiveSupabase, liveEnv, type LiveUser } from "./live-session";

// These need a real Supabase project and a signed-in user. They skip in CI.
test.skip(!hasLiveSupabase, "Needs Supabase credentials (run `npm run e2e:live`)");

// The mutating tests share one seeded lesson, so run in order.
test.describe.configure({ mode: "serial" });

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let user: LiveUser;
let lessonId: string;

const admin = () =>
  createClient(liveEnv.url!, liveEnv.serviceKey!, { auth: { persistSession: false } });

function draftGraph(id: string): KnowledgeGraph {
  const graph = makeGraph();
  graph.lessonId = id;
  graph.sections.push({ id: "s_2", title: "Falling water", order: 1 });
  graph.concepts[2].sectionId = "s_2";
  graph.concepts[1].flags = ["low_confidence"];
  return graph;
}

test.beforeAll(async () => {
  user = await createLiveUser("127.0.0.1");
  const created = await admin()
    .from("lessons")
    .insert({
      owner_id: user.id,
      title: "The Water Cycle",
      status: "needs_review",
      source_type: "md",
    })
    .select("id")
    .single();
  if (created.error) throw created.error;
  lessonId = created.data.id;
  const saved = await admin()
    .from("lessons")
    .update({ graph: draftGraph(lessonId) as never })
    .eq("id", lessonId);
  if (saved.error) throw saved.error;
});

test.afterAll(async () => {
  if (lessonId) await admin().from("lessons").delete().eq("id", lessonId);
  await user?.cleanup();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(user.cookies);
});

const open = async (page: import("@playwright/test").Page) => {
  await page.goto(`/teach/lessons/${lessonId}/review`);
  await expect(
    page.getByRole("heading", { level: 1, name: /Review: The Water Cycle/ }),
  ).toBeVisible();
};

const storedGraph = async () => {
  const { data } = await admin()
    .from("lessons")
    .select("graph, updated_at")
    .eq("id", lessonId)
    .single();
  return data as { graph: KnowledgeGraph; updated_at: string };
};

test.describe("review page (signed in)", () => {
  test("shows concepts by section with flagged ones first", async ({ page }) => {
    await open(page);
    const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.slice(0, 3)).toEqual([
      "Needs your attention",
      "How water moves",
      "Falling water",
    ]);
    await expect(page.getByText(/Prism was not sure about this one/)).toBeVisible();
    await expect(page.getByText("From your file").first()).toBeVisible();
  });

  test("has zero axe violations on desktop, including contrast", async ({ page }) => {
    await open(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });

  test("has zero axe violations at 320px wide and does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("keeps zero axe violations with a delete dialog open", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /Delete concept 1: Evaporation/ }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("target sizes are at least 24px for every control", async ({ page }) => {
    await open(page);
    const small = await page.evaluate(() => {
      const found: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(
        "button, a, input, select, textarea, summary",
      )) {
        if (el.getAttribute("aria-hidden") === "true" || el.classList.contains("sr-only")) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width < 24 || r.height < 24)
          found.push(`${el.tagName} ${el.textContent?.slice(0, 20)} ${r.width}x${r.height}`);
      }
      return found;
    });
    expect(small).toEqual([]);
  });

  test("edits and saves with the keyboard, and the saved draft is flagged as edited by the server", async ({
    page,
  }) => {
    await open(page);
    const title = page.getByLabel("Title", { exact: true }).nth(1); // Evaporation: the flagged concept is first
    await title.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Evaporation of water");
    await expect(page.getByText("You have unsaved changes.")).toBeVisible();

    await page.getByRole("button", { name: "Save changes" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("All changes saved.")).toBeVisible();

    const { graph } = await storedGraph();
    const concept = graph.concepts.find((c) => c.id === "c_evaporation")!;
    expect(concept.title).toBe("Evaporation of water");
    expect(concept.flags).toContain("edited");
    // Untouched concepts are not flagged, and the source excerpt is unchanged.
    expect(graph.concepts.find((c) => c.id === "c_precipitation")!.flags).not.toContain("edited");
    expect(concept.source.excerpt).toBe(makeGraph().concepts[0].source.excerpt);
  });

  test("a delete is not saved until the teacher saves, and respects the confirmation", async ({
    page,
  }) => {
    await open(page);
    const before = (await storedGraph()).graph.concepts.length;
    await page.getByRole("button", { name: /Delete concept 3: Precipitation/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("All changes saved.")).toBeVisible();

    await page.getByRole("button", { name: /Delete concept 3: Precipitation/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete concept" }).click();
    await expect(page.getByText("You have unsaved changes.")).toBeVisible();
    expect((await storedGraph()).graph.concepts.length).toBe(before);

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("All changes saved.")).toBeVisible();
    const { graph } = await storedGraph();
    expect(graph.concepts.length).toBe(before - 1);
    expect(graph.quizItems.some((q) => q.conceptId === "c_precipitation")).toBe(false);
    expect(graph.sections.some((s) => s.id === "s_2")).toBe(false); // the emptied section is gone
  });

  test("detects a change made somewhere else instead of overwriting it", async ({ page }) => {
    await open(page);
    // Another session saves first.
    const { graph } = await storedGraph();
    graph.title = "Changed elsewhere";
    await admin()
      .from("lessons")
      .update({ graph: graph as never })
      .eq("id", lessonId);

    await page.getByLabel("Title", { exact: true }).first().fill("My edit");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator('[role="alert"][tabindex="-1"]')).toContainText(
      /changed somewhere else/,
    );
    await expect(page.getByRole("button", { name: "Reload the latest version" })).toBeVisible();
    expect((await storedGraph()).graph.title).toBe("Changed elsewhere");
  });
});

test("another user cannot open the review page", async ({ page, context }) => {
  const other = await createLiveUser("127.0.0.1");
  try {
    await context.clearCookies();
    await context.addCookies(other.cookies);
    const response = await page.goto(`/teach/lessons/${lessonId}/review`);
    expect(response?.status()).toBe(404);
  } finally {
    await other.cleanup();
  }
});
