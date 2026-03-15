/**
 * OpenClaw tool registrations for youtube-assistant.
 */

import { Type } from "@sinclair/typebox";
import { unlink } from "node:fs/promises";
import {
  getVideoInfo,
  downloadSubtitles,
  downloadAudio,
  downloadVideo,
  parseSrt,
} from "./yt-dlp.js";
import { transcribeSegments, type Segment } from "./whisper.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function segmentsToTranscript(segments: Segment[], videoId?: string): string {
  return segments
    .map((s) => {
      const ts = `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}]`;
      if (videoId) {
        const secs = Math.floor(s.start);
        return `${ts}(https://www.youtube.com/watch?v=${videoId}&t=${secs}s) ${s.text}`;
      }
      return `${ts} ${s.text}`;
    })
    .join("\n");
}

function extractVideoId(url: string): string {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : "";
}

type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  registerTool: (tool: unknown, opts?: unknown) => void;
};

export function registerYouTubeTools(api: PluginApi) {
  const whisperUrl = (api.pluginConfig?.whisperUrl as string) || "http://127.0.0.1:8765";
  const downloadDir = (api.pluginConfig?.downloadDir as string) || "~/Downloads";

  // ── youtube_transcribe ──
  api.registerTool(
    {
      name: "youtube_transcribe",
      description:
        "Transcribe a YouTube video with timestamps. " +
        "Tries platform subtitles first (fast), falls back to local Whisper STT. " +
        "Returns timestamped transcript text that can be used for summarization or timeline extraction.",
      parameters: Type.Object({
        url: Type.String({ description: "YouTube video URL" }),
        lang: Type.Optional(
          Type.String({
            description: 'Preferred subtitle languages, comma-separated (default: "zh-Hans,zh,en")',
          }),
        ),
      }),
      async execute(_id: string, params: { url: string; lang?: string }) {
        const { url, lang } = params;
        api.logger.info?.("youtube_transcribe: starting", url);

        try {
          // Step 0: Extract video ID for deep links
          const videoId = extractVideoId(url);

          // Step 1: Get video info
          const t0 = Date.now();
          const info = await getVideoInfo(url);
          api.logger.info?.(`youtube_transcribe: video="${info.title}" duration=${info.duration}s (${Date.now() - t0}ms)`);

          // Step 2: Try subtitles first
          const t1 = Date.now();
          api.logger.info?.("youtube_transcribe: trying subtitles...");
          const subs = await downloadSubtitles(url, lang || "zh-Hans,zh,en");
          if (subs) {
            const segments = parseSrt(subs.content);
            const transcript = segmentsToTranscript(segments, videoId);
            api.logger.info?.(`youtube_transcribe: done via subtitle (lang=${subs.lang}, ${segments.length} segments, ${Date.now() - t1}ms)`);
            return json({
              title: info.title,
              duration: info.duration,
              video_id: videoId,
              source: "subtitle",
              language: subs.lang,
              transcript,
              segment_count: segments.length,
              hint: `When listing highlights, generate clickable YouTube links for each timestamp using: https://www.youtube.com/watch?v=${videoId}&t={SECONDS}s (convert MM:SS to total seconds).`,
            });
          }
          api.logger.info?.(`youtube_transcribe: no subtitles available (${Date.now() - t1}ms)`);

          // Step 3: Fall back to Whisper
          const t2 = Date.now();
          api.logger.info?.("youtube_transcribe: downloading audio...");
          const audioPath = await downloadAudio(url);
          api.logger.info?.(`youtube_transcribe: audio downloaded to ${audioPath} (${Date.now() - t2}ms)`);

          try {
            const t3 = Date.now();
            api.logger.info?.(`youtube_transcribe: sending to Whisper at ${whisperUrl}...`);
            const segments = await transcribeSegments(audioPath, whisperUrl);
            const transcript = segmentsToTranscript(segments, videoId);
            api.logger.info?.(`youtube_transcribe: done via whisper (${segments.length} segments, ${transcript.length} chars, ${Date.now() - t3}ms)`);
            api.logger.info?.(`youtube_transcribe: total time ${Date.now() - t0}ms`);
            return json({
              title: info.title,
              duration: info.duration,
              video_id: videoId,
              source: "whisper",
              transcript,
              segment_count: segments.length,
              hint: `When listing highlights, generate clickable YouTube links for each timestamp using: https://www.youtube.com/watch?v=${videoId}&t={SECONDS}s (convert MM:SS to total seconds).`,
            });
          } finally {
            await unlink(audioPath).catch(() => {});
          }
        } catch (err: any) {
          const msg = err.message || String(err);
          const stack = err.stack || "";
          api.logger.error?.(`youtube_transcribe failed: ${msg}`);
          api.logger.error?.(`youtube_transcribe stack: ${stack}`);
          return json({ error: msg });
        }
      },
    },
  );

  // ── youtube_download ──
  api.registerTool(
    {
      name: "youtube_download",
      description:
        "Download a YouTube video to local disk. " +
        "Returns the file path. Use Feishu drive tools to send the file to the user if needed.",
      parameters: Type.Object({
        url: Type.String({ description: "YouTube video URL" }),
        quality: Type.Optional(
          Type.Union(
            [
              Type.Literal("1080"),
              Type.Literal("720"),
              Type.Literal("480"),
              Type.Literal("best"),
            ],
            { description: 'Video quality (default: "1080")' },
          ),
        ),
      }),
      async execute(_id: string, params: { url: string; quality?: "1080" | "720" | "480" | "best" }) {
        const { url, quality } = params;
        api.logger.info?.("youtube_download: starting", url, quality);

        try {
          const t0 = Date.now();
          const info = await getVideoInfo(url);
          api.logger.info?.(`youtube_download: video="${info.title}" quality=${quality || "1080"}`);

          const t1 = Date.now();
          api.logger.info?.("youtube_download: downloading...");
          const result = await downloadVideo(url, quality || "1080", downloadDir);

          api.logger.info?.(`youtube_download: saved to ${result.path} (${result.filename}, ${Date.now() - t1}ms, total ${Date.now() - t0}ms)`);
          return json({
            title: info.title,
            quality: quality || "1080",
            path: result.path,
            filename: result.filename,
            message: `Video downloaded to ${result.path}`,
          });
        } catch (err: any) {
          const msg = err.message || String(err);
          api.logger.error?.(`youtube_download failed: ${msg}`);
          api.logger.error?.(`youtube_download stack: ${err.stack || ""}`);
          return json({ error: msg });
        }
      },
    },
  );

  api.logger.info?.("youtube-assistant: Registered youtube_transcribe and youtube_download tools");
}
