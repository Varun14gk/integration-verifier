# Integration Verifier

This workspace can be checked by Integration Verifier (MCP server `integration-verifier`, skill
`integration-verifier`). After changing API calls, routes or request/response models, run
`iv_check` with the project directory as `root` (add `files` for a quick check). It reports;
you decide what to change. Ask the user before any `iv_runtime` step, and never dismiss a
finding unless the user gives a reason.
