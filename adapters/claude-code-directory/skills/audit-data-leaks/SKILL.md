---
name: audit-data-leaks
description: Find sensitive data leaking across the frontend-backend boundary, such as passwords, tokens, keys, emails, phone numbers, national IDs or payment data in API responses, logs, URLs, browser storage, cookies, error messages or calls to unknown hosts, and hardcoded secrets or routes without input validation. Use when working on authentication, user or payment data, logging, error handling, config or secrets, or when the user asks for a security or privacy review.
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

# Audit data leaks

## Steps

1. Run `iv_check` with `root` set to the project directory. If it lists checks as
   **skipped**, no pattern engine is installed: tell the user that `pip install semgrep`
   enables them.
2. Run `iv_flow` to see where each sensitive field travels.
3. Handle each finding by category:

| Category | Typical fix |
|---|---|
| `over-exposure` | Remove the field from the response model, for example with a separate public DTO. Don't just hide it in the UI |
| `sensitive-in-logs` | Remove the value from the log line or mask it. Keep the event, drop the secret |
| `sensitive-in-url` | Move the value to the request body (POST) or a header |
| `sensitive-in-client-storage` | Use an httpOnly, Secure, SameSite cookie set by the server instead of local/sessionStorage |
| `insecure-cookie` | Add HttpOnly, Secure and SameSite |
| `sensitive-in-error` | Return a generic message and an error id; log details server-side without the value |
| `hardcoded-secret` | Read it from the environment or a secret manager. **Tell the user the value must be rotated**, because it is already in git history |
| `outbound-not-allowlisted` | If the host is expected, the **user** adds it to `outbound.allowlist` in `.iv/config.yaml`; otherwise remove the call |
| `missing-validation` | Add the framework's validation (schema, model, `@Valid`, validator) before the input is used |
| `missing-logging` | Add request logging or tracing middleware; never log sensitive fields |

## Rules

- Evidence never shows secret values in full; don't print them yourself either.
- Field sensitivity comes from names and patterns in `.iv/config.yaml`. If a field is wrongly
  flagged (for example `token_type`), suggest adding it to `sensitive.ignore`; don't dismiss it.
