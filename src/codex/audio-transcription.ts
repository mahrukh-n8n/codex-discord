import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TRANSCRIPTION_MODEL = "base";
const STT_HOME = path.join(os.homedir(), ".codex-discord");
const STT_VENV_PATH = path.join(STT_HOME, "stt-venv");
const STT_PYTHON_PATH = path.join(STT_VENV_PATH, "bin", "python3");
const STT_LOCK_PATH = path.join(STT_HOME, "stt-install.lock");
const STT_MARKER_PATH = path.join(STT_HOME, "stt-ready.json");
const FASTER_WHISPER_VERSION = "faster-whisper==1.2.1";

const STT_VENV_RELATIVE_PATH = "stt-venv";
const UV_CANDIDATE_PATHS = [
  path.join(os.homedir(), ".local", "bin", "uv"),
  "/usr/local/bin/uv",
  "/usr/bin/uv",
];

export const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
]);

export const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".wave",
  ".webm",
]);

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

type LocalTranscriptionResult = {
  success?: boolean;
  transcript?: string;
  error?: string;
  language?: string;
  duration?: number;
};

export function isAudioAttachment(
  fileName: string | null | undefined,
  contentType: string | null | undefined,
): boolean {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalizedType.startsWith("audio/")) return true;
  if (AUDIO_MIME_TYPES.has(normalizedType)) return true;

  const ext = path.extname(fileName ?? "").toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

export function resolveSttPythonPath(sttHome = STT_HOME): string {
  return path.join(sttHome, STT_VENV_RELATIVE_PATH, "bin", "python3");
}

export function isSttRuntimeInstalled(sttHome = STT_HOME): boolean {
  const pythonPath = resolveSttPythonPath(sttHome);
  const markerPath = path.join(sttHome, "stt-ready.json");
  return fs.existsSync(pythonPath) && fs.existsSync(markerPath);
}

async function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

async function waitForInstallLockRelease(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (!fs.existsSync(lockPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for STT runtime installation lock");
}

function resolveUvCommand(): string {
  return UV_CANDIDATE_PATHS.find((candidate) => fs.existsSync(candidate)) ?? "uv";
}

async function createSttVenv(sttHome: string): Promise<void> {
  const venvPath = path.join(sttHome, STT_VENV_RELATIVE_PATH);
  fs.rmSync(venvPath, { recursive: true, force: true });

  const venvResult = await runCommand("python3", ["-m", "venv", venvPath]);
  if (venvResult.code === 0) return;

  fs.rmSync(venvPath, { recursive: true, force: true });
  const uvCommand = resolveUvCommand();
  const uvResult = await runCommand(uvCommand, ["venv", "--python", "python3", venvPath]);
  if (uvResult.code === 0) return;

  throw new Error(
    [
      `python venv creation failed: ${venvResult.stderr.trim() || venvResult.stdout.trim() || "unknown error"}`,
      `uv venv fallback failed: ${uvResult.stderr.trim() || uvResult.stdout.trim() || "unknown error"}`,
    ].join("\n"),
  );
}

async function installFasterWhisper(pythonPath: string): Promise<void> {
  const pipUpgradeResult = await runCommand(pythonPath, ["-m", "pip", "install", "--upgrade", "pip"]);
  if (pipUpgradeResult.code === 0) {
    const installResult = await runCommand(pythonPath, ["-m", "pip", "install", FASTER_WHISPER_VERSION]);
    if (installResult.code === 0) return;

    throw new Error(`faster-whisper install failed: ${installResult.stderr.trim() || installResult.stdout.trim() || "unknown error"}`);
  }

  const uvInstallResult = await runCommand(resolveUvCommand(), ["pip", "install", "--python", pythonPath, FASTER_WHISPER_VERSION]);
  if (uvInstallResult.code === 0) return;

  throw new Error(
    [
      `pip upgrade failed: ${pipUpgradeResult.stderr.trim() || pipUpgradeResult.stdout.trim() || "unknown error"}`,
      `uv pip install failed: ${uvInstallResult.stderr.trim() || uvInstallResult.stdout.trim() || "unknown error"}`,
    ].join("\n"),
  );
}

export async function ensureSttRuntime(sttHome = STT_HOME): Promise<string> {
  const pythonPath = resolveSttPythonPath(sttHome);
  const markerPath = path.join(sttHome, "stt-ready.json");
  const lockPath = path.join(sttHome, "stt-install.lock");

  if (fs.existsSync(pythonPath) && fs.existsSync(markerPath)) {
    return pythonPath;
  }

  fs.mkdirSync(sttHome, { recursive: true });

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.closeSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await waitForInstallLockRelease(lockPath);
      if (fs.existsSync(pythonPath) && fs.existsSync(markerPath)) {
        return pythonPath;
      }
      throw new Error("STT runtime install lock cleared but runtime is still unavailable");
    }
    throw error;
  }

  try {
    console.log("[audio] Installing local STT runtime for codex-discord");

    await createSttVenv(sttHome);

    await installFasterWhisper(pythonPath);

    fs.writeFileSync(
      markerPath,
      JSON.stringify({ installedAt: new Date().toISOString(), package: FASTER_WHISPER_VERSION }),
    );

    console.log("[audio] Local STT runtime installed");
    return pythonPath;
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export async function runLocalTranscription(
  filePath: string,
  model = DEFAULT_TRANSCRIPTION_MODEL,
  sttHome = STT_HOME,
): Promise<string> {
  const pythonPath = await ensureSttRuntime(sttHome);
  const script = [
    "import json",
    "import sys",
    "from faster_whisper import WhisperModel",
    "model_name = sys.argv[2]",
    "audio_path = sys.argv[1]",
    "model = WhisperModel(model_name, device='auto', compute_type='auto')",
    "segments, info = model.transcribe(audio_path, beam_size=5)",
    "transcript = ' '.join(segment.text.strip() for segment in segments).strip()",
    "sys.stdout.write(json.dumps({",
    "  'success': bool(transcript),",
    "  'transcript': transcript,",
    "  'language': getattr(info, 'language', ''),",
    "  'duration': getattr(info, 'duration', 0),",
    "  'error': '' if transcript else 'Audio transcription returned an empty transcript'",
    "}))",
  ].join("\n");

  const { stdout, stderr, code } = await runCommand(pythonPath, ["-c", script, filePath, model]);
  if (code !== 0) {
    throw new Error(`Local transcription failed: ${stderr.trim() || stdout.trim() || "unknown error"}`);
  }

  let parsed: LocalTranscriptionResult;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Local transcription returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed.success || !parsed.transcript?.trim()) {
    throw new Error(parsed.error || "Audio transcription returned an empty transcript");
  }

  return parsed.transcript.trim();
}

export async function transcribeAudioFile(
  filePath: string,
  _mimeType: string,
  model = DEFAULT_TRANSCRIPTION_MODEL,
): Promise<string> {
  try {
    const transcript = await runLocalTranscription(filePath, model);
    console.log(`[audio] Transcribed ${path.basename(filePath)} via local faster-whisper model=${model}`);
    return transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[audio] Local transcription failed for ${path.basename(filePath)}: ${message}`);
    throw new Error(`Local STT failed: ${message}`);
  }
}
