import { normalizeAnswer } from "@/lib/quiz/grade";
import type { QuizItem } from "@/lib/schemas/knowledge-graph";

/**
 * Quiz questions by voice (PRD 5.6.3, P4-18). A question is read with lettered options, and
 * the learner can answer with the letter or with the option's own words. Speech recognition
 * hears letters as other words ("bee", "see"), so those are understood too.
 */

const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export const letterFor = (index: number) => LETTERS[index] ?? String(index + 1);

/** How a letter is likely to be written by speech recognition. */
const LETTER_WORDS: Record<string, readonly string[]> = {
  a: ["a", "ay", "eh", "hey"],
  b: ["b", "be", "bee", "bea"],
  c: ["c", "see", "sea", "cee", "si"],
  d: ["d", "dee", "de"],
  e: ["e", "ee"],
  f: ["f", "eff", "ef"],
};

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  one: 0,
  "1": 0,
  second: 1,
  "2nd": 1,
  two: 1,
  "2": 1,
  third: 2,
  "3rd": 2,
  three: 2,
  "3": 2,
  fourth: 3,
  "4th": 3,
  four: 3,
  "4": 3,
};

/** What the tutor says to ask the question. */
export function spokenQuestion(item: QuizItem): string {
  if (item.type === "true_false") return `True or false. ${item.prompt}`;
  if (item.type === "short_answer") return `${item.prompt} Say or type your answer.`;
  const options = (item.options ?? []).map((option, i) => `${letterFor(i)}. ${option}.`).join(" ");
  return `${item.prompt} ${options} Say the letter or the answer.`;
}

/** The options alone, for "repeat the options". */
export function spokenOptions(item: QuizItem): string {
  if (item.type === "true_false") return "True, or false.";
  if (item.type !== "mcq") return "";
  return (item.options ?? []).map((option, i) => `${letterFor(i)}. ${option}.`).join(" ");
}

export type SpokenAnswer =
  /** One of the options. The value is the option's own text, or "true" or "false". */
  | { kind: "choice"; value: string }
  /** The words of a short answer. */
  | { kind: "text"; value: string }
  /** Nothing that can be taken for an answer, or more than one thing. */
  | { kind: "unclear" };

const FILLER =
  /^(?:(?:um|uh|er|hmm|well|so|ok|okay)\s+)*(?:(?:i\s+(?:think|guess|say|choose|pick|would\s+say|will\s+say)|i'?ll\s+(?:say|go\s+with|take)|my\s+answer\s+is|the\s+answer\s+is|answer|it'?s|it\s+is|that'?s|that\s+is|go\s+with|is|is\s+it|maybe|probably|definitely)\s+)*/;

function strip(utterance: string): string {
  const cleaned = normalizeAnswer(utterance);
  return cleaned
    .replace(FILLER, "")
    .replace(/^(?:option|letter|choice|number|answer)\s+/, "")
    .trim();
}

/** The option a lone letter, its sound-alike, or an ordinal points to, or null. */
function byLabel(words: string, count: number): number | null {
  const label = words.replace(/\s+(?:please|thanks|thank\s+you)$/, "").replace(/^the\s+/, "");
  const bare = label.replace(/\s+(?:one|option|answer|choice)$/, "");
  for (const candidate of [label, bare]) {
    for (const [letter, forms] of Object.entries(LETTER_WORDS)) {
      const index = letter.charCodeAt(0) - 97;
      if (index < count && forms.includes(candidate)) return index;
    }
    const ordinal = ORDINALS[candidate];
    if (ordinal !== undefined && ordinal < count) return ordinal;
  }
  return null;
}

export function matchSpokenAnswer(item: QuizItem, utterance: string): SpokenAnswer {
  const words = strip(utterance);
  if (!words) return { kind: "unclear" };

  if (item.type === "short_answer") return { kind: "text", value: utterance.trim() };

  if (item.type === "true_false") {
    const first = words.split(" ")[0];
    const rest = words.split(" ").slice(1).join(" ");
    const truthy = ["true", "correct", "yes", "yeah", "yep", "right"];
    const falsy = ["false", "incorrect", "no", "nope", "wrong"];
    if (rest === "" || /^(?:please|thanks)$/.test(rest)) {
      if (truthy.includes(first)) return { kind: "choice", value: "true" };
      if (falsy.includes(first)) return { kind: "choice", value: "false" };
    }
    // "it is false", "that is true": already stripped to one word above; otherwise look at the last word.
    const last = words.split(" ").at(-1) ?? "";
    if (words.split(" ").length <= 3) {
      if (last === "true") return { kind: "choice", value: "true" };
      if (last === "false") return { kind: "choice", value: "false" };
    }
    return { kind: "unclear" };
  }

  const options = item.options ?? [];
  const index = byLabel(words, options.length);
  if (index !== null) return { kind: "choice", value: options[index] };

  // The option's own words: the learner says all of it, or the distinctive part of it.
  const normalised = options.map((option) => normalizeAnswer(option));
  const matches = normalised
    .map((option, i) => ({ option, i }))
    .filter(
      ({ option }) =>
        option && (words === option || words.includes(option) || option.includes(words)),
    );
  // Saying less than a word of an option ("a") is not enough to choose it by content.
  const strong = matches.filter(({ option }) => words.length >= 3 || words === option);
  if (strong.length === 1) return { kind: "choice", value: options[strong[0].i] };
  return { kind: "unclear" };
}
