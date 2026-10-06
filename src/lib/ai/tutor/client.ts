import type { TutorTurnRequest } from "./turn";

/**
 * Asks the tutor for a reply and hands the text over as it arrives, so the first sentence
 * can be spoken while the rest is still being written.
 */

export class TutorRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TutorRequestError";
  }
}

const GENERIC = "I could not answer that just now. Please try again.";

export async function streamTutorTurn(
  request: TutorTurnRequest,
  options: {
    /** Called with each piece of the reply as it arrives. */
    onText?: (piece: string) => void;
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
  } = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn("/api/tutor/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new TutorRequestError("I could not connect. Check your connection and try again.");
  }

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new TutorRequestError(json?.error?.message ?? GENERIC, response.status);
  }

  if (!response.body) {
    const text = await response.text();
    if (text) options.onText?.(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      if (piece) {
        full += piece;
        options.onText?.(piece);
      }
    }
    const rest = decoder.decode();
    if (rest) {
      full += rest;
      options.onText?.(rest);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Keep what arrived: a partly spoken answer is better than none.
    if (!full) throw new TutorRequestError(GENERIC);
  }
  return full;
}
