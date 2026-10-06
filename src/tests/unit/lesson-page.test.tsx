// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../fixtures/fake-supabase";
import { makeGraph } from "../fixtures/graph";

const LESSON = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const LEARNER = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));

class NavigationSignal extends Error {
  constructor(public readonly kind: string) {
    super(kind);
  }
}

vi.mock("next/navigation", () => ({
  forbidden: () => {
    throw new NavigationSignal("forbidden");
  },
  notFound: () => {
    throw new NavigationSignal("notFound");
  },
  redirect: (to: string) => {
    throw new NavigationSignal(`redirect:${to}`);
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const fake = mocks.db as FakeSupabase;
    return {
      ...fake.asUser(mocks.userId ?? "00000000-0000-4000-8000-000000000000"),
      auth: {
        getUser: async () =>
          mocks.userId
            ? { data: { user: { id: mocks.userId } }, error: null }
            : { data: { user: null }, error: { message: "no session" } },
      },
    };
  },
}));

import LessonPage from "@/app/learn/[lessonId]/page";
import { LessonPlayer } from "@/app/learn/[lessonId]/LessonPlayer";

let db: FakeSupabase;

const open = (id: string) => LessonPage({ params: Promise.resolve({ lessonId: id }) } as never);
const signal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof NavigationSignal ? error.kind : `other:${String(error)}`;
  }
  return "rendered";
};

beforeEach(() => {
  db = new FakeSupabase();
  mocks.db = db;
  mocks.userId = LEARNER;
  db.tables.lessons.push({
    id: LESSON,
    owner_id: OWNER,
    status: "published",
    title: "The Water Cycle",
    graph: makeGraph(),
    graph_version: 2,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("lesson page", () => {
  it("renders the player for a published lesson", async () => {
    const element = await open(LESSON);
    expect(element.props).toMatchObject({ lessonId: LESSON, graphVersion: 2 });
    expect(element.props.graph.concepts).toHaveLength(3);
  });

  it("returns 403 for a draft that is not the user's", async () => {
    db.tables.lessons[0].status = "needs_review";
    expect(await signal(open(LESSON))).toBe("forbidden");
  });

  it("returns 403 for a lesson that does not exist, revealing nothing", async () => {
    expect(await signal(open("44444444-4444-4444-8444-444444444444"))).toBe("forbidden");
  });

  it("returns 404 for an id that is not a UUID", async () => {
    expect(await signal(open("not-a-uuid"))).toBe("notFound");
  });

  it("sends a signed-out visitor to sign in and back", async () => {
    mocks.userId = null;
    expect(await signal(open(LESSON))).toBe(
      `redirect:/sign-in?next=${encodeURIComponent(`/learn/${LESSON}`)}`,
    );
  });

  it("does not hide a real failure behind a 403", async () => {
    db.tables.lessons[0].graph = { nonsense: true };
    expect(await signal(open(LESSON))).toMatch(/^other:/);
  });
});

describe("LessonPlayer", () => {
  it("shows the lesson in the learner's layout and lets them start", async () => {
    render(<LessonPlayer lessonId={LESSON} graphVersion={2} graph={makeGraph()} />);
    expect(await screen.findByRole("heading", { name: /The Water Cycle/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("uses the shared profile store", async () => {
    const { getProfileStore } = await import("@/lib/profile/store");
    getProfileStore().getState().applyPreset("hyper_focus");
    render(<LessonPlayer lessonId={LESSON} graphVersion={2} graph={makeGraph()} />);
    expect(await screen.findByRole("heading", { name: /cards view/ })).toBeInTheDocument();
    getProfileStore().getState().applyPreset("standard");
  });
});
