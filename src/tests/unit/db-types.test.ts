import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createDb } from "../sql/harness";
import { generateDatabaseTypes } from "../../../scripts/db-types-generator";
import type {
  Database,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "@/lib/supabase/database.types";

const TYPES_PATH = join(process.cwd(), "src", "lib", "supabase", "database.types.ts");

describe("generated database types", () => {
  it("match the migrations (run `npm run db:types` if this fails)", async () => {
    const db = await createDb();
    try {
      const generated = await generateDatabaseTypes(db);
      expect(readFileSync(TYPES_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(generated);
    } finally {
      await db.close();
    }
  });

  it("let typed queries compile with the right row shapes", () => {
    const client: SupabaseClient<Database> = createClient<Database>(
      "http://127.0.0.1:54321",
      "anon-key",
    );

    // Building the queries is enough: the assertions below are checked by `tsc`.
    const lessons = client.from("lessons").select("id, title, status, graph_version");
    const mastery = client.from("concept_mastery").select("concept_id, status").eq("user_id", "u");
    const rpc = client.rpc("is_entitled", { p_user: "u", p_lesson: "l" });
    expect(lessons).toBeDefined();
    expect(mastery).toBeDefined();
    expect(rpc).toBeDefined();

    expectTypeOf<Tables<"lessons">["graph"]>().toEqualTypeOf<Json | null>();
    expectTypeOf<Tables<"lessons">["owner_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Tables<"concept_mastery">["last_two_correct"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Tables<"learning_events">["correct"]>().toEqualTypeOf<boolean | null>();
    expectTypeOf<Tables<"ingestion_jobs">["tokens_in"]>().toEqualTypeOf<number>();
  });

  it("require non-default columns on insert and make defaulted ones optional", () => {
    const lesson: TablesInsert<"lessons"> = { owner_id: "user" };
    const profile: TablesInsert<"render_profiles"> = {
      user_id: "user",
      profile: { layout: "cards" },
    };
    const patch: TablesUpdate<"lessons"> = { status: "published" };
    expect([lesson, profile, patch]).toHaveLength(3);

    // @ts-expect-error owner_id is required when inserting a lesson
    const missingOwner: TablesInsert<"lessons"> = { title: "No owner" };
    expect(missingOwner).toBeDefined();
  });
});
