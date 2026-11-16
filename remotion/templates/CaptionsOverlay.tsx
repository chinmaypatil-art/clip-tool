import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate } from "remotion";
import type { TikTokPage } from "@remotion/captions";
import { CAPTION_FONTS, CAPTION_SIZES, DEFAULT_CAPTION_STYLE, parseCaptionStyle } from "../../src/lib/captionStyle";

/** Renders word-by-word animated captions, highlighting the currently-spoken word. */
export const CaptionsOverlay: React.FC<{ pages: TikTokPage[]; captionStyle?: unknown }> = ({ pages, captionStyle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;
  const style = captionStyle ? parseCaptionStyle(captionStyle) : DEFAULT_CAPTION_STYLE;
  const font = CAPTION_FONTS[style.font];
  const size = CAPTION_SIZES[style.size];

  const activePage = pages.find(
    (page) => timeMs >= page.startMs && timeMs < page.startMs + page.durationMs
  );
  if (!activePage) return null;

  const justify = style.position === "top" ? "flex-start" : style.position === "middle" ? "center" : "flex-end";

  return (
    <AbsoluteFill
      style={{
        justifyContent: justify,
        alignItems: "center",
        paddingTop: style.position === "top" ? 260 : 0,
        paddingBottom: style.position === "bottom" ? 220 : 0,
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
          fontFamily: `"${font.family}", sans-serif`,
          fontSize: size,
          fontWeight: font.weight,
          textAlign: "center",
          lineHeight: 1.25,
          ...(style.background === "box" ? { background: "rgba(0,0,0,0.75)", borderRadius: 16, padding: "8px 20px" } : {}),
        }}
      >
        {activePage.tokens.map((token, i) => {
          const isActive = style.highlight !== null && timeMs >= token.fromMs && timeMs < token.toMs;
          const isPast = timeMs >= token.toMs;
          const msSincePop = timeMs - token.fromMs;
          const scale = isActive
            ? interpolate(msSincePop, [0, 90], [1.18, 1.08], { extrapolateRight: "clamp", extrapolateLeft: "clamp" })
            : 1;
          const text = token.text.trim();
          return (
            <span
              key={i}
              style={{
                color: isActive ? style.highlight! : style.color,
                WebkitTextStroke: style.background === "outline" ? `${Math.max(3, Math.round(size * 0.05))}px black` : undefined,
                textShadow: style.background === "shadow" ? "0 4px 8px rgba(0,0,0,0.85)" : undefined,
                paintOrder: "stroke fill",
                transform: `scale(${scale})`,
                display: "inline-block",
                opacity: isPast && !isActive ? 0.85 : 1,
              }}
            >
              {style.uppercase ? text.toUpperCase() : text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
