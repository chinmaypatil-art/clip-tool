import assert from "node:assert/strict";
import { romanizeInBatches } from "../src/lib/gemini";

// Numbered strings land on their own word even if one is skipped or out of order.
const out = await romanizeInBatches(["है", "नहीं", "करना"], async () => JSON.stringify({ words: ["2: karna", "0:hai", "9:extra", "bad"] }), "test");
assert.deepEqual(out, ["hai", null, "karna"]);
console.log("romanize ok");
