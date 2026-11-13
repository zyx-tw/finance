# AGENTS.md

## Layout

- `server/`: the Bun server. `app.ts` routes and checks who is asking, `auth.ts` makes sessions from auth.zyx.tw's signed token (`gate.ts` is a copy of `zyx1121/auth/client/gate.ts`; change it there), `ledger.ts` holds the import, the summary and the detection of recurring charges and card cycles, `categories.ts` the built-in category rules, `mcp.ts` the MCP tools.
- `ingest/`: statement text to an import payload, one parser per bank layout, and the CLI that posts it. `server/statements.ts` runs the same parsers on a PDF posted to `/api/v1/statements`, after qpdf and pdftotext.
- `src/`: the React app (`finance.tsx`). The shell and `components/ui` come from ui.zyx.tw; do not edit `components/ui`.
- `deploy/`: the release bundle, its smoke test, the start script, the unit hardening and the env file shape.

## Rules

- Money is an integer in cents in the database and a plain number in the API. A negative amount left the account. A card's debt is a negative balance.
- An import is safe to repeat. Never insert a transaction outside `importAll`.
- A parser reports the statement's own total beside the sum of its rows. The CLI does not post a statement whose totals differ. Add a parser only with that check.
- Real statements and their text never go in git. Tests use made-up statements.
- Nobody reviews rows. Every row counts on import: income or spending by its sign, unless it is a transfer. A bank row sent to an account number is a transfer. A row the model cannot place is Income when money came in and Other when it went out, so no row stays uncategorized.
- Two kinds of caller: a browser session from auth.zyx.tw, and the bearer token in `FINANCE_TOKEN` for importers and MCP. `/mcp` takes the token only.
- The interface is in Traditional Chinese (`lang="zh-TW"`): labels, toasts, account names and the category names shown (`CATEGORY_LABEL`). The API, MCP and the database keep the English category names. The product name stays Finance.
- The top right corner holds text links only (`cornerLink`), never icon buttons. The d key switches light and dark.
- The session cookie has no `Domain`. Sign-in happens only at auth.zyx.tw. Never widen either.
- The model's answer is filed at once (`category_source = 'model'`), after every import and at start. A category set by hand (`user`) is never overwritten, and it replaces the model's answer on the merchant's other rows. The model gets a merchant name, one description, the direction of the money and the kind of account, with numbers scrubbed out by `redact()` in `server/ai.ts`: never an amount, a date or an account number.
- Log events with `log()` from `server/otel.ts`. Send counts, never amounts, merchant names or tokens.
- Install, test and build on the build host, not on a laptop.

## Verify

```sh
bun test server ingest
bun run typecheck && bun run lint
AUDIT_TOKEN=<token> npm run audit -- <url>
```

The audit needs the token: signed out, the top right corner is empty, and the audit counts that as a missing corner.
