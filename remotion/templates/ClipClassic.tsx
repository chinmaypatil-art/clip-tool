import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { ClipTemplateProps, FramingSegment } from "../types";
import { WIDTH, HEIGHT } from "../types";

const HALF_HEIGHT = HEIGHT / 2;
// Size of a face in its half, as a fraction of the canvas width — close
// enough to read expressions, with room for shoulders and hands.
const SPLIT_FACE_SHARE = 0.3;

/**
 * One half of a "split" shot: the full source frame, scaled and shifted so
 * this person's face sits centred in a WIDTH x HALF_HEIGHT window.
 */
const SplitHalf: React.FC<{
  src: string;
  trimBefore: number;
  durationInFrames: number;
  person: NonNullable<FramingSegment["people"]>[number];
  aspect: number;
  top: number;
}> = ({ src, trimBefore, durationInFrames, person, aspect, top }) => {
  // Rendered source size: zoom so the face is SPLIT_FACE_SHARE of the width,
  // but never so little that the frame stops covering the half.
  const minWidth = Math.max(WIDTH, HALF_HEIGHT * aspect);
  const videoWidth = Math.min(Math.max((SPLIT_FACE_SHARE * WIDTH) / Math.max(person.w, 0.01), minWidth), WIDTH / 0.25);
  const videoHeight = videoWidth / aspect;
  const left = Math.min(0, Math.max(WIDTH - videoWidth, WIDTH / 2 - person.cx * videoWidth));
  // Faces sit a bit above centre in a good portrait crop.
  const y = Math.min(0, Math.max(HALF_HEIGHT - videoHeight, HALF_HEIGHT * 0.42 - person.cy * videoHeight));
  return (
    <div style={{ position: "absolute", left: 0, top, width: WIDTH, height: HALF_HEIGHT, overflow: "hidden" }}>
      <OffthreadVideo
        src={src}
        trimBefore={trimBefore}
        durationInFrames={durationInFrames}
        muted={top > 0}
        style={{ position: "absolute", left, top: y, width: videoWidth, height: videoHeight, maxWidth: "none" }}
      />
    </div>
  );
};
import { CaptionsOverlay } from "./CaptionsOverlay";

export const ClipClassic: React.FC<ClipTemplateProps> = ({
  videoFileName,
  trimStartSeconds,
  durationSeconds,
  captionPages,
  framing = [],
}) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const trimBefore = Math.round(trimStartSeconds * fps);
  const durationInFrames = Math.max(1, Math.round(durationSeconds * fps));

  // Per-shot framing from face analysis: "fill" crops to fill the canvas
  // around the people in shot; "fit" (and no analysis) letterboxes the whole
  // frame, so a shot where people can't all fit never crops anyone out.
  const t = frame / fps;
  const shot = framing.find((s) => t >= s.fromSeconds && t < s.toSeconds) ?? framing[framing.length - 1];
  const fill = shot?.mode === "fill";
  const split = shot?.mode === "split" && shot.people?.length === 2 && shot.sourceAspect ? shot : null;
  const src = staticFile(videoFileName);

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(160deg, #1a1333 0%, #0a0a0f 60%, #050507 100%)",
      }}
    >
      {split ? (
        <>
          {split.people!.map((person, k) => (
            <SplitHalf
              key={k}
              src={src}
              trimBefore={trimBefore}
              durationInFrames={durationInFrames}
              person={person}
              aspect={split.sourceAspect!}
              top={k * HALF_HEIGHT}
            />
          ))}
          <div style={{ position: "absolute", left: 0, top: HALF_HEIGHT - 3, width: WIDTH, height: 6, background: "#0a0a0f" }} />
        </>
      ) : (
        <OffthreadVideo
          src={src}
          trimBefore={trimBefore}
          durationInFrames={durationInFrames}
          style={{
            width: "100%",
            height: "100%",
            objectFit: fill ? "cover" : "contain",
            objectPosition: fill ? `${shot.focusX}% 50%` : "center",
          }}
        />
      )}
      <CaptionsOverlay pages={captionPages} />
    </AbsoluteFill>
  );
};
