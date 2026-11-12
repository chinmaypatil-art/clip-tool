import { randomUUID, randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import path from "path";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export class KeyStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "KeyStoreError";
  }
}

export const BUILTIN_PROVIDERS = ["gemini", "openai", "anthropic"] as const;

/** A built-in provider id, or the id of a user-added OpenAI-compatible provider. */
export type Provider = string;

/** A user-added provider that speaks the OpenAI chat-completions API (Groq, OpenRouter, …). Not secret. */
export interface CustomProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  createdAt: number;
}

export interface ApiKeyRecord {
  id: string;
  provider: Provider;
  label: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  usageCount: number;
  /** Set when this key hit a rate-limit/quota error; cleared once this time passes. */
  rateLimitedUntil: number | null;
  /** Set when this key failed with an auth/invalid-key error — not retried automatically. */
  invalid: boolean;
  lastError: string | null;
}

interface StoredKeyRecord extends ApiKeyRecord {
  /** AES-256-GCM: iv:authTag:ciphertext, all base64. Never sent to the client. */
  encrypted: string;
}

interface KeyStoreFile {
  keys: StoredKeyRecord[];
  /** Round-robin cursor per provider, so rotation continues where it left off. */
  rotationCursor: Record<string, number>;
  customProviders?: CustomProviderDef[];
}

const STORE_DIR = path.join(process.cwd(), "storage");
const STORE_PATH = path.join(STORE_DIR, "keystore.enc.json");

const SECRET_FILE_PATH = path.join(STORE_DIR, ".keystore-secret");

/**
 * The encryption secret for API keys at rest. Uses KEY_STORE_SECRET from the
 * environment if explicitly set (e.g. for a real deployment); otherwise
 * auto-generates and persists a random one on first use, so there's no
 * required terminal/env setup for normal (single-machine) usage.
 */
function getEncryptionSecret(): string {
  if (process.env.KEY_STORE_SECRET) return process.env.KEY_STORE_SECRET;

  if (existsSync(SECRET_FILE_PATH)) {
    return readFileSync(SECRET_FILE_PATH, "utf8").trim();
  }

  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(SECRET_FILE_PATH, generated, { mode: 0o600 });
  } catch (err) {
    throw new KeyStoreError("Failed to persist an auto-generated keystore encryption secret.", err);
  }
  return generated;
}

function getEncryptionKey(): Buffer {
  return scryptSync(getEncryptionSecret(), "clip-studio-keystore", 32);
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decrypt(payload: string): string {
  const key = getEncryptionKey();
  const [ivB64, authTagB64, ciphertextB64] = payload.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new KeyStoreError("Stored key payload is malformed.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

// Cached, but re-read whenever the file changes on disk: in `next dev` each
// route is bundled separately with its own copy of this module, so a key or
// provider added through one route was invisible to the others until restart.
let cache: KeyStoreFile | null = null;
let cacheMtimeMs = -1;

async function load(): Promise<KeyStoreFile> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(STORE_PATH)).mtimeMs;
  } catch {
    // No file yet.
  }
  if (cache && mtimeMs === cacheMtimeMs) return cache;
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    cache = JSON.parse(raw) as KeyStoreFile;
  } catch {
    cache = { keys: [], rotationCursor: {} };
  }
  cacheMtimeMs = mtimeMs;
  return cache;
}

async function save(store: KeyStoreFile): Promise<void> {
  cache = store;
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2));
  cacheMtimeMs = (await stat(STORE_PATH)).mtimeMs;
}

function toPublic(record: StoredKeyRecord): ApiKeyRecord {
  const { encrypted: _encrypted, ...rest } = record;
  return rest;
}

/** Masked for display only — never the real key. */
export function maskKeyPreview(label: string): string {
  return label;
}

export async function listKeys(provider?: Provider): Promise<ApiKeyRecord[]> {
  const store = await load();
  return store.keys.filter((k) => !provider || k.provider === provider).map(toPublic);
}

export async function addKey(provider: Provider, label: string, rawKey: string): Promise<ApiKeyRecord> {
  if (!rawKey.trim()) throw new KeyStoreError("API key cannot be empty.");
  const store = await load();
  const record: StoredKeyRecord = {
    id: randomUUID(),
    provider,
    label: label.trim() || `${provider} key`,
    enabled: true,
    createdAt: Date.now(),
    lastUsedAt: null,
    usageCount: 0,
    rateLimitedUntil: null,
    invalid: false,
    lastError: null,
    encrypted: encrypt(rawKey.trim()),
  };
  store.keys.push(record);
  await save(store);
  return toPublic(record);
}

