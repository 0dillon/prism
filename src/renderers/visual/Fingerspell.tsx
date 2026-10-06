"use client";

/**
 * A key term spelled letter by letter (PRD 5.6.4, P4-28), for terms with no clip. It is
 * always labelled "Fingerspelled", because spelling a word is not the same as signing it.
 *
 * Each letter is a tile with its own text alternative. The handshape pictures are an asset
 * set that has to be licensed and checked by a fluent signer, so none is bundled yet:
 * `handshapeUrl` is the one place to point at them. Until then a tile shows the letter,
 * and nothing pretends to be a handshape that is not there.
 */

/** Where the picture of the handshape for a letter lives, or null if there is none yet. */
export function handshapeUrl(letter: string): string | null {
  void letter;
  return null;
}

export interface FingerspellItem {
  /** A letter A to Z, or a space between words. */
  kind: "letter" | "space";
  value: string;
}

/** The letters of a term, with spaces kept as gaps. Digits and punctuation have no handshape here and are left out. */
export function fingerspellItems(term: string): FingerspellItem[] {
  const items: FingerspellItem[] = [];
  for (const char of term.normalize("NFD").replace(/\p{M}/gu, "")) {
    if (/[a-z]/i.test(char)) items.push({ kind: "letter", value: char.toUpperCase() });
    else if (/\s|-/.test(char) && items.at(-1)?.kind === "letter") {
      items.push({ kind: "space", value: " " });
    }
  }
  while (items.at(-1)?.kind === "space") items.pop();
  return items;
}

export function Fingerspell({ term }: { term: string }) {
  const items = fingerspellItems(term);
  if (items.length === 0) return null;
  const spelled = items.map((i) => (i.kind === "letter" ? i.value : "space")).join(", ");

  return (
    <section aria-label={`${term}, fingerspelled`} className="flex flex-col gap-2">
      <p className="font-semibold">Fingerspelled: {term}</p>
      <ol aria-label={`Letters: ${spelled}`} className="flex flex-wrap items-end gap-2">
        {items.map((item, index) =>
          item.kind === "space" ? (
            <li key={index} aria-hidden="true" className="w-4" />
          ) : (
            <li
              key={index}
              className="border-line flex size-14 flex-col items-center justify-center rounded-md border"
            >
              {handshapeUrl(item.value) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={handshapeUrl(item.value)!}
                  alt={`Handshape for the letter ${item.value}`}
                  className="size-10"
                />
              ) : (
                <span className="text-2xl font-bold" role="img" aria-label={`Letter ${item.value}`}>
                  {item.value}
                </span>
              )}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
