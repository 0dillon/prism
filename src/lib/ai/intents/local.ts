import type { SessionIntent } from "@/lib/schemas/intents";

/**
 * Matches the commands people say most, without a model call (PRD 5.4 B, under 50 ms).
 *
 * A phrase only matches when the whole utterance is that command. "Next" matches;
 * "can you go over that again but easier" does not, because it asks for two things and
 * guessing one of them would be wrong. Anything this returns null for goes to the model.
 *
 * "continue" and its relatives map to `resume`. The session treats `resume` as "next"
 * when nothing is paused, so the learner never has to know which one they are in.
 */

type Rule = { intent: SessionIntent; phrases: string[] };

const UNIT = "(one|part|section|idea|card|concept|bit|topic|step)";
const THE = "(the |a |an )?";

// Written as regex source, matched against the whole normalised utterance.
const RULES: Rule[] = [
  {
    intent: { type: "next" },
    phrases: [
      "next",
      `next ${UNIT}`,
      "go next",
      `go to ${THE}next ${UNIT}`,
      `go to ${THE}next`,
      `(show|give|read) me ${THE}next ${UNIT}`,
      "move on",
      "move on to the next",
      "go on",
      "skip",
      "skip this",
      "skip that",
      "i'm ready",
      "ready",
      "start",
      "begin",
      "start the lesson",
      "begin the lesson",
      "start lesson",
      "let's go",
      "go",
      "got it",
      "i got it",
      "i get it",
    ],
  },
  {
    intent: { type: "previous" },
    phrases: [
      "previous",
      `previous ${UNIT}`,
      "back",
      "go back",
      "go back one",
      `go back to ${THE}(last|previous) ${UNIT}`,
      `go to ${THE}(last|previous) ${UNIT}`,
      `${THE}(last|previous) ${UNIT}`,
      "take me back",
      "back up",
    ],
  },
  {
    intent: { type: "repeat" },
    phrases: [
      "repeat",
      "repeat that",
      "repeat it",
      "repeat that please",
      "say that again",
      "say it again",
      "tell me again",
      "read that again",
      "read it again",
      "read it to me again",
      "again",
      "one more time",
      "once more",
      "go over that again",
      "go over it again",
      "what was that",
      "what did you say",
      "come again",
      "pardon",
      "pardon me",
      "sorry what",
      "sorry",
      "i missed that",
      "i didn't catch that",
      "i didn't hear that",
    ],
  },
  {
    intent: { type: "simplify" },
    phrases: [
      "simplify",
      "simplify that",
      "simplify it",
      "simpler",
      "easier",
      "make it simpler",
      "make that simpler",
      "make it easier",
      "make that easier",
      "make it easy",
      "say it simpler",
      "say that more simply",
      "say it more simply",
      "explain it simpler",
      "explain that simpler",
      "explain it more simply",
      "explain that more simply",
      "explain it simply",
      "use simpler words",
      "in simpler words",
      "in simple words",
      "in plain words",
      "put it simply",
      "i don't understand",
      "i don't get it",
      "i didn't understand",
      "i didn't understand that",
      "i'm confused",
      "i am confused",
      "that's confusing",
      "that is confusing",
      "this is confusing",
      "that's too hard",
      "that's too difficult",
      "too hard",
      "too difficult",
      "this is too hard",
      "this is too difficult",
      "explain it like i'm five",
    ],
  },
  {
    intent: { type: "elaborate" },
    phrases: [
      "tell me more",
      "tell me more about that",
      "more detail",
      "more details",
      "give me more detail",
      "give me more details",
      "more information",
      "more info",
      "go deeper",
      "go into more detail",
      "explain more",
      "explain that more",
      "explain it more",
      "elaborate",
      "elaborate on that",
      "say more",
      "expand on that",
    ],
  },
  {
    intent: { type: "example" },
    phrases: [
      "example",
      "an example",
      "examples",
      "give me an example",
      "give me some examples",
      "give an example",
      "show me an example",
      "show me some examples",
      "for example",
      "any examples",
      "got an example",
      "have an example",
      "can i see an example",
      "i want an example",
      "i need an example",
    ],
  },
  {
    intent: { type: "quiz_me" },
    phrases: [
      "quiz me",
      "quiz",
      "quiz time",
      "test me",
      "test my knowledge",
      "give me a quiz",
      "give me a question",
      "ask me a question",
      "ask me something",
      "ask me a quiz question",
      "question me",
      "check my understanding",
      "check what i know",
      "start the quiz",
      "start a quiz",
      "do a quiz",
      "i want a quiz",
      "be quizzed",
      "take a quiz",
    ],
  },
  {
    intent: { type: "pause" },
    phrases: [
      "pause",
      "pause that",
      "pause it",
      "pause the lesson",
      "pause reading",
      "stop",
      "stop that",
      "stop reading",
      "stop talking",
      "stop the lesson",
      "wait",
      "wait a moment",
      "wait a minute",
      "wait a second",
      "hold on",
      "hang on",
      "give me a minute",
      "give me a moment",
      "give me a second",
      "one moment",
      "one second",
      "one sec",
      "just a moment",
      "just a minute",
      "just a second",
      "just a sec",
    ],
  },
  {
    intent: { type: "resume" },
    phrases: [
      "resume",
      "resume the lesson",
      "resume reading",
      "unpause",
      "play",
      "play it",
      "continue",
      "continue reading",
      "continue the lesson",
      "carry on",
      "keep going",
      "keep reading",
      "start again",
      "i'm back",
      "i am back",
    ],
  },
  {
    intent: { type: "where_am_i" },
    phrases: [
      "where am i",
      "where am i up to",
      "where are we",
      "where are we up to",
      "where was i",
      "where were we",
      "where are we in the lesson",
      "where am i in the lesson",
      "what are we on",
      "what are we doing",
      "what are we learning",
      "what am i learning",
      "what's this about",
      "what is this about",
      "what's this lesson about",
      "what topic is this",
      "what part is this",
      "what section is this",
      "what lesson is this",
      "what's left",
      "what is left",
      "how much is left",
      "how much more is there",
      "how far am i",
      "how far along am i",
      "how far have i got",
      "how far have i gotten",
      "how far are we",
      "how far through am i",
      "how much have i done",
    ],
  },
  {
    intent: { type: "set_rate", direction: "slower" },
    phrases: [
      "slower",
      "slow down",
      "slow it down",
      "slow that down",
      "speak slower",
      "talk slower",
      "read slower",
      "go slower",
      "speak more slowly",
      "talk more slowly",
      "read more slowly",
      "more slowly",
      "too fast",
      "that's too fast",
      "you're too fast",
      "you're going too fast",
      "you're talking too fast",
      "you talk too fast",
      "you speak too fast",
    ],
  },
  {
    intent: { type: "set_rate", direction: "faster" },
    phrases: [
      "faster",
      "speed up",
      "speed it up",
      "speed that up",
      "speak faster",
      "talk faster",
      "read faster",
      "go faster",
      "speak more quickly",
      "talk more quickly",
      "read more quickly",
      "more quickly",
      "too slow",
      "that's too slow",
      "you're too slow",
      "you're going too slow",
      "you're talking too slow",
      "you talk too slow",
      "you speak too slow",
      "hurry up",
    ],
  },
];

const COMPILED = RULES.map((rule) => ({
  intent: rule.intent,
  pattern: new RegExp(`^(?:${rule.phrases.join("|")})$`),
}));

/** Lower case, plain apostrophes, no punctuation, and no politeness around the command. */
export function normalizeUtterance(raw: string): string {
  let text = raw
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const leading =
    /^(?:(?:hey|hi|ok|okay|um|uh|so|well|alright|right) )*(?:prism )?(?:please )?(?:(?:can|could|would|will) you (?:please )?|(?:i want you to|i'd like you to|i would like you to|let's|lets|let us|i want to|i'd like to|i would like to|i need to) )?(?:please )?/;
  const trailing = /(?: (?:please|thanks|thank you|for me|now|again please|prism))+$/;
  text = text.replace(leading, "");
  // Only the polite tail goes. "again" on its own is a command and stays.
  text = text.replace(trailing, "");
  return text.trim();
}

/** The command the learner said, or null when it needs the model. */
export function matchSessionIntent(utterance: string): SessionIntent | null {
  const text = normalizeUtterance(utterance);
  if (!text || text.length > 80) return null;
  for (const { intent, pattern } of COMPILED) {
    if (pattern.test(text)) return { ...intent };
  }
  return null;
}
