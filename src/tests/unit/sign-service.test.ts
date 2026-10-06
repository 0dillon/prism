import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/http";
import { loadSignReview, SignAction, updateSignLink } from "@/lib/lessons/sign-service";
import { FakeSupabase } from "../fixtures/fake-supabase";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let db: FakeSupabase;
let lessonId: string;

const addLink = (conceptId: string, extra: Record<string, unknown> = {}) =>
  db.tables.concept_sign_links.push({
    id: `link-${conceptId}`,
    lesson_id: lessonId,
    concept_id: conceptId,
    verified: false,
    verified_by: null,
    sign_clips: {
      gloss: conceptId.toUpperCase(),
      storage_path: `asl/${conceptId}.mp4`,
      license: "CC-BY-4.0",
      signer_credit: "A. Signer",
    },
    ...extra,
  });

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected a rejection");
};

beforeEach(() => {
  db = new FakeSupabase();
  lessonId = db.seedLesson({ owner_id: OWNER, status: "needs_review" }).id as string;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadSignReview", () => {
  it("returns each proposed link with its clip details and a signed URL", async () => {
    addLink("water");
    addLink("rain", { verified: true });
    const signUrl = vi.fn(async (path: string) => `https://signed.test/${path}`);
    const items = await loadSignReview(db.asUser(OWNER), OWNER, lessonId, { signUrl });
    expect(items).toEqual([
      {
        conceptId: "water",
        verified: false,
        gloss: "WATER",
        license: "CC-BY-4.0",
        signerCredit: "A. Signer",
        clipUrl: "https://signed.test/asl/water.mp4",
      },
      {
        conceptId: "rain",
        verified: true,
        gloss: "RAIN",
        license: "CC-BY-4.0",
        signerCredit: "A. Signer",
        clipUrl: "https://signed.test/asl/rain.mp4",
      },
    ]);
    expect(signUrl).toHaveBeenCalledTimes(2);
  });

  it("skips a link whose clip is missing", async () => {
    addLink("water", { sign_clips: null });
    expect(
      await loadSignReview(db.asUser(OWNER), OWNER, lessonId, { signUrl: async () => "u" }),
    ).toEqual([]);
  });

  it("returns an empty list for a lesson with no links", async () => {
    expect(
      await loadSignReview(db.asUser(OWNER), OWNER, lessonId, { signUrl: async () => "u" }),
    ).toEqual([]);
  });

  it("treats someone else's lesson as not found", async () => {
    expect((await rejection(loadSignReview(db.asUser(OTHER), OTHER, lessonId))).status).toBe(404);
  });
});

describe("updateSignLink", () => {
  it("verifies a link and records who verified it", async () => {
    addLink("water");
    const result = await updateSignLink(db.asUser(OWNER), OWNER, lessonId, {
      conceptId: "water",
      action: "verify",
    });
    expect(result).toEqual({ conceptId: "water", verified: true });
    expect(db.tables.concept_sign_links[0]).toMatchObject({ verified: true, verified_by: OWNER });
  });

  it("un-verifies a link and clears the verifier", async () => {
    addLink("water", { verified: true, verified_by: OWNER });
    await updateSignLink(db.asUser(OWNER), OWNER, lessonId, {
      conceptId: "water",
      action: "unverify",
    });
    expect(db.tables.concept_sign_links[0]).toMatchObject({ verified: false, verified_by: null });
  });

  it("removes a link", async () => {
    addLink("water");
    addLink("rain");
    const result = await updateSignLink(db.asUser(OWNER), OWNER, lessonId, {
      conceptId: "water",
      action: "remove",
    });
    expect(result).toEqual({ conceptId: "water", verified: null });
    expect(db.tables.concept_sign_links.map((l) => l.concept_id)).toEqual(["rain"]);
  });

  it("only touches the named concept", async () => {
    addLink("water");
    addLink("rain");
    await updateSignLink(db.asUser(OWNER), OWNER, lessonId, {
      conceptId: "rain",
      action: "verify",
    });
    expect(db.tables.concept_sign_links.map((l) => l.verified)).toEqual([false, true]);
  });

  it("reports a link that does not exist", async () => {
    expect(
      (
        await rejection(
          updateSignLink(db.asUser(OWNER), OWNER, lessonId, {
            conceptId: "ghost",
            action: "verify",
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await rejection(
          updateSignLink(db.asUser(OWNER), OWNER, lessonId, {
            conceptId: "ghost",
            action: "remove",
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("refuses a user who does not own the lesson, and changes nothing", async () => {
    addLink("water");
    const error = await rejection(
      updateSignLink(db.asUser(OTHER), OTHER, lessonId, { conceptId: "water", action: "verify" }),
    );
    expect(error.status).toBe(404);
    expect(db.tables.concept_sign_links[0].verified).toBe(false);
  });

  it("reports a database failure generically", async () => {
    addLink("water");
    db.failures.add("concept_sign_links.update");
    const error = await rejection(
      updateSignLink(db.asUser(OWNER), OWNER, lessonId, { conceptId: "water", action: "verify" }),
    );
    expect(error).toMatchObject({ status: 500, code: "update_failed" });
    expect(error.message).not.toContain("injected");
  });
});

describe("SignAction", () => {
  it("accepts the three actions and rejects anything else", () => {
    for (const action of ["verify", "unverify", "remove"]) {
      expect(SignAction.safeParse({ conceptId: "c", action }).success).toBe(true);
    }
    expect(SignAction.safeParse({ conceptId: "c", action: "delete" }).success).toBe(false);
    expect(SignAction.safeParse({ conceptId: "", action: "verify" }).success).toBe(false);
    expect(SignAction.safeParse({ action: "verify" }).success).toBe(false);
  });
});
