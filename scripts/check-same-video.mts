import assert from "node:assert/strict";
import { sameVideo } from "../src/lib/analysisPipeline";

assert.ok(sameVideo("https://www.youtube.com/live/l-oEKLu4Y3w?si=XLLl", "https://www.youtube.com/live/l-oEKLu4Y3w?si=jQPu"));
assert.ok(sameVideo("https://youtu.be/l-oEKLu4Y3w", "https://www.youtube.com/watch?v=l-oEKLu4Y3w&t=30"));
assert.ok(!sameVideo("https://www.youtube.com/watch?v=l-oEKLu4Y3w", "https://www.youtube.com/watch?v=aaaaaaaaaaa"));
assert.ok(!sameVideo(undefined, "https://youtu.be/l-oEKLu4Y3w"));
console.log("same video ok");
process.exit(0);
