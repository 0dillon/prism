import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { SAMPLE_LESSON } from "../../lib/demo/sample-lesson";
import { DEMO_LEARNER_ACCOUNTS, progressEvents } from "../../lib/demo/seed-plan";
import {
  createLiveUser,
  hasLiveSupabase,
  hasSchoolSchema,
  liveAdmin,
  type LiveUser,
} from "./live-session";

/**
 * The school journey from start to finish, in a real browser against a real Supabase project
 * (PRD P6-17): a principal sets up a school and invites a teacher; the teacher accepts, makes a
 * class, adds three students and assigns a lesson; the students, each with a different preset,
 * open it and make progress; and the teacher's and principal's dashboards show all three.
 *
 * The lesson is the sample lesson, published through the same database function the review
 * page uses, so the run does not depend on a model. The students make progress by sending
 * events to the real events endpoint with their own sessions, as the lesson page does.
 *
 * Needs `npm run e2e:live` and a project with the Phase 6 migrations applied; skips otherwise.
 */

test.skip(!hasLiveSupabase, "Needs Supabase credentials (run `npm run e2e:live`)");
test.describe.configure({ mode: "serial" });

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const HOST = "127.0.0.1";
const TOTAL = SAMPLE_LESSON.concepts.length;

// Maya is on cards, Tunde in conversation and Sofia in the visual view; their names come from the seed plan.
const STUDENTS = DEMO_LEARNER_ACCOUNTS.map((a) => ({
  name: a.displayName,
  profile: a.profile,
  mastered: a.masteredIdeas,
  account: a,
}));

let principal: LiveUser;
let teacher: LiveUser;
let students: LiveUser[] = [];
let lessonId: string;
let graphVersion: number;
let orgId: string;
let classroomId: string;

async function as(context: BrowserContext, user: LiveUser) {
  await context.clearCookies();
  await context.addCookies(user.cookies);
}

