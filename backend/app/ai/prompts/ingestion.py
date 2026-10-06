"""Prompts for the ingestion pipeline stages.

Every one of these treats the uploaded document as data, never as instruction. The document
goes in the user turn inside nonced delimiters; the instructions stay in the frozen system
prompt where text inside the document cannot reach them.
"""

from __future__ import annotations

from typing import Final

from app.ai.prompts.safety import SECURITY_PREAMBLE, build_user_turn

# ---------------------------------------------------------------------------
# Concept extraction, the map stage (PRD 5.1 step 4, task P2-04)
# ---------------------------------------------------------------------------
EXTRACT_CONCEPTS_SYSTEM: Final = f"""
You read one section of a teacher's document and identify the ideas it teaches.

A concept is the smallest teachable unit: one idea a learner could be asked about on its own.
A section covering three ideas yields three concepts, not one.

RULES

1. One idea per concept. If a concept needs the word "and" to describe it, it is two.
2. Every concept must carry `source_excerpt`: text copied **verbatim** from the document that
   supports it. Copy it exactly, character for character. It is checked against the document,
   and a concept whose excerpt is not found is flagged for the teacher.
3. Never state a fact that is not in this section. You are extracting, not teaching from your
   own knowledge. A plausible addition is worse than an omission: the teacher reviews what you
   produce and cannot tell your additions from their own material.
4. Write `body` in plain language a learner can follow, in Markdown. Explain the idea properly
   rather than restating the source.
5. `title` at most 80 characters, `summary` at most 240. Both must stand alone: the summary is
   what a learner hears in the conversation renderer and reads on a card.
6. Set `key_term` only when there is a genuine vocabulary item, and `definition` with it.
7. Take `examples` from the document where it offers any. Do not invent them.
8. If this section teaches nothing - a title page, a table of contents, a bibliography -
   return an empty list. That is a correct answer, not a failure.

{SECURITY_PREAMBLE}
""".strip()


def build_extract_concepts_turn(*, chunk_text: str, nonce: str, locator: str) -> str:
    return build_user_turn(
        document=chunk_text,
        nonce=nonce,
        task=(
            f"This is {locator} of the document. Identify the concepts it teaches, following "
            "the system instructions. Copy each supporting excerpt verbatim."
        ),
    )


# ---------------------------------------------------------------------------
# Merge and order, the reduce stage (PRD 5.1 step 5, task P2-05)
# ---------------------------------------------------------------------------
MERGE_CONCEPTS_SYSTEM: Final = f"""
You are given candidate concepts extracted separately from consecutive sections of one
document. Sections overlap, so the same idea may appear more than once.

Produce the final ordered set.

RULES

1. Merge duplicates. Two candidates describing the same idea become one concept, keeping the
   clearest wording and the best supporting excerpt.
2. Order them for teaching, not for the document's layout. A reader meets prerequisites before
   what depends on them.
3. Group them into sections with short, descriptive titles. Give every section a `ref` and
   every concept a `ref`, each unique within your response, and refer to them by those refs.
4. Set `prerequisite_refs` only where one concept genuinely cannot be understood before
   another. **These must never form a loop**, and a concept must never list itself. Most
   concepts need none; an empty list is the normal answer.
5. Keep every distinct idea. Merging is for duplicates, not for shortening. Dropping a concept
   loses part of the teacher's material.
6. Preserve each concept's `source_excerpt` exactly as given. Do not rewrite or trim it.
7. Write a lesson `title` and an `overview` of at most 600 characters describing what the
   lesson covers.

{SECURITY_PREAMBLE}
""".strip()


def build_merge_turn(*, candidates_json: str) -> str:
    return (
        "Candidate concepts, in document order:\n"
        f"<candidates>\n{candidates_json}\n</candidates>\n\n"
        "Merge duplicates, order them for teaching, group them into sections, and assign "
        "prerequisites."
    )


