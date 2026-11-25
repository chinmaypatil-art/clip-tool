# Clipwise

Turn a long podcast or interview (Hindi, English or Hinglish) into five
ready-to-post 9:16 clips. Paste a YouTube link or upload a video, pick a clip
length and caption style, and about ten minutes later you have five rendered
clips, each on one clean topic.

Everything runs locally on one machine with free tools: Whisper for
transcription, Gemma 3 12B (via Ollama) for picking clips, ffmpeg with NVENC
for rendering. No paid APIs.

## Features

- **One flow.** Link or upload in, five clips out. Progress is live and the
  job keeps running if you leave the page.
- **Clip picking.** Gemma reads the transcript by numbered lines and picks
  whole thoughts, with a "Why:" for each. An optional focus ("funny moments",
  "money advice") steers it.
- **Hook-first openings.** Where a clip has a stronger line than its opening,
  that line plays first as a teaser, then the clip from its start.
- **Clean audio and pacing.** Two-pass loudness to -14 LUFS with denoise and a
  limiter; long pauses and "um"s are trimmed.
- **Speaker framing.** Face detection follows whoever is talking, shows both
  people in split shots, and zooms out when someone gestures.
- **Captions.** Word-by-word captions with presets and custom font, size,
  colours, background and position.
- **Editor.** Full-screen editor per clip:
  - *Ask AI*: type "cut the intro", "make it 40 seconds", "remove the ums".
  - *Transcript*: cut words, set start/end on a word, fix spelling, change
    framing for a stretch, remove all fillers or silences in one click.
  - *Options*: hook, pause trimming, captions and caption style per clip.
  - Live preview, timeline, undo/redo, reset to the AI version.
- **Feedback for training.** Good / Bad on every clip, with tags and a note.
- **Sharing.** Password gate and a start script that publishes the app from
  your PC with Tailscale Funnel.

## How it works

```
video (YouTube link or upload)
  → transcript    YouTube captions when available, else Whisper large-v3-turbo (GPU)
  → picking       Gemma 3 12B picks clips window by window, re-ranks them, picks hooks
  → cleanup       length limits, overlaps, sentence and silence snapping
  → per clip      Whisper word timings, face/speaker framing, pause trimming,
                  user edits, hook-first cut
  → render        ffmpeg filter graph + ASS captions + loudness, h264_nvenc → 1080x1920 MP4
                  (Remotion is the fallback if ffmpeg fails)
```

A 25-minute video takes about 10 minutes on an RTX 4060 Ti: a few minutes to
download and pick, then clips render one at a time (about 1.5 min each), so
the first clip is ready early.

## Requirements

- Windows 10/11 (tested; Linux/macOS should work but use different fonts)
- Node.js 20+
- [ffmpeg](https://ffmpeg.org) and [yt-dlp](https://github.com/yt-dlp/yt-dlp) on `PATH`
- [Ollama](https://ollama.com) with `gemma3:12b` pulled
- An NVIDIA GPU with 12 GB+ VRAM is recommended (Whisper, Gemma and NVENC all use it)

## Getting started

```bash
npm install
cp .env.local.example .env.local
ollama pull gemma3:12b
npm run dev                  # http://localhost:3000
```

The Whisper binary and model download automatically the first time a video
needs transcribing.

For daily use, run the production build instead:

```bash
npm run build
npm start
```

## Sharing with others

To give one or two people access while everything runs on your PC:

1. Set `APP_PASSWORD` in `.env.local`. Every page then asks for it.
2. Install [Tailscale](https://tailscale.com), log in, and enable Funnel for
   your tailnet.
3. Run `npm run build`, then `scripts/start-shared.cmd` (or install it as a
   boot task with `scripts/install-boot-task.ps1`). It publishes port 3000 at
   `https://<machine>.<tailnet>.ts.net` and restarts the app if it stops.

**Updating:** just run `npm run build`. The build goes to `.next-new`, so the
running app is untouched; once no job is running and nobody has used the site
for 5 minutes, the app restarts and swaps the new build in
(`scripts/swap-build.mjs`).

## Configuration

All settings go in `.env.local`.

| Variable | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | unset (open) | Password for the whole app |
| `CLIP_PROVIDER` / `CLIP_MODEL` | `ollama-local` / `gemma3:12b` | Model that picks clips |
| `OLLAMA_NUM_CTX` | `32768` | Context window for Ollama models |
| `RENDERER` | `ffmpeg` | `ffmpeg`, or `remotion` to force the fallback renderer |
| `RENDER_SLOTS` | `1` | Remotion renders at the same time |
| `RENDER_CONCURRENCY` | `75%` | Remotion render threads |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_LANGUAGE` | auto | Whisper overrides |
| `MIN_FREE_GB` | `10` | Below this, new videos are refused |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | unset | Gemini, used only as a benchmark in `/lab` |
| `KEY_STORE_SECRET` | unset | Encrypts API keys saved in `/lab` |

## Training data

Every review is stored three ways, so no label is ever lost:

| File | Contents |
|---|---|
| `storage/analyses/<id>/analysis.json` | The video's transcript, picks and reviews (written atomically) |
| `storage/training/review-log.jsonl` | Append-only log of every review change; never rewritten |
| `storage/training/reviews.jsonl` | Every reviewed clip, rebuilt on each save |
| `storage/training/sft.jsonl` | Chat-format fine-tuning examples, one per reviewed transcript window, using the exact prompt Gemma picks with |

`storage/training/replayed-sft.jsonl` adds examples built from YouTube "Most
replayed" data (`scripts/collect-replayed.mts`).

Deleting a video from the Library removes its media but keeps its reviews.
Clips picked by Gemini are kept out of `sft.jsonl` (API terms).

The plan is to fine-tune Gemma 3 12B with QLoRA once there are about 150
reviewed clips.

## Project layout

| Path | Contents |
|---|---|
| `src/app/` | Pages (`/`, `/login`, `/lab`) and API routes |
| `src/components/studio/` | The app UI: create, progress, clips, library, caption picker |
| `src/lib/analysisPipeline.ts` | The pipeline: transcript, picking, cleanup, rendering |
| `src/lib/clipTrim.ts` | Sentence and silence snapping for clip edges |
| `src/lib/ffmpegRender.ts` | ffmpeg renderer and ASS caption builder |
| `src/lib/framing.ts` | Face detection, speaker following, gesture zoom |
| `src/lib/tighten.ts` | Pause/filler trimming and timeline remapping |
| `src/lib/clipEdit.ts`, `src/lib/aiEdit.ts` | Editor edits and Ask AI |
| `src/lib/captionStyle.ts` | Caption presets and options |
| `src/lib/providers/` | Model providers (Ollama, Gemini, OpenAI-compatible, ...) |
| `src/lib/training.ts` | Training data export and review log |
| `src/proxy.ts`, `src/lib/access.ts` | Password gate |
| `remotion/` | Fallback Remotion template |
| `scripts/` | Start/deploy scripts, `check-*` self-checks, timing and test tools |
| `storage/` | Runtime data. Not committed |

## Lab

`/lab` holds the developer workbench: compare models on the same transcript,
manage API keys, and run the older clip flow. It isn't linked from the app.
