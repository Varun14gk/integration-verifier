# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private
vulnerability reporting instead: **Security → Report a vulnerability** on
https://github.com/Varun14gk/integration-verifier. We aim to reply within 5 working days.

Useful details: the version (`iv --version`), the agent (Claude Code, Codex, Gemini CLI, git
hook or CI), and the smallest project or input that shows the problem.

## Scope

In scope: anything that lets the gate be bypassed without the user's decision, findings that
expose secret values, writes outside `.iv/` or the files `iv install` lists, command injection
through hook input, configuration or the GitHub Action, and the runtime verifier acting without
approval.

## Supported versions

Only the latest release on `main` receives fixes during the 0.x series.
