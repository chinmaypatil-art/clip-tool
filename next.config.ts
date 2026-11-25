import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

const nextConfig: NextConfig = {
  // Builds go to .next-new and replace .next only when the server restarts
  // (scripts/swap-build.mjs): a build over the live .next broke open pages.
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "@remotion/install-whisper-cpp",
    "@google/genai",
    "esbuild",
  ],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default (phase: string): NextConfig => ({ ...nextConfig, distDir: phase === PHASE_PRODUCTION_BUILD ? ".next-new" : ".next" });
