import type { SignGloss, SignLink } from "@/lib/ai/ingestion/signs";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import {
  parseArtifacts,
  type JobArtifacts,
  type JobState,
  type JobUpdate,
  type PipelineStore,
} from "@/lib/ai/ingestion/store";

/** An in-memory PipelineStore for tests. Records every write so tests can inspect them. */
export class MemoryStore implements PipelineStore {
  files = new Map<string, Uint8Array>();
  job: JobState = {
    stage: "uploading",
    progress: 0,
    artifacts: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };
  error: string | null = null;
  lessonStatus = "uploading";
  draft: { title: string; graph: KnowledgeGraph } | null = null;
  updates: JobUpdate[] = [];
  statusHistory: string[] = [];
  downloads: string[] = [];
  failWrites = false;
  glosses: SignGloss[] = [];
  glossError: Error | null = null;
  signLinks: SignLink[] = [];

  async downloadSource(path: string) {
    this.downloads.push(path);
    const file = this.files.get(path);
    if (!file) throw new Error(`no such file: ${path}`);
    return file;
  }

  async loadJob(): Promise<JobState> {
    return {
      ...this.job,
      artifacts: parseArtifacts(JSON.parse(JSON.stringify(this.job.artifacts))),
    };
  }

  async updateJob(_jobId: string, update: JobUpdate) {
    if (this.failWrites) throw new Error("database unavailable");
    this.updates.push(update);
    if (update.stage !== undefined) this.job.stage = update.stage;
    if (update.progress !== undefined) this.job.progress = update.progress;
    if (update.error !== undefined) this.error = update.error;
    if (update.artifacts !== undefined) {
      // Round trip through JSON like a jsonb column does.
      this.job.artifacts = JSON.parse(JSON.stringify(update.artifacts)) as JobArtifacts;
    }
    if (update.tokensIn !== undefined) this.job.tokensIn = update.tokensIn;
    if (update.tokensOut !== undefined) this.job.tokensOut = update.tokensOut;
    if (update.costUsd !== undefined) this.job.costUsd = update.costUsd;
  }

  async setLessonStatus(_lessonId: string, status: "processing" | "needs_review" | "failed") {
    this.lessonStatus = status;
    this.statusHistory.push(status);
  }

  async saveDraft(_lessonId: string, draft: { title: string; graph: KnowledgeGraph }) {
    this.draft = JSON.parse(JSON.stringify(draft)) as { title: string; graph: KnowledgeGraph };
    this.lessonStatus = "needs_review";
    this.statusHistory.push("needs_review");
  }

  async listSignGlosses() {
    if (this.glossError) throw this.glossError;
    return this.glosses;
  }

  async saveSignLinks(_lessonId: string, links: SignLink[]) {
    this.signLinks.push(...links);
  }
}
