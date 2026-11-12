import Anthropic from "@anthropic-ai/sdk"
import { CATEGORIES } from "./categories"
import { log } from "./otel"

// The model sees a merchant name, one raw description and the direction of the
// money. Never an amount, a date, an account or a balance.

export const SUGGESTIONS = [...CATEGORIES, "Transfer"] as const
export type Suggestion = (typeof SUGGESTIONS)[number]

export type Unsorted = { merchant: string; description: string; direction: "in" | "out"; account_kind: string }

const MODEL = "claude-opus-5-5"
const BATCH = 80

const SYSTEM = `You sort rows from a Taiwanese person's bank and credit card statements into spending categories.
Each row has the merchant name as printed, one raw statement description, whether money came in or went out, and the kind of account.
Pick one category per merchant from the list. Pick "Transfer" when the row most likely moves the person's own money: between their own accounts, to a broker, to an e-wallet top-up (街口, LINE Pay, 全支付 top-ups), a card bill payment, or a cash withdrawal. Pick "Other" when the row is a real expense or income you cannot place.
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
          merchant: { type: "string" },
          category: { anyOf: [{ type: "string", enum: [...SUGGESTIONS] }, { type: "null" }] },
        },
        required: ["merchant", "category"],
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
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(rows) }],
    })
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      log("ai.stopped", { reason: response.stop_reason }, "WARN")
      return []
    }
    const text = response.content.find(block => block.type === "text")
    if (!text || text.type !== "text") return []
    const known = new Set(rows.map(r => r.merchant))
    const items = (JSON.parse(text.text) as { items: { merchant: string; category: Suggestion | null }[] }).items
    return items.filter(item => known.has(item.merchant) && item.category && SUGGESTIONS.includes(item.category)) as { merchant: string; category: Suggestion }[]
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
