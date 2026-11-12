/** Lightweight per-stage timing logger for measuring pipeline performance. */
export class StageTimer {
  private readonly jobId: string;
  private readonly marks: Array<{ stage: string; ms: number }> = [];

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const ms = performance.now() - start;
      this.marks.push({ stage, ms });
      console.log(`[timing] job=${this.jobId} stage=${stage} ms=${ms.toFixed(0)}`);
    }
  }

  summary(): string {
    return this.marks.map((m) => `${m.stage}=${m.ms.toFixed(0)}ms`).join(" ");
  }
}
