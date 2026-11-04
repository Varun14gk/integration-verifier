---
name: runtime-verification
description: Confirm integration and leak findings against the running application by starting it and driving it with Playwright (existing tests or a crawl), then comparing real traffic with the static map. Use when static analysis says unverifiable, when the user wants proof against the live app, or to catch problems only visible at runtime such as values in server logs, the console or browser storage. Always requires the user's approval for each step.
---

# Runtime verification

This starts processes and a browser on the user's machine, so **every step needs the user's
approval**.

## Steps

1. Check `.iv/config.yaml` has a `runtime` section (backend and frontend `command`, `cwd`,
   `url`, and optionally `testData`). If not, help the user write it; see the
   `setup-integration-verifier` skill.
2. Call `iv_runtime_plan` and **show the user the numbered steps exactly as returned**: starting
   the backend and frontend, opening the browser, submitting forms, running their Playwright
   tests, Schemathesis.
3. Ask which steps they allow. Never assume "yes", never reuse an approval from an earlier
   run, and never add steps the user didn't approve.
4. Call `iv_runtime` with `approvedSteps` set to exactly the ids the user approved.
5. Report:
   - edges **confirmed**
   - **unmapped** requests and **failed** calls (4xx/5xx)
   - **schema violations** (responses missing declared fields)
   - **sensitive values observed** in URLs, the console, storage, cookies or server output

## Notes

- `submit-forms` sends data to the app. Mention that it may create records.
- Test values are masked in all output; never ask the user to share real credentials. Test data
  should be test-only accounts.
- If a step fails (a port in use, the app not starting), report the note from the result; don't
  retry with different commands on your own.
