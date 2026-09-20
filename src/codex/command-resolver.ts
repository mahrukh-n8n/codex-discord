import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CACHE_PATH = path.join(os.homedir(), ".codex", "codex-discord-runtime.json");

interface RuntimeCache {
  codexCommand?: string;
}

function loadCache(): RuntimeCache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")) as RuntimeCache;
  } catch {
    return {};
  }
}

function saveCache(cache: RuntimeCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // ignore cache write failures
  }
}

function commandVersion(command: string): number[] | null {
  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status !== 0) return null;
    const version = `${result.stdout ?? ""} ${result.stderr ?? ""}`.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    return version ? version.slice(1).map(Number) : [0, 0, 0];
  } catch {
    return null;
  }
}

function isNewerVersion(candidate: number[], current: number[]): boolean {
  for (let index = 0; index < 3; index++) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}

function uniqueCandidates(candidates: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    resolved.push(trimmed);
  }
  return resolved;
}

function unixCandidates(): string[] {
  const home = os.homedir();
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  return uniqueCandidates([
    process.env.CODEX_BIN,
    ...pathEntries.map((entry) => path.join(entry, "codex")),
    path.join(home, ".npm-global", "bin", "codex"),
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".volta", "bin", "codex"),
    path.join(home, ".yarn", "bin", "codex"),
    path.join(home, ".config", "yarn", "global", "node_modules", ".bin", "codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    "/opt/homebrew/bin/codex",
    "codex",
  ]);
}

export function resolveCodexCommand(): string {
  const cache = loadCache();
  const explicitCommand = process.env.CODEX_BIN?.trim();
  if (explicitCommand && commandVersion(explicitCommand)) {
    return explicitCommand;
  }

  const candidates = uniqueCandidates([
    cache.codexCommand,
    ...(process.platform === "win32"
      ? ["codex.cmd", "codex.exe", "codex"]
      : unixCandidates()),
  ]);

  let selected: string | null = null;
  let selectedVersion = [0, 0, 0];
  for (const candidate of candidates) {
    const version = commandVersion(candidate);
    if (!version) continue;
    if (selected && !isNewerVersion(version, selectedVersion)) continue;
    selected = candidate;
    selectedVersion = version;
  }

  if (selected) {
    if (selected !== cache.codexCommand) saveCache({ ...cache, codexCommand: selected });
    return selected;
  }
  return process.platform === "win32" ? "codex.cmd" : "codex";
}