async function expectNoAxeViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.help}`),
    `axe violations (${label})`,
  ).toEqual([]);
}

test.beforeAll(async () => {
  test.skip(!(await hasSchoolSchema()), "Apply the Phase 6 migrations first (supabase db push)");

  principal = await createLiveUser(HOST, { name: "Ms Okafor" });
  teacher = await createLiveUser(HOST, { name: "Mr Reyes" });
  students = [];
  for (const s of STUDENTS) {
    const user = await createLiveUser(HOST, { name: s.name, birthDate: "2012-03-05" });
    // Each student has chosen their own settings, as they would in onboarding.
    const saved = await liveAdmin()
      .from("render_profiles")
      .upsert({ user_id: user.id, profile: s.profile as never }, { onConflict: "user_id" });
    if (saved.error) throw saved.error;
    students.push(user);
  }

  // The teacher's lesson, published as the teacher through the same function the review page uses.
  const created = await teacher.db
    .from("lessons")
    .insert({
      owner_id: teacher.id,
      title: SAMPLE_LESSON.title,
      status: "needs_review",
      source_type: "md",
      graph: { ...SAMPLE_LESSON } as never,
    })
    .select("id")
    .single();
  if (created.error) throw created.error;
  lessonId = created.data.id;
  const published = await teacher.db.rpc("publish_lesson", {
    p_lesson_id: lessonId,
    p_graph: { ...SAMPLE_LESSON, lessonId } as never,
  });
  if (published.error) throw published.error;
  graphVersion = published.data as number;
});

test.afterAll(async () => {
  const admin = liveAdmin();
  if (orgId) await admin.from("organizations").delete().eq("id", orgId);
  if (lessonId) await admin.from("lessons").delete().eq("id", lessonId);
  for (const user of [principal, teacher, ...students]) await user?.cleanup();
});

test("a principal sets up a school and becomes its principal", async ({ page, context }) => {
  await as(context, principal);
  await page.goto("/admin");
  // With no school yet, the admin page sends the principal to set one up.
  await expect(page).toHaveURL(/\/admin\/setup$/);
  await expectNoAxeViolations(page, "school setup");

  await page.getByLabel("School name").fill("Oak Ridge School");
  await page.getByRole("button", { name: "Set up my school" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Oak Ridge School" })).toBeVisible();

  const { data } = await liveAdmin()
    .from("org_memberships")
    .select("org_id, role")
    .eq("user_id", principal.id)
    .single();
  expect(data?.role).toBe("principal");
  orgId = data!.org_id;
});

test("the principal invites a teacher, who accepts and joins as a teacher", async ({
  browser,
  page,
  context,
}) => {
  await as(context, principal);
  await page.goto("/admin");
  await page.getByLabel("Email address").fill(teacher.email);
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = await page.getByLabel(`Invitation link for ${teacher.email}`).inputValue();
  expect(link).toMatch(/\/invite\/[0-9a-f]{64}$/);

  const teacherContext = await browser.newContext();
  await teacherContext.addCookies(teacher.cookies);
  const teacherPage = await teacherContext.newPage();
  await teacherPage.goto(new URL(link).pathname);
  await teacherPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(teacherPage).toHaveURL(/\/teach\/classrooms$/);
  await teacherContext.close();

  const { data } = await liveAdmin()
    .from("org_memberships")
    .select("role")
    .eq("user_id", teacher.id)
    .eq("org_id", orgId)
    .single();
  expect(data?.role).toBe("teacher");
});

test("the teacher makes a class, adds the three students and assigns the lesson", async ({
  page,
  context,
}) => {
  await as(context, teacher);
  await page.goto("/teach/classrooms");
  await page.getByLabel("Class name").fill("Year 5 Science");
  await page.getByLabel("Grade (optional)").fill("5");
  await page.getByLabel("Subject (optional)").fill("Science");
  await page.getByRole("button", { name: "Create class" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Year 5 Science" })).toBeVisible();
  classroomId = page.url().split("/").pop()!;
  await expectNoAxeViolations(page, "class page");

  await page.getByLabel("Email addresses").fill(students.map((s) => s.email).join("\n"));
  await page.getByRole("button", { name: "Add students" }).click();
  const result = page.getByRole("region", { name: "Result of adding students" });
  await expect(result).toContainText("3 added");

  await page.goto(`/teach/lessons/${lessonId}/progress`);
  await page.getByRole("checkbox", { name: /Year 5 Science/ }).check();
  await page.getByLabel("Due date (optional)").fill("2030-01-31");
  await page.getByRole("button", { name: "Assign lesson" }).click();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /Year 5 Science/ })).toBeChecked();
  await expect(page.getByText(/already assigned, due 31 jan 2030/)).toBeVisible();
});

for (const [index, student] of STUDENTS.entries()) {
  test(`${student.name} sees the lesson under Assigned and opens it in their own layout`, async ({
    page,
    context,
  }) => {
    await as(context, students[index]);
    await page.goto("/learn");
    const assigned = page.getByRole("region", { name: "Assigned" });
    await expect(assigned.getByRole("link", { name: SAMPLE_LESSON.title })).toBeVisible();
    await expect(assigned).toContainText("Due 31 Jan 2030");

    await page.goto(`/learn/${lessonId}`);
    await expect(page.locator(`[data-layout="${student.profile.layout}"]`)).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(`${student.profile.layout} view`) }),
    ).toBeVisible();
  });

  test(`${student.name} makes progress, which is saved by the events endpoint`, async ({
    page,
    context,
  }) => {
    await as(context, students[index]);
    await page.goto(`/learn/${lessonId}`);
    const events = progressEvents({
      userId: students[index].id,
      lessonId,
      graphVersion,
      learner: student.account,
    }).map((e) => ({
      id: `e2e-${students[index].id.slice(0, 8)}-${e.id}`.slice(0, 40),
      lessonId,
      graphVersion,
      type: e.type,
      conceptId: e.concept_id,
      quizItemId: e.quiz_item_id,
      correct: e.correct,
      durationMs: e.duration_ms,
      layout: e.layout,
      occurredAt: e.occurred_at,
    }));
    const response = await page.evaluate(async (batch) => {
      const r = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
      return { status: r.status, body: await r.json() };
    }, events);
    expect(response.status).toBe(200);
    expect(response.body.rejected).toBe(0);

    await page.goto("/learn");
    await expect(
      page.getByText(`${student.mastered} of ${TOTAL} ideas mastered`, { exact: false }),
    ).toBeVisible();
  });
}

test("the teacher's grid shows all three students on one scale", async ({ page, context }) => {
  await as(context, teacher);
  await page.goto(`/teach/classrooms/${classroomId}`);
  const grid = page.getByRole("table", { name: /Mastery of each idea in/ });
  for (const student of STUDENTS) {
    const row = grid.getByRole("row", { name: new RegExp(student.name) });
    await expect(row).toContainText(`${student.mastered} of ${TOTAL}`);
  }
  await expectNoAxeViolations(page, "teacher dashboard");

  // Sorting by ideas mastered puts the furthest along first.
  await grid.getByRole("button", { name: /^Mastered/ }).click();
  await expect(grid.getByRole("rowheader").first()).toContainText("Maya");

  // The hardest ideas are ranked, and the layout is nowhere on the page.
  await expect(page.getByRole("heading", { name: /Hardest ideas in/ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/cards view|conversation view|visual view/);
});

test("a student's settings stay private until the student shares them", async ({
  browser,
  page,
  context,
}) => {
  await as(context, teacher);
  await page.goto(`/teach/classrooms/${classroomId}`);
  await page.getByRole("link", { name: "Maya" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Maya" })).toBeVisible();
  await expect(page.getByText(/has not shared their settings with teachers/)).toBeVisible();
  await expect(page.getByText("Showing the lesson as cards")).toHaveCount(0);
  const studentUrl = page.url();

  const mayaContext = await browser.newContext();
  await mayaContext.addCookies(students[0].cookies);
  const mayaPage = await mayaContext.newPage();
  await mayaPage.goto("/learn");
  const toggle = mayaPage.getByRole("checkbox", { name: "Share my settings with my teachers" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await mayaContext.close();

  await page.goto(studentUrl);
  await expect(page.getByText("Showing the lesson as cards")).toBeVisible();
  await expect(page.getByText(/preferences, not a diagnosis/)).toBeVisible();

  // The choice was recorded where the principal can see that it changed, and nothing more.
  const log = await liveAdmin()
    .from("audit_log")
    .select("metadata")
    .eq("org_id", orgId)
    .eq("action", "profile_sharing.changed");
  expect(log.data).toEqual([{ metadata: { shared: true } }]);
});

test("the principal's dashboard shows the class, its activity and a CSV with no layout data", async ({
  page,
  context,
}) => {
  await as(context, principal);
  await page.goto("/admin");
  const row = page.getByRole("row", { name: /Year 5 Science/ });
  await expect(row).toContainText("Mr Reyes");
  await expect(row).toContainText("3 of 3");
  await expectNoAxeViolations(page, "principal dashboard");

  // Three learners is fewer than five, so no layout is counted.
  await expect(page.getByText(/not enough learners yet/)).toBeVisible();
  await expect(page.getByRole("table", { name: /Learners by how they view lessons/ })).toHaveCount(
    0,
  );

  // Filters are in the URL and survive a reload.
  await page.getByLabel("Grade").selectOption("5");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/grade=5/);
  await page.reload();
  await expect(page.getByLabel("Grade")).toHaveValue("5");
  await expect(page.getByRole("row", { name: /Year 5 Science/ })).toBeVisible();

  const csv = await context.request.get(`/api/orgs/${orgId}/export?grade=5`);
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body.split("\r\n")[0]).toBe(
    "Class,Teacher,Grade,Subject,Students,Assigned lessons,Completion (%),Average mastery (%),Active learners,Time on task (minutes)",
  );
  expect(body).toContain("Year 5 Science,Mr Reyes,5,Science,3,1,");
  expect(body).not.toMatch(/layout|cards|conversation|visual|profile/i);
});

test("a teacher cannot read the principal's school page, and a stranger sees no class", async ({
  page,
  context,
}) => {
  await as(context, teacher);
  const asTeacher = await context.request.get(`/api/orgs/${orgId}/export`);
  expect(asTeacher.status()).toBe(404);

  const stranger = await createLiveUser(HOST, { name: "Stranger" });
  try {
    await as(context, stranger);
    await page.goto(`/teach/classrooms/${classroomId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Year 5 Science" })).toHaveCount(0);
  } finally {
    await stranger.cleanup();
  }
});
