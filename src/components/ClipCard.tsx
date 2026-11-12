"use client";

import { motion } from "framer-motion";
import { Download } from "lucide-react";
import type { JobClip } from "@/lib/jobs";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ClipCard({
  jobId,
  clip,
  index,
}: {
  jobId: string;
  clip: JobClip;
  index: number;
}) {
  const videoUrl = `/api/jobs/${jobId}/clips/${clip.filename}`;
  const thumbUrl = clip.thumbnailFilename ? `/api/jobs/${jobId}/clips/${clip.thumbnailFilename}` : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
      className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-colors hover:border-violet-500/40"
    >
      <div className="relative aspect-[9/16] bg-black">
        <video src={videoUrl} poster={thumbUrl} controls preload="none" className="h-full w-full object-contain" />
        <div className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold text-violet-300 backdrop-blur">
          {Math.round(clip.score)}
        </div>
      </div>
      <div className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-zinc-100">{clip.title}</h3>
        <p className="mb-3 text-xs leading-relaxed text-zinc-400">{clip.reason}</p>
        <div className="mb-3 text-[11px] text-zinc-500">
          {formatTime(clip.startSeconds)} – {formatTime(clip.endSeconds)}
        </div>
        <a
          href={videoUrl}
          download={clip.filename}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-white/5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-violet-600 hover:text-white"
        >
          <Download size={13} /> Download
        </a>
      </div>
    </motion.div>
  );
}
