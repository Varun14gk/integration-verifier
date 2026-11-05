---
name: setup-integration-verifier
description: Set up or tune Integration Verifier for a project by creating .iv/config.yaml, the outbound host allowlist, extra sensitive field names, the gate severity, runtime start commands and test data, separate frontend/backend repositories, and the git pre-commit hook or GitHub Actions gate. Use when the user asks to configure Integration Verifier, when iv_check reports an invalid config, or when findings show the defaults don't fit the project.
---

# Set up Integration Verifier for a project

All settings live in `.iv/config.yaml`. Commit it; the other files in `.iv/` are generated.
Propose changes and show them to the user before writing. These are the user's policy
decisions.

## Create the config

Run `iv config init` in the project (it writes a commented template), or write the file directly.

```yaml
version: 1
sensitive:
  patterns: { health: ["diagnosis", "blood_type"] }   # extra names, added to the built-in ones
  ignore: ["token_type"]                               # names that are never sensitive
outbound:
  allowlist: ["api.stripe.com", "*.sentry.io"]         # hosts the code may call
scanner:
  engine: auto            # auto | opengrep | semgrep | none
gate:
  failOn: high            # critical | high | medium | low | info
runtime:                  # only for iv_runtime
  backend:  { command: "uvicorn app.main:app --port 8000", cwd: backend, url: "http://localhost:8000/docs" }
  frontend: { command: "npm run dev", cwd: frontend, url: "http://localhost:5173" }
  testData: .iv/testdata.yaml
dismissals: []            # written by iv_dismiss, with the user's reasons
```

Test data (`.iv/testdata.yaml`) holds **test-only** values typed into forms. Values whose names
look sensitive are watched for leaks:

```yaml
fields: { email: tester@example.com, password: "Test-Only-Pa55!" }
submitForms: false
maxPages: 20
```

## Other setups

- **Frontend and backend in separate repositories:** pass the other path in `also` to the tools
  (CLI: `--also ../backend`).
- **Projects without a coding agent:** `iv install --git-hook --root .` (pre-commit gate on
  staged content, including breaks a commit causes elsewhere), `iv install --github-action --root .`
  (CI gate with SARIF upload). `iv uninstall` with the same options removes them.
- **In git, the gate enforces the committed `.iv/config.yaml`.** Commit config changes for them to
  take effect.
- **Check the config:** `iv config validate` names the exact key and line of any mistake.
