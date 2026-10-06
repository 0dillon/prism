import type { ReadingLevel } from "@/lib/ai/prompts/rewrite-concept";

/**
 * Asks the server for a reading-level variant of one concept (PRD 5.5). The server returns
 * the cached rewrite or makes it once, so asking again for the same concept and level is
 * cheap.
 */

export interface VariantResponse {
  summary: string;
  body: string;
  graphVersion: number;
  cached: boolean;
}

export class VariantRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "VariantRequestError";
  }
}

export interface VariantRequestInput {
  lessonId: string;
  conceptId: string;
  readingLevel: ReadingLevel;
}

export async function requestVariant(
  input: VariantRequestInput,
  fetchFn: typeof fetch = fetch,
): Promise<VariantResponse> {
  let response: Response;
  try {
    response = await fetchFn("/api/variants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new VariantRequestError("Could not connect. Check your connection and try again.");
  }
  const json = (await response.json().catch(() => null)) as
    VariantResponse | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = json && "error" in json ? json.error?.message : undefined;
    throw new VariantRequestError(
      message ?? "We could not make that simpler just now. Please try again.",
      response.status,
    );
  }
  if (!json || !("body" in json) || typeof json.body !== "string" || !json.body.trim()) {
    throw new VariantRequestError("We could not make that simpler just now. Please try again.");
  }
  return json;
}
