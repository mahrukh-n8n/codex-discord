import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveCodexCommand } from "./command-resolver.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

const originalPath = process.env.PATH;
const originalCodexBin = process.env.CODEX_BIN;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
  vi.resetAllMocks();
});

describe("resolveCodexCommand", () => {
  it("replaces a working cached CLI when a newer one is installed", () => {
    const newer = path.join(os.homedir(), ".npm-global", "bin", "codex");
    process.env.PATH = `/usr/bin${path.delimiter}${path.dirname(newer)}`;
    delete process.env.CODEX_BIN;
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ codexCommand: "/usr/bin/codex" }));
    vi.mocked(spawnSync).mockImplementation((command) => {
      if (command === "/usr/bin/codex") return { status: 0, stdout: "codex-cli 0.125.0" } as ReturnType<typeof spawnSync>;
      if (command === newer) return { status: 0, stdout: "codex-cli 0.155.1" } as ReturnType<typeof spawnSync>;
      return { status: 1, stdout: "" } as ReturnType<typeof spawnSync>;
    });

    expect(resolveCodexCommand()).toBe(newer);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(`"codexCommand": "${newer}"`),
    );
  });
});
