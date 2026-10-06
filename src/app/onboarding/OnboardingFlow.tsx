"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "@/components/Button";
import { NeedsBox } from "@/components/NeedsBox";
import { PresetGallery } from "@/components/PresetGallery";
import { ProfilePreview } from "@/components/ProfilePreview";
import { announce } from "@/lib/a11y/live-region";
import { PRESET_DESCRIPTIONS, type PRESET_NAMES } from "@/lib/profile/presets";

type PresetName = (typeof PRESET_NAMES)[number];
import {
  getProfileStore,
  useProfile,
  useProfileHydration,
  type ProfileStore,
} from "@/lib/profile/store";
import type { SttProvider } from "@/lib/speech/stt";

interface OnboardingFlowProps {
  /** Where to go when the learner is done. Already validated as an on-site path. */
  next: string;
  profileStore?: StoreApi<ProfileStore>;
  /** Overrides, used by tests. */
  navigate?: (to: string) => void;
  speech?: SttProvider | null;
}

/**
 * First-run setup (PRD CE-3): choose a starting point, see a live preview, or describe
 * what helps in your own words, then continue. It never asks about a diagnosis or a
 * disability. Everything works by keyboard, by screen reader, and by voice.
 */
export function OnboardingFlow({
  next,
  profileStore = getProfileStore(),
  navigate,
  speech,
}: OnboardingFlowProps) {
  useProfileHydration(profileStore);
  const router = useRouter();
  const profile = useProfile((state) => state.profile, profileStore);
  const [finishing, setFinishing] = useState(false);

  const choose = (preset: PresetName) => {
    profileStore.getState().applyPreset(preset);
    announce(`${PRESET_DESCRIPTIONS[preset].label} selected. The preview has updated.`);
  };

  const finish = async () => {
    setFinishing(true);
    // Save now rather than waiting for the background save, so the next page has it.
    await profileStore.getState().flush();
    (navigate ?? router.push)(next);
  };

  return (
    <div className="flex flex-col gap-8">
      <PresetGallery profile={profile} onSelect={choose} />
      <ProfilePreview profile={profile} />
      <NeedsBox profileStore={profileStore} speech={speech} />
      <div>
        <Button onClick={() => void finish()} disabled={finishing}>
          {finishing ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
