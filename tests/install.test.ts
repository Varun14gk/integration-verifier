// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  enableTomlSection, installClaudeCode, installCodex, installGeminiCli, uninstallClaudeCode, uninstallCodex, uninstallGeminiCli,
} from "../packages/cli/src/install.js";

const ROOT = join(import.meta.dirname, "..");
const LAUNCHER = join(ROOT, "adapters", "shared", "iv-launch.mjs");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("install and uninstall", () => {
  it("Claude Code project scope writes the personal settings.local.json, and uninstall removes only our keys", () => {
    const project = mkdtempSync(join(tmpdir(), "iv-proj-"));
    mkdirSync(join(project, ".claude"));
    writeFileSync(join(project, ".claude", "settings.json"), '{ "shared": true }');
    installClaudeCode({ scope: "project", projectDir: project });
    expect(json(join(project, ".claude", "settings.json"))).toEqual({ shared: true });
    const local = json(join(project, ".claude", "settings.local.json"));
    expect(local.enabledPlugins).toEqual({ "integration-verifier@integration-verifier": true });

    const home = mkdtempSync(join(tmpdir(), "iv-home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", enabledPlugins: { "other@x": true } }));
    installClaudeCode({ home });
    // Change settings after installing: uninstall must keep this, unlike restoring an old backup.
    const s = json(join(home, ".claude", "settings.json"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ ...s, model: "opus" }));
    uninstallClaudeCode({ home });
    expect(json(join(home, ".claude", "settings.json"))).toEqual({ theme: "dark", model: "opus", enabledPlugins: { "other@x": true } });
  });

  it("Codex: re-enables a disabled section, never puts a project path in the shared plugin, and uninstalls cleanly", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-codex-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n\n[plugins."integration-verifier@personal"]\nenabled = false\n\n[other]\na = 1\n');
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# Mine\n");
    installCodex({ home, scope: "project", projectDir: mkdtempSync(join(tmpdir(), "iv-p-")) });
    installCodex({ home });
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('[plugins."integration-verifier@personal"]\nenabled = true');
    expect(toml).toContain("[other]\na = 1");
    expect(json(join(home, ".codex", "plugins", "integration-verifier", "mcp.json")).mcpServers["integration-verifier"].args).not.toContain("--root");

    uninstallCodex({ home });
    expect(existsSync(join(home, ".codex", "plugins", "integration-verifier"))).toBe(false);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain("integration-verifier");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[other]\na = 1");
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# Mine\n");
    expect(json(join(home, ".agents", "plugins", "marketplace.json")).plugins).toEqual([]);
  });

  it("refuses to edit a damaged instruction block instead of adding a second one", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-codex-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# Mine\n<!-- integration-verifier:start -->\nhalf a block\n");
    expect(() => installCodex({ home })).toThrow(/damaged Integration Verifier section/);
  });

  it("adds an enabled line when the section has none", () => {
    expect(enableTomlSection('[plugins."p@m"]\nfoo = 1\n', '[plugins."p@m"]')).toBe('[plugins."p@m"]\nenabled = true\nfoo = 1\n');
  });

  it("keeps a timestamped backup for every change", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    installClaudeCode({ home });
    uninstallClaudeCode({ home });
    const backups = spawnSync("ls", [join(home, ".claude")], { encoding: "utf8" }).stdout.split(/\s+/).filter((f) => f.includes(".iv-backup-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("Gemini CLI install and uninstall", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-gem-"));
    installGeminiCli({ home });
    expect(existsSync(join(home, ".gemini", "extensions", "integration-verifier", "gemini-extension.json"))).toBe(true);
    uninstallGeminiCli({ home });
    expect(existsSync(join(home, ".gemini", "extensions", "integration-verifier"))).toBe(false);
  });
});

describe("launcher fails closed", () => {
  const fake = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "iv fake cli "));
    const file = join(dir, "cli.mjs");
    writeFileSync(file, body);
    return file;
  };
  const launch = (cli: string, args: string[]) =>
    spawnSync(process.execPath, [LAUNCHER, ...args], { input: "{}", encoding: "utf8", env: { ...process.env, IV_CLI: cli, IV_HOME: mkdtempSync(join(tmpdir(), "h-")) } });

  it("turns a crashing CLI into a block for the Stop gate, and exit 4 elsewhere", () => {
    const crash = fake("process.exit(4);\n");
    expect(launch(crash, ["hook", "claude-code", "stop"]).status).toBe(2);
    expect(launch(crash, ["check"]).status).toBe(4);
  });

  it("turns a killed CLI into a block (exit 2), never a silent pass", () => {
    const killed = fake("process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);\n");
    const r = launch(killed, ["hook", "codex", "stop"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/stopped|exited with an error/);
  });

  it("passes arguments with spaces through intact", () => {
    const echo = fake("console.log(JSON.stringify(process.argv.slice(2)));\n");
    const r = launch(echo, ["map", "--root", "C:/My Projects/app one"]);
    expect(JSON.parse(r.stdout)).toEqual(["map", "--root", "C:/My Projects/app one"]);
  });
});
