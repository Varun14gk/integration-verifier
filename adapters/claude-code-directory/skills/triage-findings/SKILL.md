---
name: triage-findings
description: Decide what to do with Integration Verifier findings when the gate blocks finishing, a pre-commit hook or CI fails, or a report lists open findings, including fixing, explaining false positives and recording user-approved dismissals. Use when a hook says "Integration Verifier gate", when iv_check reports blocking findings, or when the user asks to accept or dismiss a finding.
---

> **Directory edition.** In this edition the Integration Verifier tools are commands of the
> `iv` CLI, which the user installs with `npm install -g integration-verifier`. Run them
> in the project's terminal; read the output and the files they write under `.iv/`. If `iv` is not
> installed, tell the user how to install it (https://github.com/Varun14gk/integration-verifier) instead of guessing results.
>
> | Tool named below | Command |
> |---|---|
> | `iv_detect` | `iv detect --root <project>` |
> | `iv_map` | `iv map --root <project>` |
> | `iv_flow` | `iv flow --root <project>` |
> | `iv_check` | `iv check --root <project>` (add --files <changed files> for a quick check) |
> | `iv_report` | `iv report --root <project>` |
> | `iv_runtime_plan` | `iv runtime --root <project> --plan` |
> | `iv_runtime` | `iv runtime --root <project> --yes` (only after the user approved every listed step) |
> | `iv_dismiss` | `iv dismiss <finding-id> --reason "<the user's reason>" --root <project>` |
>
> There is no automatic gate in this edition: run `iv check` yourself after changing API
> calls, routes or models, and before finishing.

# Triage findings

## Order of work

1. Sort by severity (critical, high, medium, low, info) and fix the real problems first.
   Integration breaks and leaks of credentials or payment data come first.
2. For each finding, read the evidence and decide:
   - **Real problem:** fix it the way the codebase already does things, then confirm with
     `iv_check` on the changed `files`.
   - **Probably acceptable** (an orphan route used by a mobile app, a known outbound host, a
     test key): **explain to the user why**, and ask whether they accept it.
   - **False positive:** explain why, with the evidence line. Suggest a config change where it
     fits (`sensitive.ignore`, `outbound.allowlist`), and let the user decide.
3. **Only when the user explicitly accepts a finding**, call `iv_dismiss` with the finding id and
   **the user's reason in their words**. Never dismiss to get past the gate, and never invent a
   reason.

## The gate

- Before you finish, a hook runs the full check. While findings at or above `gate.failOn`
  (default `high`) are open, it asks you to continue.
- It keeps asking while the same findings are open (up to the project's limit, then the
  override is recorded). Don't try to wait it out: if you've done what you can, tell the user clearly which
  findings remain and why, rather than looping.
- Lowering the gate (`gate.failOn`) is the user's decision, not yours. Files in `.iv/` are the
  user's: editing them is refused, and in git the gate only honours the committed config.

## Reports

`iv_report` writes `.iv/report.md` for people and `.iv/report.sarif` for code scanning.
Dismissed findings stay listed with their reason.
