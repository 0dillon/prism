"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/Button";
import type { LearnerSignClip } from "./signs";

export const SPEEDS = [0.5, 0.75, 1] as const;

interface SignClipProps {
  clip: LearnerSignClip;
  /** The key term, for the note under the clip. */
  term: string;
}

/**
 * A short looping video of a human signer for one key term (PRD 5.6.4, P4-26). It never
 * plays by itself: the learner presses Play, so nothing moves unasked, which also keeps
 * it safe for anyone who has asked for less motion. It is muted because it has no sound,
 * and it carries a text label of the gloss and a plain note about what it is.
 */
export function SignClip({ clip, term }: SignClipProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [failed, setFailed] = useState(false);
  const speedId = useId();
  const labelId = useId();

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(
        () => setPlaying(true),
        () => setFailed(true),
      );
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  return (
    <figure
      aria-labelledby={labelId}
      className="border-line flex flex-col gap-3 rounded-md border p-4"
    >
      <video
        ref={videoRef}
        src={clip.url}
        muted
        loop
        playsInline
        preload="metadata"
        // The signer is the content, so it needs a name for anyone who cannot see the video.
        aria-label={`A signer showing the sign for ${clip.gloss}`}
        onError={() => setFailed(true)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        className="aspect-video w-full rounded-md bg-black"
      />
      <figcaption id={labelId} className="flex flex-col gap-1">
        <span className="font-semibold">Sign: {clip.gloss}</span>
        <span className="text-muted text-sm">This shows the sign for the key term {term}.</span>
        {clip.signerCredit ? (
          <span className="text-muted text-sm">
            Signer: {clip.signerCredit}. {clip.license}.
          </span>
        ) : null}
      </figcaption>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={toggle} aria-pressed={playing} disabled={failed}>
          {playing ? "Pause" : "Play"}
        </Button>
        <label htmlFor={speedId} className="font-medium">
          Speed
        </label>
        <select
          id={speedId}
          value={speed}
          onChange={(event) => {
            const next = Number(event.target.value) as (typeof SPEEDS)[number];
            setSpeed(next);
            if (videoRef.current) videoRef.current.playbackRate = next;
          }}
          className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
        >
          {SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value === 1 ? "Normal" : `${value}×`}
            </option>
          ))}
        </select>
      </div>
      {failed ? (
        <p role="status" className="font-medium">
          The video could not be played. The key term is shown in letters below instead.
        </p>
      ) : null}
    </figure>
  );
}
