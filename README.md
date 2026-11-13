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
- **New Clip**: the end-to-end pipeline, run entirely on local Gemma 3 12B (Ollama).
- **Compare**: runs several models on the same transcript side by side, so we
  can judge which model picks the best clips. Users can add any
  OpenAI-compatible provider (Groq, OpenRouter, Ollama, ...) under Keys.

## Reviewing clips (training data)

Every clip in Compare has a review panel: Good / Bad, a reason tag for bad
clips, and arrows that move the start or end one whole sentence. Saving a
review rebuilds `storage/training/`:

- `reviews.jsonl`: every reviewed clip from every model (benchmarks, stats).
- `sft.jsonl`: chat-format fine-tuning examples, one per 5-minute transcript
  window that holds a reviewed clip. The answer is the approved clips with
  corrected edges. Gemini's clips are left out (API terms).

When every clip of a video is reviewed, "Done, free up space" deletes the
downloaded video and audio files; `analysis.json` (transcript, picks,
reviews) is kept.

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
| `GEMINI_API_KEY` | — | Gemini key (Compare benchmark only) |
| `CLIP_PROVIDER` / `CLIP_MODEL` | `ollama-local` / `gemma3:12b` | Model New Clip uses |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Main Gemini model |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Used after repeated 503s |
| `KEY_STORE_SECRET` | — | Encrypts API keys saved from the Keys page |
| `OLLAMA_NUM_CTX` | `32768` | Context window for Ollama models |
| `RENDER_CONCURRENCY` | `75%` | Remotion render threads |
| `RENDER_SLOTS` | `1` | Clips rendered at the same time (server-wide) |
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

**Fixed**
- Parallel renders overloaded the machine (8–13 min per clip, Chrome timeouts).
  Renders are now queued, and captions and framing for upcoming clips are prepared during the current render.
- Split layout framed a background plant as a second person. Motionless
  detections are now ignored.
- Over-long clips were hard-cut mid-sentence. They now end on a transcript line.

**Open issues (priority order)**
1. Clips sometimes start mid-sentence or miss the interviewer's question.
2. Compare downloads the whole video before fetching captions (about 5 min wasted).
3. `gemini-2.5-flash` (the default fallback) is retired for new API keys.

## Roadmap

1. Measure a baseline with Gemma 3 12B (local, via Ollama) against Gemini.
2. Add a review panel (keep or reject + reason, adjust the start and end) that exports a labelled dataset.
3. Fine-tune Gemma 3 12B (QLoRA with Unsloth on a 16 GB GPU) on about 300 reviewed clips,
   using 5-minute transcript chunks. Gemini is a benchmark only; its output is not used
   for training (API terms).
4. Cut the end-to-end time from 20–25 min to 10–15 min per video.
