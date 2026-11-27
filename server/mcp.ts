import { CATEGORIES } from "./categories"
import { HttpError, json, readJson } from "./http"
import type { Ledger } from "./ledger"
import { log } from "./otel"

// MCP over streamable HTTP, without sessions or streams: each POST carries one
// JSON-RPC message and gets one JSON answer.

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (args: Record<string, unknown>) => unknown }

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false })
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined)

export function createMcp(ledger: Ledger) {
  const month = { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "A month as YYYY-MM. Default: the latest month with data." }
  const period = { type: "string", pattern: "^\\d{4}(-\\d{2})?$", description: "A month as YYYY-MM, or a whole year as YYYY. Default: the latest month with data." }
  const tools: Tool[] = [
    {
      name: "get_summary",
      description: "Net worth, the period's income, spending, savings rate, runway in months, spending against the usual month, spending by category, income by source, and every month's totals. The period is a month or a whole year. Amounts are in TWD.",
      inputSchema: object({ month: period }),
      run: args => ledger.summary(str(args.month)),
    },
    {
      name: "list_accounts",
      description: "Every account with its kind (deposit, investment, card, loan) and latest balance. A card's debt is a negative balance.",
      inputSchema: object(),
      run: () => ledger.accounts(),
    },
    {
      name: "list_transactions",
      description: "Transactions, newest first. A negative amount left the account. Filter by month, account id, category or a search text; inbox=true lists rows that still have no category.",
      inputSchema: object({ month, account: { type: "string" }, category: { type: "string", enum: [...CATEGORIES] }, q: { type: "string" }, inbox: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 2000 } }),
      run: args => ledger.transactions({ month: str(args.month), account: str(args.account), category: str(args.category), q: str(args.q), inbox: args.inbox === true, limit: typeof args.limit === "number" ? args.limit : 200 }),
    },
    {
      name: "get_recurring",
      description: "Subscriptions and other charges that come back about monthly: merchant, usual amount, day of month, next expected date, and whether it is still active. Includes the monthly and yearly total.",
      inputSchema: object(),
      run: () => ledger.recurring(),
    },
    {
      name: "get_cards",
      description: "Each credit card's cycle: statement closing day, payment due day, the day payments usually arrive, the last statement and the next closing and due dates.",
      inputSchema: object(),
      run: () => ledger.cards(),
    },
    {
      name: "set_category",
      description: "Set one transaction's category, or mark it as a transfer between own accounts with kind=transfer. The merchant's other rows that nobody set by hand follow the category.",
      inputSchema: object({ id: { type: "integer" }, category: { type: "string", enum: [...CATEGORIES] }, kind: { type: "string", enum: ["expense", "income", "transfer", "fee"] } }, ["id"]),
      run: args => ledger.setCategory(Number(args.id), { category: args.category, kind: args.kind }),
    },
    {
      name: "import",
      description:
        "Add accounts, balances, card statements and transactions in one call. Safe to repeat: a transaction already stored is skipped. Amounts are TWD numbers; a purchase or withdrawal is negative, a deposit or card payment positive; a card's debt is a negative balance. Dates are YYYY-MM-DD.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Where this came from, for example cathay-card-2026-10." },
          accounts: { type: "array", items: object({ id: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["deposit", "investment", "card", "loan"] }, institution: { type: "string" } }, ["id", "name", "kind"]) },
          balances: { type: "array", items: object({ account: { type: "string" }, date: { type: "string" }, amount: { type: "number" } }, ["account", "date", "amount"]) },
          statements: { type: "array", items: object({ account: { type: "string" }, period: { type: "string" }, closing_date: { type: "string" }, due_date: { type: "string" }, amount_due: { type: "number" } }, ["account", "period", "closing_date", "amount_due"]) },
          transactions: {
            type: "array",
            items: object({ account: { type: "string" }, date: { type: "string" }, posted_date: { type: "string" }, amount: { type: "number" }, description: { type: "string" }, external_id: { type: "string" }, kind: { type: "string", enum: ["expense", "income", "transfer", "fee"] } }, ["account", "date", "amount", "description"]),
          },
        },
      },
      run: args => ledger.importAll(args),
    },
  ]

  const answer = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result })
  const fail = (id: unknown, code: number, message: string) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
    const message = await readJson(req)
    const { id, method } = message
    const params = (message.params ?? {}) as Record<string, unknown>
    // A notification has no id and gets no body.
    if (id === undefined) return new Response(null, { status: 202 })
    if (method === "initialize") {
      const asked = str(params.protocolVersion)
      return answer(id, { protocolVersion: asked && VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "finance", version: "1" } })
    }
    if (method === "ping") return answer(id, {})
    if (method === "tools/list") return answer(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    if (method === "tools/call") {
      const tool = tools.find(t => t.name === params.name)
      if (!tool) return fail(id, -32602, "unknown tool")
      try {
        const result = tool.run((params.arguments ?? {}) as Record<string, unknown>)
        log("mcp.call", { tool: tool.name })
        return answer(id, { content: [{ type: "text", text: JSON.stringify(result) }] })
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        return answer(id, { content: [{ type: "text", text: error.message || String(error.status) }], isError: true })
      }
    }
    return fail(id, -32601, "method not found")
  }

  return { handle }
}
