// @vitest-environment jsdom
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfileToServer } from "@/lib/profile/client";
import { presetProfile } from "@/lib/profile/presets";
import { loadProfile, saveProfile, SaveProfileInput } from "@/lib/profile/service";
import { FakeSupabase } from "../fixtures/fake-supabase";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));

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

let db: FakeSupabase;

beforeEach(() => {
  db = new FakeSupabase();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saveProfile and loadProfile", () => {
  it("saves a profile and loads it back", async () => {
    const profile = presetProfile("hyper_focus");
    await saveProfile(db.asUser(USER), USER, profile);
    expect(await loadProfile(db.asUser(USER), USER)).toEqual(profile);
  });

  it("replaces the previous profile instead of adding a second row", async () => {
    await saveProfile(db.asUser(USER), USER, presetProfile("hyper_focus"));
    await saveProfile(db.asUser(USER), USER, presetProfile("voice_native"));
    expect(db.tables.render_profiles).toHaveLength(1);
    expect((await loadProfile(db.asUser(USER), USER))?.preset).toBe("voice_native");
  });

  it("never touches the sharing opt-in when saving", async () => {
    db.tables.render_profiles.push({
      id: "r",
      user_id: USER,
      profile: {},
      share_with_teachers: true,
    });
    await saveProfile(db.asUser(USER), USER, presetProfile("cognitive_ease"));
    expect(db.tables.render_profiles[0].share_with_teachers).toBe(true);
  });

  it("will not save a profile for another user", async () => {
    await expect(
      saveProfile(db.asUser(USER), OTHER, presetProfile("standard")),
    ).rejects.toMatchObject({
      status: 500,
      code: "save_failed",
    });
    expect(db.tables.render_profiles).toHaveLength(0);
  });

  it("does not show one learner another's profile", async () => {
    await saveProfile(db.asUser(USER), USER, presetProfile("hyper_focus"));
    expect(await loadProfile(db.asUser(OTHER), OTHER)).toBeNull();
  });

  it("returns null when nothing is saved or the saved data no longer validates", async () => {
    expect(await loadProfile(db.asUser(USER), USER)).toBeNull();
    db.tables.render_profiles.push({ id: "r", user_id: USER, profile: { layout: "grid" } });
    expect(await loadProfile(db.asUser(USER), USER)).toBeNull();
  });
});

describe("SaveProfileInput", () => {
  it("accepts a valid profile and rejects an invalid one or a missing one", () => {
    expect(SaveProfileInput.safeParse({ profile: presetProfile("standard") }).success).toBe(true);
    expect(SaveProfileInput.safeParse({ profile: { layout: "cards" } }).success).toBe(false);
    expect(SaveProfileInput.safeParse({}).success).toBe(false);
  });

  it("rejects out of range settings", () => {
    const profile = presetProfile("standard");
    profile.quiz.cadence = 99;
    expect(SaveProfileInput.safeParse({ profile }).success).toBe(false);
  });
});

describe("saveProfileToServer", () => {
  const stub = (status: number) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("sends the profile as a PUT", async () => {
    const fetchMock = stub(200);
    await saveProfileToServer(presetProfile("hyper_focus"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/profile");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string).profile.layout).toBe("cards");
  });

  it("treats a signed-out visitor as fine: the profile stays on the device", async () => {
    stub(401);
    await expect(saveProfileToServer(presetProfile("standard"))).resolves.toBeUndefined();
  });

  it("raises on other failures so the store can show the save failed", async () => {
    stub(500);
    await expect(saveProfileToServer(presetProfile("standard"))).rejects.toThrow(/500/);
  });
});

describe("PUT /api/profile", () => {
  const put = (body: unknown) =>
    new NextRequest("http://localhost/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    mocks.db = db;
    mocks.userId = USER;
  });

  it("returns 401 without a session", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    mocks.userId = null;
    expect((await PUT(put({ profile: presetProfile("standard") }))).status).toBe(401);
    expect(db.tables.render_profiles).toHaveLength(0);
  });

  it("saves a valid profile for the signed-in user", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    const response = await PUT(put({ profile: presetProfile("voice_native") }));
    expect(response.status).toBe(200);
    expect(db.tables.render_profiles[0]).toMatchObject({ user_id: USER });
  });

  it("returns 400 for an invalid profile and saves nothing", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    const bad = presetProfile("standard");
    bad.audio.rate = 9;
    const response = await PUT(put({ profile: bad }));
    expect(response.status).toBe(400);
    expect(db.tables.render_profiles).toHaveLength(0);
  });

  it("ignores a user id in the body: it always saves for the caller", async () => {
    const { PUT } = await import("@/app/api/profile/route");
    await PUT(put({ profile: presetProfile("standard"), userId: OTHER, user_id: OTHER }));
    expect(db.tables.render_profiles.map((r) => r.user_id)).toEqual([USER]);
  });
});
