# Clip Tool

Upload a long video (Hindi / English / Hinglish podcast or interview) and get
short vertical 9:16 clips with a strong chance of going viral, in about 20–25
minutes. All processing runs on the server, so users only need a browser.
Everything uses free-tier or local tools; no paid AI models.

## How it works

```
video (upload or YouTube link)
  → transcript      YouTube captions if available, else Whisper (large-v3-turbo, local GPU)
  → clip picking    an LLM reads the transcript and returns start/end + title + hook + score
  → validation      clamp to the chosen length range, drop overlaps, trim trailing questions
  → per clip:
      captions      Whisper on the clip audio, word-level, Hinglish romanized
      framing       face detection (ONNX) → fill / fit / split (2 people stacked)
      render        Remotion → 1080x1920 MP4 with animated captions
```

Two screens:
- **New Clip**: the end-to-end pipeline (Gemini).
- **Compare**: runs several models on the same transcript side by side, so we
  can judge which model picks the best clips. Users can add any
  OpenAI-compatible provider (Groq, OpenRouter, Ollama, ...) under Keys.

## Setup

Requirements: Node 20+, ffmpeg on PATH, an NVIDIA GPU is recommended (Whisper
and Ollama). yt-dlp on PATH for YouTube links.

```bash
npm install
cp .env.local.example .env.local   # add your Gemini key (free tier)
npm run dev                         # http://localhost:3000
```

The Whisper binary and model download automatically on the first transcription.

Local model (optional): install [Ollama](https://ollama.com), pull a model, then in the
app go to Keys → add the "Ollama (local)" preset → Load models. No API key is needed.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Gemini key for New Clip |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Main Gemini model |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Used after repeated 503s |
| `KEY_STORE_SECRET` | — | Encrypts API keys saved from the Keys page |
| `OLLAMA_NUM_CTX` | `32768` | Context window for Ollama models |
| `RENDER_CONCURRENCY` | `75%` | Remotion render threads |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_LANGUAGE` | — | Whisper overrides |

## Project layout

| Path | What |
|---|---|
| `src/lib/pipeline.ts` | New Clip pipeline |
| `src/lib/analysisPipeline.ts` | Compare pipeline (transcript once, many models) |
| `src/lib/gemini.ts` | Gemini prompts, retries, Hinglish romanization |
| `src/lib/providers/` | Model providers (Gemini, OpenAI, Anthropic, any OpenAI-compatible, Ollama) |
| `src/lib/transcript.ts` | YouTube caption fetching (yt-dlp) |
| `src/lib/whisper.ts` | Local Whisper transcription |
| `src/lib/framing.ts` | Face detection and shot layout |
| `src/lib/clipTrim.ts`, `validation.ts` | Clip boundary cleanup |
| `src/lib/keystore.ts` | Encrypted API key store and custom providers |
| `remotion/` | The 9:16 video template and captions |
| `storage/` | Runtime data (videos, renders, keys). Not committed. |

## Status and findings so far

Tested on two real Hindi/English podcasts (38 and 53 minutes).

**Models**
- **Gemini 3.5 Flash Lite** (free tier) picks the best clips, in about 5 seconds,
  but often returns 503 "high demand". `gemini-2.5-flash` is no longer available
  to new keys, so the fallback model needs updating.
- **Gemma 4 26B (local, 2-bit quantized)** gives usable picks in about 40 s on the
  second video. On the first it picked the teaser montage and wrote 10x too much.
- **Qwen3 14B (local)** returned single 3–10 s lines, so every pick was dropped.
- **Groq free tier**: an 8,000 tokens/min limit is too small for a full transcript.

**Known issues (priority order)**
1. Rendering several clips at once overloads the machine (Chrome timeouts, 8–13 min
   per clip). A render queue is needed.
2. Split layout sometimes frames a background object (a plant) as the second person.
3. Clips longer than the maximum are hard-cut mid-sentence.
4. Clips sometimes start mid-sentence or miss the interviewer's question.
5. Compare downloads the whole video before fetching captions (about 5 min wasted).

## Roadmap

1. Fix the issues above (render queue, framing, sentence-aligned boundaries).
2. Add 👍/👎 + reason buttons on each clip to build a labelled dataset.
3. Fine-tune our own clip-picking model (Qwen3 8B or Gemma 12B, QLoRA with
   Unsloth on a 16 GB GPU) on about 300 labelled clips, working on 5-minute transcript chunks.
   Goal: a free local model that matches or beats Gemini, so we no longer depend on it.