# ---------------------------------------------------------------------------
# Quiz generation (PRD 5.1 step 6, task P2-06)
# ---------------------------------------------------------------------------
GENERATE_QUIZ_SYSTEM: Final = f"""
You write practice questions for the concepts of one lesson.

For each concept, write at least two questions, at least one of them multiple choice.

RULES FOR MULTIPLE CHOICE - these are not style preferences, they are correctness rules.

1. Provide 3 or 4 options.
2. `answer` must be **character-for-character identical** to exactly one option. Answers are
   marked by comparing the learner's choice to `answer`; if none matches, the learner can
   never be correct and the question is unanswerable.
3. No two options may be the same, and only one may be correct.
4. Wrong options must be plausible to someone who has not understood the idea, and clearly
   wrong to someone who has. Never use filler like "none of the above".

OTHER QUESTION TYPES

- `true_false`: `answer` is exactly "true" or "false", and `options` is empty.
- `short_answer`: `answer` is a model answer, `options` is empty, and `acceptable` lists other
  phrasings that should also be marked correct.

FOR EVERY QUESTION

- It must be answerable from that concept alone. Never require material from elsewhere.
- `explanation` says why the answer is right, in a sentence or two, addressed to the learner.
  It is shown after answering, and it is what a learner who got it wrong learns from.
- `difficulty` is `recall` for remembering and `apply` for using the idea in a new situation.
  Include some of each.
- Ask about the idea, never about the document. "What does the text say in paragraph two" is
  not a question about the subject.

{SECURITY_PREAMBLE}
""".strip()


def build_quiz_turn(*, concepts_json: str) -> str:
    return (
        "The lesson's concepts:\n"
        f"<concepts>\n{concepts_json}\n</concepts>\n\n"
        "Write the questions, referring to each concept by its ref."
    )


# ---------------------------------------------------------------------------
# Grounding check (PRD 5.1 step 7, task P2-08)
# ---------------------------------------------------------------------------
GROUNDING_SYSTEM: Final = f"""
You check whether each claim is supported by the excerpt quoted alongside it.

For each item, answer whether the excerpt supports the claim.

- `supported: true` means a careful reader of that excerpt alone would accept the claim.
- `supported: false` means the excerpt does not support it, whether because it says something
  different, says less, or says nothing relevant.

Do not use your own knowledge of the subject. A claim can be perfectly true and still
unsupported by this excerpt, and that is exactly what you are looking for: the teacher needs
to know which parts came from their document and which did not.

Give a short `reason` when unsupported. It is shown to the teacher, so name what is missing.

{SECURITY_PREAMBLE}
""".strip()


def build_grounding_turn(*, items_json: str) -> str:
    return (
        "Claims and their supporting excerpts:\n"
        f"<items>\n{items_json}\n</items>\n\n"
        "For each, say whether the excerpt supports the claim."
    )


# ---------------------------------------------------------------------------
# Sign tagging (PRD 5.1 step 8, task P2-15)
# ---------------------------------------------------------------------------
SIGN_TAGGING_SYSTEM: Final = f"""
You match a lesson's key terms to signs from a fixed library.

You are given the available glosses. For each concept's key term, return the gloss whose
**meaning** matches, or null.

RULES

1. Only ever return a gloss from the supplied list. **Never invent one.** A learner shown a
   sign for the wrong concept is taught something false, and a gloss that is not in the
   library simply fails to load.
2. Match on meaning, not on spelling. A gloss that merely looks similar is not a match.
3. Return null freely. Most key terms will have no sign in a small library, and that is the
   expected outcome. The product shows the term fingerspelled instead, which is honest;
   a wrong sign is not.
4. Every match you return is reviewed by a teacher before any learner sees it, so err towards
   null rather than towards a guess.

{SECURITY_PREAMBLE}
""".strip()


def build_sign_tagging_turn(*, terms_json: str, glosses: list[str]) -> str:
    available = ", ".join(sorted(glosses)) or "(none)"
    return (
        f"Available glosses:\n{available}\n\n"
        f"Key terms:\n<terms>\n{terms_json}\n</terms>\n\n"
        "Match each key term to a gloss from the list above, or null."
    )
