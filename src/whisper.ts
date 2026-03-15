/**
 * Whisper STT service client — calls /transcribe_segments for timestamped output.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export async function transcribeSegments(
  audioPath: string,
  whisperUrl: string = "http://127.0.0.1:8765",
): Promise<Segment[]> {
  const audioData = await readFile(audioPath);
  const filename = basename(audioPath);

  const formData = new FormData();
  formData.append("file", new Blob([audioData]), filename);

  const res = await fetch(`${whisperUrl}/transcribe_segments`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(30 * 60 * 1000), // 30 min for long videos
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whisper transcribe_segments failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { segments: Segment[] };
  return data.segments;
}
