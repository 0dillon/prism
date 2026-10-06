import { useMemo, type CSSProperties } from "react";
import type { RenderProfile } from "@/lib/schemas/render-profile";

/**
 * Turns the typography and visual settings of a Render Profile into CSS custom properties
 * and data attributes for the renderer root (PRD 5.6.2). The stylesheet reads them
 * (globals.css), so changing a setting changes a style value on the same element: nothing
 * remounts, which is what keeps a live slider smooth and the learner's place intact.
 */

export interface ProfileStyleProps {
  style: CSSProperties;
  "data-theme": RenderProfile["visual"]["theme"];
  "data-font": RenderProfile["typography"]["font"];
  "data-reduced-motion": "true" | "false";
  "data-prism-root": "";
}

type Vars = CSSProperties & Record<`--${string}`, string>;

/** The custom properties for a profile. Pure, so it can be tested without rendering. */
export function profileStyleVars(profile: RenderProfile): Vars {
  const { typography } = profile;
  return {
    "--type-scale": String(typography.sizeScale),
    "--letter-spacing": `${typography.letterSpacing}em`,
    "--word-spacing": `${typography.wordSpacing}em`,
    "--line-height": String(typography.lineHeight),
    "--measure": `${typography.maxLineLength}ch`,
  };
}

export function useProfileStyles(profile: RenderProfile): ProfileStyleProps {
  const { sizeScale, letterSpacing, wordSpacing, lineHeight, maxLineLength, font } =
    profile.typography;
  const { theme, reducedMotion } = profile.visual;

  return useMemo(
    () => ({
      style: profileStyleVars(profile),
      "data-theme": theme,
      "data-font": font,
      "data-reduced-motion": reducedMotion ? "true" : "false",
      "data-prism-root": "",
    }),
    // Depend on the individual values, so unrelated profile changes do not produce a new style object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sizeScale, letterSpacing, wordSpacing, lineHeight, maxLineLength, font, theme, reducedMotion],
  );
}
