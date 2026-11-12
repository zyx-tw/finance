export type Account = { id: string; name: string; kind: "deposit" | "investment" | "card" | "loan"; institution: string; balance: number | null; balance_date: string | null }

export type Summary = {
  month: string | null
  net_worth: number | null
  assets: number
  liabilities: number
  income: number
  spending: number
  saved: number
  savings_rate: number | null
  usual_spending: number | null
  versus_usual: number | null
  runway_months: number | null
  inbox: number
  unreviewed: { count: number; inflow: number; outflow: number }
  months: { month: string; income: number; spending: number; net: number; net_worth: number | null }[]
  categories: { category: string; amount: number; count: number }[]
  accounts: Account[]
}

export type Transaction = {
  id: number
  account_id: string
  date: string
  amount: number
  description: string
  merchant: string
  kind: "expense" | "income" | "transfer" | "fee"
  category: string | null
  /** A model's guess, a category or "Transfer", that changes nothing until accepted. */
  suggestion: string | null
}

export type Recurring = {
  monthly_total: number
  yearly_total: number
  items: { merchant: string; category: string | null; amount: number; usual_amount: number; day_of_month: number; charges: number; last_date: string; next_date: string; active: boolean }[]
}

export type Card = {
  id: string
  name: string
  institution: string
  closing_day: number | null
  due_day: number | null
  payment_day: number | null
  last_statement: { period: string; closing_date: string; due_date: string | null; amount_due: number } | null
  next_closing_date: string | null
  next_due_date: string | null
  average_statement: number | null
}

export const CATEGORIES = ["Food", "Delivery", "Groceries", "Transport", "Shopping", "Subscriptions", "Telecom", "Travel", "Health", "Entertainment", "Education", "Housing", "Income", "Fees", "Other"]

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json")
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? String(res.status))
  return body as T
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) })
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) })

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

/** NT$12,345, with a real minus sign in front. */
export const money = (value: number) => `${value < 0 ? "−" : ""}NT$${whole.format(Math.abs(value))}`
export const percent = (value: number) => `${value < 0 ? "−" : ""}${Math.abs(Math.round(value * 100))}%`
