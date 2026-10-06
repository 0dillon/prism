import { RenderProfile } from "@/lib/schemas/render-profile";

/**
 * Applying a partial change to a Render Profile (PRD 5.4 A). Patches can come from a
 * model, so anything that is not a real setting, or whose value is out of range, is
 * rejected and the current profile is left as it was.
 */

type Group = Exclude<keyof RenderProfile, "schemaVersion" | "preset" | "layout">;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type ProfilePatch = DeepPartial<RenderProfile>;

export class ProfilePatchError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid profile change: ${problems.join("; ")}`);
    this.name = "ProfilePatchError";
  }
}

const GROUPS = [
  "content",
  "quiz",
  "typography",
  "audio",
  "visual",
  "feedback",
] as const satisfies readonly Group[];
const TOP_LEVEL = ["schemaVersion", "preset", "layout", ...GROUPS];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const knownKeys = (group: Group): string[] => Object.keys(RenderProfile.shape[group].shape);

/**
 * Returns `base` with `patch` merged in, validated as a whole. Throws ProfilePatchError
 * if the patch names an unknown setting, has the wrong shape, or produces an invalid
 * profile. Never mutates its inputs.
 */
export function deepMergeProfile(base: RenderProfile, patch: unknown): RenderProfile {
  if (!isRecord(patch)) throw new ProfilePatchError(["the change must be an object"]);

  const problems: string[] = [];
  const merged: Record<string, unknown> = { ...base };

  for (const key of Object.keys(patch)) {
    if (!TOP_LEVEL.includes(key)) problems.push(`"${key}" is not a setting`);
  }

  for (const key of ["schemaVersion", "preset", "layout"] as const) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }

  for (const group of GROUPS) {
    const value = patch[group];
    if (value === undefined) continue;
    if (!isRecord(value)) {
      problems.push(`"${group}" must be an object`);
      continue;
    }
    const allowed = knownKeys(group);
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) problems.push(`"${group}.${key}" is not a setting`);
    }
    // Undefined values mean "no change", which keeps partial patches from clearing settings.
    const defined = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
    merged[group] = { ...base[group], ...defined };
  }

  if (problems.length > 0) throw new ProfilePatchError(problems);

  const result = RenderProfile.safeParse(merged);
  if (!result.success) {
    throw new ProfilePatchError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return result.data;
}

export interface ProfileChange {
  path: string;
  from: unknown;
  to: unknown;
}

/** The settings that differ between two profiles, for describing what a change did. */
export function diffProfiles(before: RenderProfile, after: RenderProfile): ProfileChange[] {
  const changes: ProfileChange[] = [];
  for (const key of ["preset", "layout"] as const) {
    if (before[key] !== after[key]) changes.push({ path: key, from: before[key], to: after[key] });
  }
  for (const group of GROUPS) {
    const was = before[group] as Record<string, unknown>;
    const now = after[group] as Record<string, unknown>;
    for (const key of Object.keys(now)) {
      if (was[key] !== now[key])
        changes.push({ path: `${group}.${key}`, from: was[key], to: now[key] });
    }
  }
  return changes;
}

/** Whether a patch asks to switch presets or layout, as opposed to adjusting settings. */
export function patchSelectsPreset(patch: ProfilePatch): boolean {
  return patch.preset !== undefined;
}
