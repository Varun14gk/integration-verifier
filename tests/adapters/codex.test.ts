// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "@integration-verifier/core";
import { filesOf } from "../../packages/cli/src/hooks.js";
import { installCodex } from "../../packages/cli/src/install.js";

const ROOT = join(import.meta.dirname, "..", "..");
const PLUGIN = join(ROOT, "adapters", "codex");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");
const FIXTURE = join(ROOT, "fixtures", "nextjs-express");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const patch = (file: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch\n`;

describe("Codex adapter files", () => {
  it("has a portable manifest and the .codex-plugin fallback", () => {
    const portable = json(join(PLUGIN, "plugin.json"));
    expect(portable.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(Object.keys(portable).every((k) => ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"].includes(k))).toBe(true);
    const codex = json(join(PLUGIN, ".codex-plugin", "plugin.json"));
    expect([portable.name, codex.name]).toEqual(["integration-verifier", "integration-verifier"]);
    expect([portable.version, codex.version]).toEqual([VERSION, VERSION]);
    for (const p of [codex.skills, codex.mcpServers, codex.hooks]) expect(existsSync(join(PLUGIN, p)), p).toBe(true);
  });

  it("hooks match apply_patch edits and Stop, through the launcher", () => {
    const h = json(join(PLUGIN, "hooks", "hooks.json")).hooks;
    expect(h.PostToolUse[0].matcher).toContain("apply_patch");
    expect(h.PostToolUse[0].hooks[0].command).toBe('node "$PLUGIN_ROOT/scripts/iv-launch.mjs" hook codex post-write');
    expect(h.Stop[0].hooks[0].command).toBe('node "$PLUGIN_ROOT/scripts/iv-launch.mjs" hook codex stop');
    expect(json(join(PLUGIN, "mcp.json")).mcpServers["integration-verifier"]).toMatchObject({ type: "stdio", command: "node" });
  });

  it("ships the same skill and launcher as the other adapters", () => {
    expect(readFileSync(join(PLUGIN, "scripts", "iv-launch.mjs"), "utf8")).toBe(readFileSync(join(ROOT, "adapters", "shared", "iv-launch.mjs"), "utf8"));
    expect(readFileSync(join(PLUGIN, "skills", "integration-verifier", "SKILL.md"), "utf8")).toBe(readFileSync(join(ROOT, "adapters", "claude-code", "skills", "integration-verifier", "SKILL.md"), "utf8"));
  });

  it("reads the edited files out of an apply_patch", () => {
    const p = "*** Begin Patch\n*** Add File: a/new.ts\n+x\n*** Update File: b/old.py\n*** Move to: b/renamed.py\n*** Delete File: c/gone.js\n*** End Patch";
    expect(filesOf({ tool_name: "apply_patch", tool_input: { command: p } })).toEqual(["a/new.ts", "b/old.py", "b/renamed.py"]);
  });
});

describe("Codex hooks", () => {
  const run = (event: string, input: object) => {
    const r = spawnSync(process.execPath, [join(PLUGIN, "scripts", "iv-launch.mjs"), "hook", "codex", event], {
      input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, IV_CLI: CLI }, timeout: 240_000,
    });
    return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };

  it("post-write on an apply_patch returns context; stop blocks once", () => {
    const post = run("post-write", { cwd: FIXTURE, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: patch("backend/src/server.js") } });
    expect(post.out.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse" });
    expect(post.out.hookSpecificOutput.additionalContext).toContain("backend/src/server.js:21");
    expect(run("stop", { cwd: FIXTURE, stop_hook_active: false }).out.decision).toBe("block");
    expect(run("stop", { cwd: FIXTURE, stop_hook_active: true })).toEqual({ code: 0, out: null });
  }, 300_000);
});

describe("iv install --codex", () => {
  it("installs a self-contained copy, marketplace entry, config and AGENTS.md pointer", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-codex-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# My rules\n\nBe brief.\n");
    installCodex({ home });
    installCodex({ home }); // idempotent

    const dir = join(home, ".codex", "plugins", "integration-verifier");
    const hooks = readFileSync(join(dir, "hooks", "hooks.json"), "utf8");
    expect(hooks).not.toContain("$PLUGIN_ROOT");
    expect(hooks).toContain(join(dir, "scripts", "iv-launch.mjs").replace(/\\/g, "/"));
    expect(json(join(dir, "mcp.json")).mcpServers["integration-verifier"].args[0]).toBe(join(dir, "scripts", "iv-launch.mjs").replace(/\\/g, "/"));
    expect(existsSync(join(dir, ".codex-plugin", "plugin.json"))).toBe(true);

    const market = json(join(home, ".agents", "plugins", "marketplace.json"));
    expect(market.plugins).toEqual([expect.objectContaining({ name: "integration-verifier", source: { source: "local", path: "./.codex/plugins/integration-verifier" } })]);

    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml.startsWith('model = "x"\n')).toBe(true);
    expect(toml.match(/\[plugins\."integration-verifier@personal"\]/g)).toHaveLength(1);

    const agents = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
    expect(agents.startsWith("# My rules\n\nBe brief.\n")).toBe(true);
    expect(agents.match(/integration-verifier:start/g)).toHaveLength(1);
    expect(existsSync(join(home, ".codex", "config.toml.iv-backup"))).toBe(true);
  });

  it("the installed hook command runs in the platform shell", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-codex-"));
    installCodex({ home });
    const cmd = json(join(home, ".codex", "plugins", "integration-verifier", "hooks", "hooks.json")).hooks.Stop[0].hooks[0].command as string;
    const r = spawnSync(cmd, { shell: true, input: JSON.stringify({ cwd: mkdtempSync(join(tmpdir(), "iv-empty-")) }), encoding: "utf8", env: { ...process.env, IV_CLI: CLI } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  }, 120_000);
});
