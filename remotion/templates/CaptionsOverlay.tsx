import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate } from "remotion";
import type { TikTokPage } from "@remotion/captions";

/** Renders word-by-word animated captions, highlighting the currently-spoken word. */
export const CaptionsOverlay: React.FC<{ pages: TikTokPage[] }> = ({ pages }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;

  const activePage = pages.find(
    (page) => timeMs >= page.startMs && timeMs < page.startMs + page.durationMs
  );
  if (!activePage) return null;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 220,
        paddingLeft: 48,
        paddingRight: 48,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0 14px",
          fontFamily: "Arial, sans-serif",
          fontSize: 64,
          fontWeight: 800,
          textAlign: "center",
          lineHeight: 1.25,
        }}
      >
        {activePage.tokens.map((token, i) => {
          const isActive = timeMs >= token.fromMs && timeMs < token.toMs;
          const isPast = timeMs >= token.toMs;
          const msSincePop = timeMs - token.fromMs;
          const scale = isActive
            ? interpolate(msSincePop, [0, 90], [1.18, 1.08], { extrapolateRight: "clamp", extrapolateLeft: "clamp" })
            : 1;
          return (
            <span
              key={i}
              style={{
                color: isActive ? "#FFE34D" : "#FFFFFF",
                WebkitTextStroke: "3px black",
                paintOrder: "stroke fill",
                transform: `scale(${scale})`,
                display: "inline-block",
                opacity: isPast && !isActive ? 0.85 : 1,
              }}
            >
              {token.text.trim()}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
