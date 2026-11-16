import ClipStudio from "@/components/ClipStudio";

/**
 * The old workbench (model Compare, API keys, the old New Clip flow). Not
 * linked from the app: it's for benchmarks, open it at /lab directly.
 */
export default function Lab() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_20%_-10%,#1f1b3a_0%,#0a0a0f_45%,#060608_100%)] text-zinc-100">
      <ClipStudio />
    </div>
  );
}
