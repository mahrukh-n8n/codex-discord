import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAudioAttachment,
  isSttRuntimeInstalled,
  resolveSttPythonPath,
} from "./audio-transcription.js";

describe("audio transcription helpers", () => {
  it("detects audio attachments by mime type or extension", () => {
    expect(isAudioAttachment("voice-message", "audio/ogg; codecs=opus")).toBe(true);
    expect(isAudioAttachment("voice-message.ogg", null)).toBe(true);
    expect(isAudioAttachment("notes.txt", "text/plain")).toBe(false);
  });

  it("resolves the bot-local STT python runtime path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stt-"));
    const pythonPath = path.join(dir, "stt-venv", "bin", "python3");
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    fs.writeFileSync(pythonPath, "");

    try {
      expect(resolveSttPythonPath(dir)).toBe(pythonPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects whether the bot-local transcription runtime is installed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stt-"));
    const pythonPath = path.join(dir, "stt-venv", "bin", "python3");
    const markerPath = path.join(dir, "stt-ready.json");
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    fs.writeFileSync(pythonPath, "");
    fs.writeFileSync(markerPath, "{}");

    try {
      expect(isSttRuntimeInstalled(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
