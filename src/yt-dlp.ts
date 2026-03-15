/**
 * yt-dlp wrapper — subtitle download, audio extraction, video download.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, unlink, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const WORK_DIR = join(tmpdir(), "youtube-assistant");

async function ensureWorkDir() {
  await mkdir(WORK_DIR, { recursive: true });
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** Retry with exponential backoff for 429/transient errors */
async function execWithRetry(
  cmd: string,
  args: string[],
  maxRetries: number = 3,
): Promise<{ stdout: string; stderr: string }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await exec(cmd, args);
    } catch (err: any) {
      const stderr = err.stderr || "";
      const is429 = stderr.includes("429") || stderr.includes("Too Many Requests");
      const isTransient = stderr.includes("timed out") || stderr.includes("Connection reset");

      if ((is429 || isTransient) && attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt + Math.random() * 1000, 30_000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

/** Get video title and metadata */
export async function getVideoInfo(url: string): Promise<{ title: string; duration: number; id: string }> {
  const { stdout } = await execWithRetry("yt-dlp", [
    "--no-download",
    "--print", "%(title)s\n%(duration)s\n%(id)s",
    url,
  ]);
  const lines = stdout.trim().split("\n");
  return {
    title: lines[0] || "unknown",
    duration: parseFloat(lines[1]) || 0,
    id: lines[2] || "unknown",
  };
}

/**
 * Try to download subtitles (auto-generated or manual).
 * Returns the subtitle text with timestamps, or null if unavailable.
 */
export async function downloadSubtitles(
  url: string,
  langs: string = "zh-Hans,zh,en",
): Promise<{ content: string; lang: string } | null> {
  await ensureWorkDir();
  const subDir = join(WORK_DIR, `sub-${Date.now()}`);
  await mkdir(subDir, { recursive: true });

  try {
    // Try auto-generated subtitles first, then manual
    await execWithRetry("yt-dlp", [
      "--write-auto-sub",
      "--write-sub",
      "--sub-lang", langs,
      "--sub-format", "srt",
      "--skip-download",
      "--convert-subs", "srt",
      "-o", join(subDir, "%(id)s.%(ext)s"),
      url,
    ]);

    // Find the .srt file
    const files = await readdir(subDir);
    const srtFile = files.find((f) => f.endsWith(".srt"));
    if (!srtFile) return null;

    const lang = srtFile.replace(/.*\.([^.]+)\.srt$/, "$1");
    const content = await readFile(join(subDir, srtFile), "utf-8");
    return { content, lang };
  } catch {
    return null;
  } finally {
    // Cleanup
    try {
      const files = await readdir(subDir);
      for (const f of files) await unlink(join(subDir, f));
      await readdir(subDir).then(() => exec("rm", ["-rf", subDir]));
    } catch {}
  }
}

/**
 * Download audio as MP3 for Whisper transcription.
 * Returns the path to the MP3 file.
 */
export async function downloadAudio(url: string): Promise<string> {
  await ensureWorkDir();
  const outPath = join(WORK_DIR, `audio-${Date.now()}.mp3`);

  await execWithRetry("yt-dlp", [
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "-o", outPath,
    url,
  ]);

  return outPath;
}

/**
 * Download video at specified quality.
 * Returns the path to the downloaded video.
 */
export async function downloadVideo(
  url: string,
  quality: "1080" | "720" | "480" | "best" = "1080",
  downloadDir?: string,
): Promise<{ path: string; filename: string }> {
  const dir = downloadDir
    ? resolve(downloadDir.replace("~", homedir()))
    : join(homedir(), "Downloads");
  await mkdir(dir, { recursive: true });

  const formatArg =
    quality === "best"
      ? "bestvideo+bestaudio/best"
      : `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;

  const outTemplate = join(dir, "%(title)s.%(ext)s");

  // Use --print to get the actual filename
  const { stdout } = await execWithRetry("yt-dlp", [
    "-f", formatArg,
    "--merge-output-format", "mp4",
    "--print", "after_move:filepath",
    "-o", outTemplate,
    url,
  ]);

  const filepath = stdout.trim().split("\n").pop()!;
  const filename = filepath.split("/").pop()!;

  return { path: filepath, filename };
}

/**
 * Parse SRT subtitle content into segments with timestamps.
 */
export function parseSrt(srt: string): Array<{ start: number; end: number; text: string }> {
  const segments: Array<{ start: number; end: number; text: string }> = [];
  const blocks = srt.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    // Find the timestamp line (HH:MM:SS,mmm --> HH:MM:SS,mmm)
    const tsLine = lines.find((l) => l.includes("-->"));
    if (!tsLine) continue;

    const [startStr, endStr] = tsLine.split("-->").map((s) => s.trim());
    const start = parseSrtTime(startStr);
    const end = parseSrtTime(endStr);

    // Text is everything after the timestamp line
    const tsIdx = lines.indexOf(tsLine);
    const text = lines
      .slice(tsIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "") // Remove HTML tags
      .trim();

    if (text) {
      segments.push({ start, end, text });
    }
  }

  return segments;
}

function parseSrtTime(str: string): number {
  const match = str.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  return (
    parseInt(match[1]) * 3600 +
    parseInt(match[2]) * 60 +
    parseInt(match[3]) +
    parseInt(match[4]) / 1000
  );
}
