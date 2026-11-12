import { NextRequest, NextResponse } from "next/server";
import { rm } from "fs/promises";
import { loadJob, jobDir, requestCancel, forgetJob } from "@/lib/jobs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await loadJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json(job);
}

/**
 * Cancels a running job (aborts its in-flight download/analysis/render), or —
 * if the job already finished — deletes it from the library outright. Either
 * way, its storage directory is removed.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await loadJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const wasActive = requestCancel(id);
  if (wasActive) {
    // Best-effort cleanup, delayed slightly so the process-tree kill (async,
    // fire-and-forget on Windows) has time to actually release its file
    // handles before we try to delete them — a failed delete here isn't
    // fatal, it just leaves disk usage behind for manual cleanup.
    setTimeout(() => {
      forgetJob(id);
      rm(jobDir(id), { recursive: true, force: true }).catch((err) => {
        console.error(`[jobs] failed to clean up storage for cancelled job ${id}:`, err);
      });
    }, 1500);
  } else {
    forgetJob(id);
    rm(jobDir(id), { recursive: true, force: true }).catch((err) => {
      console.error(`[jobs] failed to delete storage for job ${id}:`, err);
    });
  }

  return NextResponse.json({ ok: true });
}
