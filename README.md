# Clipwise

Turn a long podcast or interview (Hindi, English or Hinglish) into five
ready-to-post 9:16 clips. Paste a YouTube link or upload a video, pick a clip
length and caption style, and about ten minutes later you have five rendered
clips, each on one clean topic.

Everything runs locally on one machine with free tools: Whisper for
transcription, Gemma 3 12B (via Ollama) for picking clips, ffmpeg with NVENC
for rendering. No paid APIs.

## Features

- **One flow.** Link or upload in, five clips out. Progress is shown live and
  the job keeps running if you leave the page.
- **Clean clips.** Edges snap to whole sentences and to pauses in the audio. A
  clip never cuts the speaker off mid-thought, and a short topic stays a
  shorter clip instead of being padded with the next one.
- **Smart framing.** Face detection chooses fill, fit or a two-person split
  layout per shot.
- **Captions.** Word-by-word karaoke captions, on or off, with presets
  (Classic, Bold, Boxed, Minimal) and custom font, size, colours, background,
  position and words on screen.
- **Library.** Every video with its clips, searchable. Each clip shows its
  source timestamps (linked to the YouTube moment) and downloads under its
  title.
- **Feedback for training.** Good / Bad on every clip in one tap, with optional
  tags and a note. Edges can be corrected a sentence at a time.
- **Sharing.** Optional password gate and a one-click start script for
  publishing the app from your PC with Tailscale Funnel.

## How it works

```
video (YouTube link or upload)
  → transcript    YouTube captions when available, else Whisper large-v3-turbo (GPU)
  → picking       Gemma 3 12B reads the transcript in windows, returns clips
  → cleanup       length limits, overlap removal, sentence and silence snapping
  → per clip      Whisper word timings for captions, face detection for framing
  → render        ffmpeg filter graph + ASS captions, h264_nvenc → 1080x1920 MP4
                  (Remotion is the fallback if ffmpeg fails)
```

A 25-minute video takes about 10 minutes end to end on an RTX 4060 Ti: about
2.5 minutes to download, 1–2 minutes to pick clips, and the rest preparing
and rendering clips two at a time.

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

To give one or two people access while everything keeps running on your PC:

1. Set `APP_PASSWORD` in `.env.local`. Every page then asks for it.
2. Install [Tailscale](https://tailscale.com), log in, and enable Funnel for
   your tailnet.
3. Run `npm run build`, then double-click `scripts/start-shared.cmd`. It
   publishes port 3000 at `https://<machine>.<tailnet>.ts.net` and starts the
   app. Keep its window open.

The PC must stay on and awake while the link is in use.

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
| `src/lib/framing.ts` | Face detection and shot layout |
| `src/lib/captionStyle.ts` | Caption presets and options |
| `src/lib/providers/` | Model providers (Ollama, Gemini, OpenAI-compatible, ...) |
| `src/lib/training.ts` | Training data export and review log |
| `src/proxy.ts`, `src/lib/access.ts` | Password gate |
| `remotion/` | Fallback Remotion template |
| `scripts/` | Start script and developer tools (see each file's header) |
| `storage/` | Runtime data. Not committed |

## Lab

`/lab` holds the developer workbench: compare models on the same transcript,
manage API keys, and run the older clip flow. It isn't linked from the app.
