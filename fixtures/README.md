# Fixtures

Small sample apps with **deliberately broken integrations and planted leaks**. They are
test inputs, not examples: do not copy code from them.

| Fixture | Frontend | Backend |
|---|---|---|
| `react-fastapi` | React + Vite + axios | FastAPI + Pydantic |
| `angular-spring` | Angular HttpClient | Spring Boot |
| `nextjs-express` | Next.js (fetch, rewrites) | Express + zod |

Each fixture has an `expected.json`:

- `stack`: what `iv detect` should find (PR 2).
- `connected`: edges `iv map` should mark as connected (PR 3).
- `planted`: every planted problem, with category, severity, phase, file, line and the
  expected suggestion where there is one.
- `mustNotReport`: places that look suspicious but are fine. Reporting them is a false positive.

The secrets in these fixtures are fake.
