const SWEEP_EVERY_MS = 60 * 60 * 1000;

/** Runs once per server start: storage housekeeping now and every hour. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { sweepStorage } = await import("./lib/housekeeping");
  const sweep = () => sweepStorage().catch((err) => console.error("[housekeeping] sweep failed:", err));
  void sweep();
  setInterval(sweep, SWEEP_EVERY_MS).unref();
}
