// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { VERSION } from "@integration-verifier/core";
import { readZip } from "@integration-verifier/runtime";
// @ts-expect-error: plain ES module script without type declarations
import { directoryFiles, zip } from "../../scripts/package-codex-directory.mjs";

describe("Codex directory edition (the ZIP for OpenAI's portal)", () => {
  const files = directoryFiles() as Map<string, string>;

  it("has no lifecycle hooks and no MCP server, which the portal rejects", () => {
    expect([...files.keys()].some((f) => f.startsWith("hooks/") || /mcp\.json$/.test(f) || f.startsWith("scripts/"))).toBe(false);
    const m = JSON.parse(files.get(".codex-plugin/plugin.json")!);
    expect(m.hooks).toBeUndefined();
    expect(m.mcpServers).toBeUndefined();
    expect(m.extensions).toEqual({ "com.openai": { requires_local_executor: true } });
    expect(m.version).toBe(VERSION);
    expect(m.interface.logo).toBe("./assets/icon.svg");
    expect(files.has("assets/icon.svg")).toBe(true);
  });

  it("every skill explains that the tools are iv CLI commands here", () => {
    const skills = [...files.keys()].filter((f) => f.endsWith("SKILL.md"));
    expect(skills).toHaveLength(6);
    for (const s of skills) {
      const text = files.get(s)!;
      expect(text, s).toMatch(/^---\nname: [a-z-]+\ndescription: .+\n---\n\n> \*\*Directory edition\.\*\*/);
      expect(text, s).toContain("`iv check --root <project>`");
    }
  });

  it("builds a readable, reproducible ZIP", () => {
    const a = zip(files) as Buffer;
    expect(Buffer.compare(a, zip(files) as Buffer)).toBe(0);
    const back = readZip(a);
    expect([...back.keys()].sort()).toEqual([...files.keys()].sort());
    expect(back.get("skills/verify-integration/SKILL.md")!.toString("utf8")).toBe(files.get("skills/verify-integration/SKILL.md"));
  });
});
