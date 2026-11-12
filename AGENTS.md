# AGENTS.md

## Layout

- `server/`: the Bun server. `app.ts` routes and checks who is asking, `auth.ts` makes sessions from auth.zyx.tw's signed token (`gate.ts` is a copy of `zyx1121/auth/client/gate.ts`; change it there), `ledger.ts` holds the import, the summary and the detection of recurring charges and card cycles, `categories.ts` the built-in category rules, `mcp.ts` the MCP tools.
- `ingest/`: statement text to an import payload, one parser per bank layout, and the CLI that posts it.
- `src/`: the React app (`finance.tsx`). The shell and `components/ui` come from ui.zyx.tw; do not edit `components/ui`.
- `deploy/`: the release bundle, its smoke test, the start script, the unit hardening and the env file shape.

## Rules

- Money is an integer in cents in the database and a plain number in the API. A negative amount left the account. A card's debt is a negative balance.
- An import is safe to repeat. Never insert a transaction outside `importAll`.
- A parser reports the statement's own total beside the sum of its rows. The CLI does not post a statement whose totals differ. Add a parser only with that check.
- Real statements and their text never go in git. Tests use made-up statements.
- A bank row with no category stays out of income and spending until someone reviews it. A card row always counts.
- Two kinds of caller: a browser session from auth.zyx.tw, and the bearer token in `FINANCE_TOKEN` for importers and MCP. `/mcp` takes the token only.
- The top right corner holds text links only (`cornerLink`), never icon buttons. The d key switches light and dark.
- The session cookie has no `Domain`. Sign-in happens only at auth.zyx.tw. Never widen either.
- A model's guess goes in `suggestion` and changes no number until a person accepts it. The model gets a merchant name, one description and the direction of the money, never an amount, a date or an account.
- Log events with `log()` from `server/otel.ts`. Send counts, never amounts, merchant names or tokens.
- Install, test and build on the build host, not on a laptop.

## Verify

```sh
bun test server ingest
bun run typecheck && bun run lint
AUDIT_TOKEN=<token> npm run audit -- <url>
```

The audit needs the token: signed out, the top right corner is empty, and the audit counts that as a missing corner.
