"use client";

import { createContext } from "react";
import { requestVariant, VariantRequestError } from "@/lib/lessons/variants-client";

/**
 * Where a reading-level variant comes from. By default a renderer asks the server. The
 * demo supplies its own, which answers from wordings written into the page, so it works
 * without an account, a model or a network connection.
 */
export type VariantSource = typeof requestVariant;

export const VariantSourceContext = createContext<VariantSource>(requestVariant);

/** A source that answers from a fixed table, keyed by concept and then by level. */
export function createFixedVariantSource(
  table: Record<string, { plain: string; simple: string }>,
  graphVersion: number,
): VariantSource {
  return async ({ conceptId, readingLevel }) => {
    const body = table[conceptId]?.[readingLevel];
    if (!body) throw new VariantRequestError("There is no simpler version of this idea yet.");
    return { summary: "", body, graphVersion, cached: true };
  };
}
