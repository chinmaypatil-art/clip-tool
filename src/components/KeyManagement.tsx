"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, KeyRound, AlertTriangle, CheckCircle2, Boxes } from "lucide-react";

interface ApiKeyRecord {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  rateLimitedUntil: number | null;
  invalid: boolean;
  lastError: string | null;
}

interface ProviderInfo {
  id: string;
  label: string;
  models: { id: string; label: string }[];
  custom: boolean;
  baseUrl?: string;
}

// One-click fill-ins for popular OpenAI-compatible APIs. No model ids: they
// get retired often, so after adding the key use "Load models" to fetch the
// ones this account can actually use.
const PROVIDER_PRESETS: Array<{ label: string; baseUrl: string }> = [
  { label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "Together", baseUrl: "https://api.together.xyz/v1" },
  { label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { label: "xAI", baseUrl: "https://api.x.ai/v1" },
  { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1" },
];

export default function KeyManagement() {
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<string>("gemini");
  const [cpLabel, setCpLabel] = useState("");
  const [cpBaseUrl, setCpBaseUrl] = useState("");
  const [cpModels, setCpModels] = useState("");
  const [cpSaving, setCpSaving] = useState(false);
  const [cpError, setCpError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [keysRes, providersRes] = await Promise.all([fetch("/api/keys"), fetch("/api/providers")]);
    setKeys((await keysRes.json()).keys ?? []);
    setProviders((await providersRes.json()).providers ?? []);
  };

  useEffect(() => {
    let active = true;
    (async () => {
      const [keysRes, providersRes] = await Promise.all([fetch("/api/keys"), fetch("/api/providers")]);
      const keysData = await keysRes.json();
      const providersData = await providersRes.json();
      if (!active) return;
      setKeys(keysData.keys ?? []);
      setProviders(providersData.providers ?? []);
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleAdd = async () => {
    setError(null);
    if (!value.trim()) {
      setError("Paste an API key value.");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, label, key: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        throw new Error(body.error ?? "Request failed.");
      }
      setLabel("");
      setValue("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await load();
  };

  const handleAddProvider = async () => {
    setCpError(null);
    setCpSaving(true);
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: cpLabel, baseUrl: cpBaseUrl, models: cpModels }),
      });
      const body = await res.json().catch(() => ({ error: "Request failed." }));
      if (!res.ok) throw new Error(body.error ?? "Request failed.");
      setCpLabel("");
      setCpBaseUrl("");
      setCpModels("");
      await load();
      setProvider(body.provider.id);
    } catch (err) {
      setCpError(err instanceof Error ? err.message : String(err));
    } finally {
      setCpSaving(false);
    }
  };

  const handleLoadModels = async (id: string) => {
    setCpError(null);
    setLoadingModels(id);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(id)}/models`, { method: "POST" });
      const body = await res.json().catch(() => ({ error: "Request failed." }));
      if (!res.ok) throw new Error(body.error ?? "Request failed.");
      await load();
    } catch (err) {
      setCpError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(null);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    await fetch(`/api/providers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (provider === id) setProvider("gemini");
    await load();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Boxes size={16} className="text-violet-400" /> Custom providers
        </h2>
        <p className="mb-4 text-xs text-zinc-500">
          Add any model service with an OpenAI-compatible API, then add its key below. Pick a preset or
          fill in your own base URL and comma-separated model ids.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          {PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => {
                setCpLabel(preset.label);
                setCpBaseUrl(preset.baseUrl);
                setCpModels("");
              }}
              className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-violet-500/40 hover:text-violet-300"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr_1fr_auto]">
          <input
            value={cpLabel}
            onChange={(e) => setCpLabel(e.target.value)}
            placeholder="Name (e.g. Groq)"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500"
          />
          <input
            value={cpBaseUrl}
            onChange={(e) => setCpBaseUrl(e.target.value)}
            placeholder="Base URL (https://…/v1)"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500"
          />
          <input
            value={cpModels}
            onChange={(e) => setCpModels(e.target.value)}
            placeholder="Model ids (optional — or Load models later)"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500"
          />
          <button
            onClick={handleAddProvider}
            disabled={cpSaving}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            {cpSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
          </button>
        </div>
        {cpError && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle size={13} /> {cpError}
          </div>
        )}
        {providers.some((p) => p.custom) && (
          <div className="mt-4 space-y-2">
            {providers
              .filter((p) => p.custom)
              .map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-200">{p.label}</div>
                    <div className="truncate text-[11px] text-zinc-500">
                      {p.baseUrl} · {p.models.length ? p.models.map((m) => m.id).join(", ") : "no models yet"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleLoadModels(p.id)}
                    disabled={loadingModels === p.id}
                    title="Fetch the models your key can use"
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:border-violet-500/40 hover:text-violet-300 disabled:opacity-50"
                  >
                    {loadingModels === p.id ? <Loader2 size={12} className="animate-spin" /> : null} Load models
                  </button>
                  <button
                    onClick={() => handleDeleteProvider(p.id)}
                    title="Remove provider and its keys"
                    className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <KeyRound size={16} className="text-violet-400" /> Add an API key
        </h2>
        <p className="mb-4 text-xs text-zinc-500">
          Keys are encrypted at rest and never sent back to the browser. Add multiple keys per
          provider for automatic round-robin rotation and rate-limit failover.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr_1fr_auto]">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100"
          >
            {providers.length === 0 && <option value="gemini">Gemini</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Key 1)"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500"
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            type="password"
            placeholder="API key value"
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500"
          />
          <button
            onClick={handleAdd}
            disabled={adding}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
          </button>
        </div>
        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle size={13} /> {error}
          </div>
        )}
      </div>

      {keys === null ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 size={14} className="animate-spin" /> Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-12 text-center text-sm text-zinc-500">
          No API keys configured yet.
        </div>
      ) : (
        <div className="space-y-2">
          {[...new Set(keys.map((k) => k.provider))].map((p) => {
            const group = keys.filter((k) => k.provider === p);
            return (
              <div key={p} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {providers.find((x) => x.id === p)?.label ?? p}
                </h3>
                <div className="space-y-2">
                  {group.map((k) => (
                    <div
                      key={k.id}
                      className="flex items-center gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {k.invalid ? (
                          <AlertTriangle size={14} className="shrink-0 text-red-400" />
                        ) : k.rateLimitedUntil && k.rateLimitedUntil > Date.now() ? (
                          <AlertTriangle size={14} className="shrink-0 text-amber-400" />
                        ) : (
                          <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm text-zinc-200">{k.label}</div>
                          <div className="text-[11px] text-zinc-500">
                            {k.usageCount} use{k.usageCount === 1 ? "" : "s"}
                            {k.invalid ? " · invalid key" : ""}
                            {k.rateLimitedUntil && k.rateLimitedUntil > Date.now() ? " · rate-limited (cooling down)" : ""}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleToggle(k.id, !k.enabled)}
                        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          k.enabled
                            ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                            : "bg-white/10 text-zinc-400 hover:bg-white/15"
                        }`}
                      >
                        {k.enabled ? "Enabled" : "Disabled"}
                      </button>
                      <button
                        onClick={() => handleDelete(k.id)}
                        className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-300"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
