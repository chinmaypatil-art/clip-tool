import assert from "node:assert/strict";
import { createLimiter } from "../src/lib/limit";

const slot = createLimiter(1);
const seen: Record<string, number[]> = { a: [], b: [], c: [] };
let release!: () => void;
const a = slot(() => new Promise<void>((r) => (release = r)), (n) => seen.a.push(n));
const b = slot(async () => {}, (n) => seen.b.push(n));
const c = slot(async () => {}, (n) => seen.c.push(n));
release();
await Promise.all([a, b, c]);
assert.deepEqual(seen, { a: [0], b: [1, 0], c: [2, 1, 0] });
console.log("limit ok");
