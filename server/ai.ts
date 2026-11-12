import Anthropic from "@anthropic-ai/sdk"
import { CATEGORIES } from "./categories"
import { log } from "./otel"

// The model sees a merchant name, one description and the direction of the
// money, with account numbers, dates and amounts scrubbed out (redact), and the
// kind of account. Never an amount, a date, an account number or a balance.

export const SUGGESTIONS = [...CATEGORIES, "Transfer"] as const
export type Suggestion = (typeof SUGGESTIONS)[number]

export type Unsorted = { merchant: string; description: string; direction: "in" | "out"; account_kind: string }

/**
 * Text with anything that may name an account or a sum removed: runs of digits,
 * masks and dashes (822-1234****5678, 0000****1234), dates and amounts. A merchant
 * name keeps its words and short numbers (7-ELEVEN, 85度C).
 */
export function redact(text: string) {
  return text
    .replace(/\d{2,4}[/.-]\d{1,2}[/.-]\d{1,2}/g, " ")
    .replace(/\d{1,3}(,\d{3})+(\.\d+)?|\d+\.\d+/g, " ")
    .replace(/[\dXx*＊-]*\d[\dXx*＊ -]*[\dXx*＊]/g, run => (run.replace(/[^\d]/g, "").length >= 4 || /[*＊Xx]{2}/.test(run) ? " " : run))
    .replace(/\s+/g, " ")
    .trim()
}

const MODEL = "claude-opus-5-5"
const BATCH = 80

const SYSTEM = `You sort rows from a Taiwanese person's bank and credit card statements into spending categories.
Each row has an id, the merchant name as printed, one raw statement description, whether money came in or went out, and the kind of account.
Pick one category per row from the list and answer with the row's id. Numbers are scrubbed out. Pick "Transfer" only when the row moves the person's own money and buys nothing: between their own accounts, to a broker, a card bill payment, a cash withdrawal, or an e-wallet top-up that says so (儲值, 加值). A wallet debit such as 街口支付扣款 or LINE Pay 扣款 pays a shop through the wallet: it is spending, so pick "Other" unless the description names the shop. Pick "Other" when the row is a real expense or income you cannot place.
Use null when the description gives too little to decide, for example a bare person's name or an account number. A wrong category is worse than null.
Common bank words: 轉出 / 轉帳支出 = money sent, 轉入 = money received, 跨行 = between banks, ATM 提款 = cash withdrawal, 扣款 = automatic debit, 薪資 = salary, 利息 = interest.`

const schema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          category: { anyOf: [{ type: "string", enum: [...SUGGESTIONS] }, { type: "null" }] },
        },
        required: ["id", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
}

export function createAdvisor(apiKey: string | null) {
  if (!apiKey) return null
  const client = new Anthropic({ apiKey })

  async function batch(rows: Unsorted[]) {
    const sent = rows.map((row, id) => ({ id, merchant: redact(row.merchant), description: redact(row.description), direction: row.direction, account_kind: row.account_kind }))
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(sent) }],
    })
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      log("ai.stopped", { reason: response.stop_reason }, "WARN")
      return []
    }
    const text = response.content.find(block => block.type === "text")
    if (!text || text.type !== "text") return []
    const items = (JSON.parse(text.text) as { items: { id: number; category: Suggestion | null }[] }).items
    const out: { merchant: string; category: Suggestion }[] = []
    for (const item of items) {
      const row = rows[item.id]
      if (row && item.category && SUGGESTIONS.includes(item.category)) out.push({ merchant: row.merchant, category: item.category })
    }
    return out
  }

  /** One suggestion per merchant the model could place. */
  async function suggest(rows: Unsorted[]) {
    const out: { merchant: string; category: Suggestion }[] = []
    for (let i = 0; i < rows.length; i += BATCH) out.push(...(await batch(rows.slice(i, i + BATCH))))
    log("ai.suggested", { asked: rows.length, placed: out.length })
    return out
  }

  return { suggest }
}

export type Advisor = NonNullable<ReturnType<typeof createAdvisor>>
