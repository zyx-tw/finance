// bun ingest/cli.ts [--post <origin>] <statement.txt>...
// Parses statement text and prints one line per file. With --post it sends
// each payload to <origin>/api/v1/import with FINANCE_TOKEN. Amounts and
// merchant names never reach the output, only counts and the total check.
import { readFileSync } from "node:fs"
import { checked, parse } from "./parsers"

const args = process.argv.slice(2)
const at = args.indexOf("--post")
const origin = at >= 0 ? args.splice(at, 2)[1] : null
const token = process.env.FINANCE_TOKEN
if (origin && !token) throw new Error("FINANCE_TOKEN is not set")

let failed = 0
for (const file of args) {
  const parsed = parse(readFileSync(file, "utf8"))
  const name = file.split("/").pop()
  if (!parsed) {
    console.log(`${name}: no parser knows this layout`)
    failed++
    continue
  }
  const { payload, check } = parsed
  // A statement whose own total was not found is not checked, so it is not sent.
  const ok = checked(check)
  if (!ok) failed++
  let sent = ""
  if (origin && ok) {
    const res = await fetch(`${origin}/api/v1/import`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) })
    const body = (await res.json()) as Record<string, number>
    sent = res.ok ? ` | inserted ${body.inserted}, duplicates ${body.duplicates}, transfers ${body.transfers}` : ` | import failed ${res.status} ${JSON.stringify(body)}`
    if (!res.ok) failed++
  }
  console.log(`${name}: ${parsed.parser}, ${payload.transactions.length} rows, ${check ? `${check.label} ${ok ? "match" : "DO NOT MATCH"}` : "no total to check, not sent"}${sent}`)
}
process.exit(failed ? 1 : 0)
