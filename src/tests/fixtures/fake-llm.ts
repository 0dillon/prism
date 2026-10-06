import type { generateStructured } from "@/lib/ai/llm";
import type { UsageCallback } from "@/lib/ai/usage";

type Generate = typeof generateStructured;
type Call = { name: string; tier: string; prompt: string };

export interface FakeLlmOptions {
  /** Throw this error the first time the named task is called. */
  failOnce?: Record<string, Error>;
  /** Throw this error every time the named task is called. */
  failAlways?: Record<string, Error>;
  /** Leave the named task's output empty. */
  emptyFor?: string[];
}

/**
 * A scripted stand-in for the LLM that understands the three pipeline prompts and answers
 * deterministically from what is in them. It reports token usage like a real call.
 */
export function createFakeLlm(options: FakeLlmOptions = {}) {
  const calls: Call[] = [];
  const failedOnce = new Set<string>();

  const countOf = (name: string) => calls.filter((c) => c.name === name).length;

  const answer = (name: string, prompt: string): unknown => {
    if (options.emptyFor?.includes(name)) {
      return name === "generate-quiz" ? { items: [] } : { concepts: [] };
    }

    if (name === "extract-concepts") {
      const source = /<source>\n([\s\S]*)\n<\/source>/.exec(prompt)?.[1] ?? "";
      const sections = source.split(/^#{1,6} /m).filter((part) => part.trim());
      const concepts = sections.flatMap((section) => {
        const [heading, ...rest] = section.split("\n");
        const body = rest.join("\n").trim();
        const excerpt = body.split(/(?<=[.!?])\s+/)[0]?.trim();
        if (!excerpt) return [];
        return [
          {
            title: heading.trim(),
            summary: `${heading.trim()} explained.`,
            body,
            keyTerm: heading.trim().toLowerCase(),
            definition: excerpt,
            examples: [],
            excerpt,
            confidence: "high" as const,
          },
        ];
      });
      return { concepts };
    }

    if (name === "merge-concepts") {
      const refs = [...prompt.matchAll(/^(r\d+) \| /gm)].map((m) => m[1]);
      return {
        title: "The Water Cycle",
        overview: "How water moves between sea, sky and land.",
        sections: [{ title: "How water moves", concepts: refs }],
        duplicates: [],
        prerequisites: refs.slice(1).map((ref, i) => ({ concept: ref, requires: [refs[i]] })),
      };
    }

    if (name === "generate-quiz") {
      const found = [...prompt.matchAll(/<concept ref="(c\d+)">\nTitle: ([^\n]+)/g)];
      return {
        items: found.flatMap(([, ref, title]) => [
          {
            concept: ref,
            type: "mcq" as const,
            prompt: `Which idea is this lesson part about: ${title}?`,
            options: [title, "Something unrelated", "A different topic"],
            answer: title,
            acceptable: [],
            explanation: `This part is about ${title}.`,
            difficulty: "recall" as const,
          },
          {
            concept: ref,
            type: "true_false" as const,
            prompt: `${title} is one part of the water cycle.`,
            answer: "true",
            acceptable: [],
            explanation: `${title} is covered in this lesson.`,
            difficulty: "recall" as const,
          },
        ]),
      };
    }

    throw new Error(`fake llm does not know the task "${name}"`);
  };

  const generate = (async (request: {
    name?: string;
    tier: string;
    prompt: string;
    onUsage?: UsageCallback;
  }) => {
    const name = request.name ?? "unnamed";
    calls.push({ name, tier: request.tier, prompt: request.prompt });

    const always = options.failAlways?.[name];
    if (always) throw always;
    const once = options.failOnce?.[name];
    if (once && !failedOnce.has(name)) {
      failedOnce.add(name);
      throw once;
    }

    request.onUsage?.({
      tier: request.tier as "heavy" | "fast",
      model: "fake-model",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0,
      costKnown: false,
      latencyMs: 1,
      validationFailed: false,
    });
    return answer(name, request.prompt);
  }) as unknown as Generate;

  return { generate, calls, countOf };
}
