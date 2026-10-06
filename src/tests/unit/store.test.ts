import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  INGESTION_STAGES,
  isIngestionStage,
  overallProgress,
  STAGE_LABELS,
} from "@/lib/ai/ingestion/stages";
import { createSupabaseStore, parseArtifacts } from "@/lib/ai/ingestion/store";
import type { Database } from "@/lib/supabase/database.types";
import { makeGraph } from "../fixtures/graph";

describe("stages", () => {
  it("lists the PRD stages in order, each with a plain-language label", () => {
    expect(INGESTION_STAGES).toEqual([
      "uploading",
      "reading",
      "extracting",
      "merging",
      "generating_quizzes",
      "validating",
      "ready",
    ]);
    for (const stage of INGESTION_STAGES) expect(STAGE_LABELS[stage].length).toBeGreaterThan(3);
    expect(STAGE_LABELS.ready).toBe("Ready for review");
  });

  it("never lets overall progress decrease from one stage to the next", () => {
    const starts = INGESTION_STAGES.map((stage) => overallProgress(stage, 0));
    const ends = INGESTION_STAGES.map((stage) => overallProgress(stage, 1));
    for (let i = 1; i < INGESTION_STAGES.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(ends[i - 1]);
    }
    expect(overallProgress("ready")).toBe(100);
    expect(overallProgress("uploading", 0)).toBe(0);
  });

  it("interpolates within a stage and clamps the fraction", () => {
    const mid = overallProgress("extracting", 0.5);
    expect(mid).toBeGreaterThan(overallProgress("extracting", 0));
    expect(mid).toBeLessThan(overallProgress("extracting", 1));
    expect(overallProgress("extracting", -3)).toBe(overallProgress("extracting", 0));
    expect(overallProgress("extracting", 9)).toBe(overallProgress("extracting", 1));
  });

  it("recognizes stage names", () => {
    expect(isIngestionStage("merging")).toBe(true);
    expect(isIngestionStage("nonsense")).toBe(false);
  });
});

describe("parseArtifacts", () => {
  it("keeps valid artifacts and drops invalid ones", () => {
    const graph = makeGraph();
    const result = parseArtifacts({
      merged: {
        title: graph.title,
        overview: graph.overview,
        sections: graph.sections,
        concepts: graph.concepts,
      },
      quiz: { items: "not an array", shortfalls: [] },
      chunks: [{ bad: true }],
    });
    expect(Object.keys(result)).toEqual(["merged"]);
  });

  it.each([null, undefined, 5, "text", []])("returns nothing for %j", (value) => {
    expect(parseArtifacts(value)).toEqual({});
  });
});

/** A recording stand-in for the parts of the Supabase client the store uses. */
function fakeAdmin(rows: { job?: Record<string, unknown>; fail?: boolean } = {}) {
  const log: { table: string; op: string; payload?: unknown; filter?: [string, unknown] }[] = [];
  const message = rows.fail ? { message: "boom" } : null;

  const from = (table: string) => {
    let op = "";
    let payload: unknown;
    const finish = (filter?: [string, unknown]) => {
      log.push({ table, op, payload, filter });
    };
    const builder = {
      select: (columns: string) => {
        op = `select ${columns}`;
        return builder;
      },
      update: (row: unknown) => {
        op = "update";
        payload = row;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        finish([column, value]);
        return op.startsWith("select") ? builder : Promise.resolve({ error: message });
      },
      single: () => Promise.resolve({ data: rows.fail ? null : rows.job, error: message }),
    };
    return builder;
  };

  const download = vi.fn(async () => ({
    data: rows.fail ? null : new Blob([new Uint8Array([1, 2, 3])]),
    error: message,
  }));
  const storageFrom = vi.fn(() => ({ download }));

  const admin = { from, storage: { from: storageFrom } } as unknown as SupabaseClient<Database>;
  return { admin, log, storageFrom };
}

describe("createSupabaseStore", () => {
  it("downloads from the private sources bucket", async () => {
    const { admin, storageFrom } = fakeAdmin();
    const bytes = await createSupabaseStore(admin).downloadSource("u/l/source.pdf");
    expect(storageFrom).toHaveBeenCalledWith("sources");
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("raises a readable error when the download fails", async () => {
    const { admin } = fakeAdmin({ fail: true });
    await expect(createSupabaseStore(admin).downloadSource("x")).rejects.toThrow(
      /Could not read the uploaded file: boom/,
    );
  });

  it("loads a job and converts database numbers", async () => {
    const { admin, log } = fakeAdmin({
      job: {
        stage: "merging",
        progress: 55,
        artifacts: {},
        tokens_in: "1200",
        tokens_out: 300,
        cost_usd: "0.012",
      },
    });
    const job = await createSupabaseStore(admin).loadJob("job-1");
    expect(job).toEqual({
      stage: "merging",
      progress: 55,
      artifacts: {},
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: 0.012,
    });
    expect(log[0]).toMatchObject({ table: "ingestion_jobs", filter: ["id", "job-1"] });
  });

  it("maps job updates to column names and rounds progress", async () => {
    const { admin, log } = fakeAdmin();
    await createSupabaseStore(admin).updateJob("job-1", {
      stage: "extracting",
      progress: 33.6,
      error: null,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.5,
      artifacts: {},
    });
    expect(log[0]).toMatchObject({
      table: "ingestion_jobs",
      op: "update",
      filter: ["id", "job-1"],
      payload: {
        stage: "extracting",
        progress: 34,
        error: null,
        tokens_in: 10,
        tokens_out: 5,
        cost_usd: 0.5,
        artifacts: {},
      },
    });
  });

  it("only writes the columns that were given", async () => {
    const { admin, log } = fakeAdmin();
    await createSupabaseStore(admin).updateJob("job-1", { progress: 10 });
    expect(log[0].payload).toEqual({ progress: 10 });
  });

  it("sets the lesson status", async () => {
    const { admin, log } = fakeAdmin();
    await createSupabaseStore(admin).setLessonStatus("lesson-1", "processing");
    expect(log[0]).toMatchObject({
      table: "lessons",
      payload: { status: "processing" },
      filter: ["id", "lesson-1"],
    });
  });

  it("saves the draft graph, title and needs_review status together", async () => {
    const { admin, log } = fakeAdmin();
    const graph = makeGraph();
    await createSupabaseStore(admin).saveDraft("lesson-1", { title: graph.title, graph });
    expect(log[0]).toMatchObject({
      table: "lessons",
      payload: { title: graph.title, graph, status: "needs_review" },
    });
  });

  it("raises readable errors when writes fail", async () => {
    const { admin } = fakeAdmin({ fail: true });
    const store = createSupabaseStore(admin);
    await expect(store.updateJob("j", { progress: 1 })).rejects.toThrow(
      /Could not update the ingestion job: boom/,
    );
    await expect(store.setLessonStatus("l", "failed")).rejects.toThrow(
      /Could not update the lesson status: boom/,
    );
    await expect(store.saveDraft("l", { title: "t", graph: makeGraph() })).rejects.toThrow(
      /Could not save the draft lesson: boom/,
    );
  });
});
