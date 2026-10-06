import type { RenderProfile } from "@/lib/schemas/render-profile";

/**
 * Saves the profile for the signed-in learner. A signed-out visitor has no account to
 * save to, so a 401 is not an error: their profile simply stays on this device.
 */
export async function saveProfileToServer(profile: RenderProfile): Promise<void> {
  const response = await fetch("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile }),
    keepalive: true,
  });
  if (response.status === 401) return;
  if (!response.ok) throw new Error(`Saving settings failed with status ${response.status}`);
}
