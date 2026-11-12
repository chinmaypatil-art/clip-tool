const base = "http://localhost:3000";

const res = await fetch(`${base}/api/jobs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "not-a-real-url" }),
});
console.log("Invalid URL test:", res.status, await res.json());

const form = new FormData();
const fileBuffer = await import("fs").then((fs) => fs.readFileSync("scripts/fixtures/test-video-long.mp4"));
form.append("file", new Blob([fileBuffer], { type: "video/mp4" }), "test-video.mp4");

const uploadRes = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
console.log("Upload submit:", uploadRes.status);
const { jobId } = await uploadRes.json();
console.log("Job ID:", jobId);

let lastStatus = "";
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const statusRes = await fetch(`${base}/api/jobs/${jobId}`);
  const job = await statusRes.json();
  if (job.progressMessage !== lastStatus) {
    console.log(`[${job.status}] ${job.progressMessage}`);
    lastStatus = job.progressMessage;
  }
  if (job.status === "done" || job.status === "error") {
    console.log("FINAL:", JSON.stringify(job, null, 2));
    break;
  }
}
