---
name: verify-integration
description: Check that frontend calls reach the right backend routes with matching method, path params, query params, request body and response fields. Use after adding or changing an API call, a route, a controller, a request/response model, a base URL, a proxy or a rewrite; when a call returns 404, 405, 400 or unexpected data; or before finishing work that touches both frontend and backend.
---

# Verify frontend-backend integration

## Steps

1. Run `iv_map` with `root` set to the project directory. For a quick pass over what you just
   changed, `iv_check` with `files` is faster.
2. Read the summary: `connected`, `not connected`, `mismatched`, `unverifiable`, `orphan`.
3. Handle each problem by kind:

| Kind | What it means | What to do |
|---|---|---|
| **not connected** | The frontend calls a route the backend doesn't expose | Look at the top suggestion and its reason (path similarity, method, field overlap). Decide which side is wrong. A typo or singular/plural slip on the frontend is common; a missing route may mean the backend work isn't done |
| **mismatched: method** | Same path, different method (e.g. PUT vs PATCH) | Use the method the backend exposes, unless the backend is wrong |
| **mismatched: path params** | The route needs more or fewer `{params}` than the URL has | Fill in the missing segment, or fix the route |
| **mismatched: query** | Required query params missing, or unknown ones sent | Rename to what the backend reads (e.g. `page` → `pageNumber`) |
| **mismatched: request field** | The body is missing a required field, or sends one the backend doesn't accept | Follow the "did you mean" hint; check the backend model at the evidence line |
| **mismatched: response field** | The UI reads a field the backend never returns | Fix the frontend type, or add the field to the backend response |
| **not connected (at a rewrite or proxy)** | A proxy or rewrite changes the path so nothing matches | Fix the rewrite (the suggestion gives the corrected `destination`), not each call |
| **unverifiable** | The URL is built at runtime | Prefer literal paths per endpoint; otherwise confirm with `iv_runtime` |
| **orphan** | A backend route no frontend calls | Often fine (mobile apps, webhooks, health checks). Mention it; don't delete routes on your own |

4. After fixing, run `iv_check` with `files` on what you changed and confirm the finding is gone.

## Notes

- Separate repositories: pass the other repo's path in `also` (e.g. `also: ["../backend"]`).
- If `iv_detect` reports a frontend or backend as **unsupported**, say so to the user. Don't
  assume it is fine. An OpenAPI/Swagger file, a GraphQL schema (`.graphql`) or `.proto` files
  in the project still let the map check it, whatever its language.
- GraphQL operations (`gql` templates, `.graphql` files) are validated against the schema;
  errors include the schema's own "Did you mean" hint.
