import React from "react";
import { Composition } from "remotion";
import { ClipClassic } from "./templates/ClipClassic";
import { FPS, HEIGHT, WIDTH, clipTemplateSchema, type ClipTemplateProps } from "./types";

const defaultProps: ClipTemplateProps = {
  videoFileName: "source.mp4",
  trimStartSeconds: 0,
  durationSeconds: 10,
  title: "",
  captionPages: [],
  framing: [],
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="clip-classic"
        component={ClipClassic}
        schema={clipTemplateSchema}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        durationInFrames={FPS * 10}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, Math.round(props.durationSeconds * FPS)),
        })}
      />
    </>
  );
};