export async function updateKey(
  id: string,
  patch: Partial<Pick<ApiKeyRecord, "label" | "enabled">>
): Promise<ApiKeyRecord> {
  const store = await load();
  const record = store.keys.find((k) => k.id === id);
  if (!record) throw new KeyStoreError(`No API key with id "${id}".`);
  Object.assign(record, patch);
  await save(store);
  return toPublic(record);
}

/** Local servers (Ollama, LM Studio, …) don't need an API key. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
}

export async function listCustomProviders(): Promise<CustomProviderDef[]> {
  const store = await load();
  return store.customProviders ?? [];
}

export async function addCustomProvider(label: string, baseUrl: string, models: string[]): Promise<CustomProviderDef> {
  const store = await load();
  const existing = store.customProviders ?? [];
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
  let id = slug;
  for (let n = 2; (BUILTIN_PROVIDERS as readonly string[]).includes(id) || existing.some((p) => p.id === id); n++) {
    id = `${slug}-${n}`;
  }
  const def: CustomProviderDef = {
    id,
    label: label.trim(),
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    models,
    createdAt: Date.now(),
  };
  store.customProviders = [...existing, def];
  await save(store);
  return def;
}

export async function setCustomProviderModels(id: string, models: string[]): Promise<CustomProviderDef> {
  const store = await load();
  const def = (store.customProviders ?? []).find((p) => p.id === id);
  if (!def) throw new KeyStoreError(`No custom provider with id "${id}".`);
  def.models = models;
  await save(store);
  return def;
}

/** Removes a custom provider along with every key stored for it. */
export async function deleteCustomProvider(id: string): Promise<void> {
  const store = await load();
  store.customProviders = (store.customProviders ?? []).filter((p) => p.id !== id);
  store.keys = store.keys.filter((k) => k.provider !== id);
  await save(store);
}

export async function deleteKey(id: string): Promise<void> {
  const store = await load();
  store.keys = store.keys.filter((k) => k.id !== id);
  await save(store);
}

const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

/** Marks a key as temporarily unavailable after a 429/quota error. */
export async function markRateLimited(id: string, message: string): Promise<void> {
  const store = await load();
  const record = store.keys.find((k) => k.id === id);
  if (!record) return;
  record.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  record.lastError = message;
  await save(store);
}

/** Marks a key as permanently invalid (bad auth) — excluded from rotation until re-enabled. */
export async function markInvalid(id: string, message: string): Promise<void> {
  const store = await load();
  const record = store.keys.find((k) => k.id === id);
  if (!record) return;
  record.invalid = true;
  record.lastError = message;
  await save(store);
}

export async function recordUsage(id: string): Promise<void> {
  const store = await load();
  const record = store.keys.find((k) => k.id === id);
  if (!record) return;
  record.usageCount += 1;
  record.lastUsedAt = Date.now();
  await save(store);
}

export interface ResolvedKey {
  id: string;
  label: string;
  value: string;
}

/**
 * Returns eligible keys for a provider in round-robin order, starting from
 * this provider's rotation cursor. "Eligible" = enabled, not marked invalid,
 * and not currently inside its rate-limit cooldown. The caller tries them in
 * order and should call `advanceRotation` once it picks one, so the next
 * call starts from a different key (actual round-robin, not always-first).
 */
export async function getEligibleKeys(provider: Provider): Promise<ResolvedKey[]> {
  const store = await load();
  const now = Date.now();
  const candidates = store.keys.filter(
    (k) => k.provider === provider && k.enabled && !k.invalid && (!k.rateLimitedUntil || k.rateLimitedUntil < now)
  );
  const cursor = store.rotationCursor[provider] ?? 0;
  const rotated = [...candidates.slice(cursor % Math.max(candidates.length, 1)), ...candidates.slice(0, cursor % Math.max(candidates.length, 1))];
  return rotated.map((k) => ({ id: k.id, label: k.label, value: decrypt(k.encrypted) }));
}

export async function advanceRotation(provider: Provider): Promise<void> {
  const store = await load();
  store.rotationCursor[provider] = (store.rotationCursor[provider] ?? 0) + 1;
  await save(store);
}
