# Privacy

Integration Verifier runs entirely on your machine. It has **no server, no account and no
telemetry**, and it does not send your code or findings anywhere.

## What it reads

The source code, configuration and schema files of the project you point it at, to analyse how
the frontend and backend connect and whether sensitive data leaks between them.

## What it writes

Only files under the project's `.iv/` folder (stack, map, flow, check, runtime and report files,
plus gate state and an audit log), and, when you run `iv install`, the agent configuration files
it lists before changing them. It never edits your application code.

## Network

- **None by default.** Static checks make no network requests.
- **Semgrep CE** (optional, installed by you) is run with metrics turned off (`--metrics=off`).
- **`iv runtime`** (opt-in, and every step needs your approval) starts your app and drives it in a
  local browser; the requests it sees are the ones your app makes. Optional Schemathesis sends
  generated requests to your backend only.
- **Installing** (`npm ci`, `npx playwright install`) downloads packages and a browser from their
  usual registries, as with any Node project.

## Sensitive values

Evidence shows masked values (for example `Sup3…(18 chars)`), never full secrets. Test data for
`iv runtime` should use test-only accounts; its values are masked in every report.

## Data from coding agents

When used through Claude Code, Codex or Gemini CLI, the findings are given to the agent in your
session, like any other tool output. What the agent does with them is governed by that agent's
own terms and privacy policy.

## Contact

Questions: open an issue at https://github.com/Varun14gk/integration-verifier/issues.
Security issues: see [SECURITY.md](SECURITY.md).
