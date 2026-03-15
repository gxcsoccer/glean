# youtube-assistant

OpenClaw 插件 — YouTube 视频转录、总结与下载工具。

## 功能

- **视频转录** (`youtube_transcribe`) — 字幕优先，无字幕自动降级到本地 Whisper 语音识别。返回带时间戳和 YouTube 跳转链接的文本
- **视频下载** (`youtube_download`) — 支持 480p/720p/1080p/最高画质，下载到本地后可通过飞书发送
- **智能总结** — LLM 基于转录文本生成摘要、精华时间线（带可点击链接）

## 工作流程

```
用户: "帮我总结这个视频 https://youtube.com/watch?v=xxx"
         ↓
   1. yt-dlp 尝试下载字幕（零成本，秒级）
         ↓ 没有字幕？
   2. yt-dlp 下载音频 → 发送到本地 Whisper 服务转录
         ↓
   3. LLM 拿到带时间戳的文本 → 生成总结/时间线
```

## 依赖

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — `brew install yt-dlp`
- [openclaw_whisper](https://github.com/gxcsoccer/openclaw_whisper) — 本地 Whisper STT 服务（whisper.cpp + Metal 加速）
- [OpenClaw](https://openclaw.com) — AI 个人助手框架

## 安装

```bash
# 1. 确保 yt-dlp 已安装
brew install yt-dlp

# 2. 确保 openclaw_whisper 服务已运行（默认 http://127.0.0.1:8765）

# 3. 安装插件到 OpenClaw
openclaw plugins install -l /path/to/youtube-assistant

# 4. 在 agent 配置中添加工具到 allowlist
# openclaw.json -> agents.list[].tools.allow 中添加:
#   "youtube_transcribe", "youtube_download"

# 5. 重启 gateway
openclaw gateway restart
```

## 配置

在 `openclaw.json` 的 `plugins.entries.youtube-assistant.config` 中可配置：

```json5
{
  "whisperUrl": "http://127.0.0.1:8765",  // Whisper 服务地址
  "downloadDir": "~/Downloads"              // 视频下载目录
}
```

## 性能参考（M4 Pro, whisper large-v3）

| 视频时长 | 转录耗时 | 总耗时（含下载） |
|---------|---------|----------------|
| 11 分钟 | ~87s    | ~98s           |
| 15 分钟 | ~128s   | ~141s          |
| 40 分钟 | ~294s   | ~313s          |

有字幕的视频仅需 2-3 秒。
