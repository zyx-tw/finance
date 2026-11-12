import { useCallback, useEffect, useState, type ReactNode } from "react"
import { LogOut } from "lucide-react"
import { toast } from "sonner"
import { SectionTitle } from "@/components/section-title"
import { TaskShell } from "@/components/task-shell"
import { TaskThemeToggle } from "@/components/task-theme"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { CATEGORIES, api, money, patch, percent, post, type Card, type Recurring, type Summary, type Transaction } from "@/lib/api"
import { cn } from "@/lib/utils"

type Me = { authenticated: boolean }
type Tab = "overview" | "recurring" | "cards" | "transactions" | "inbox"

const KIND_LABEL: Record<string, string> = { deposit: "Cash", investment: "Investments", card: "Cards", loan: "Loans" }
const CATEGORY_ITEMS = CATEGORIES.map(value => ({ value, label: value }))

export function FinanceApp() {
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe, () => setMe({ authenticated: false }))
  }, [])

  // Signing out here alone would let Sign in come straight back through auth.zyx.tw,
  // so finish at auth.zyx.tw, where "Sign out" ends every service in this browser.
  async function logout() {
    await post("/api/auth/logout", {}).catch(() => {})
    window.location.assign("https://auth.zyx.tw/")
  }

  const actions = (
    <>
      <TaskThemeToggle />
      {me?.authenticated && (
        <Button type="button" variant="ghost" size="icon" className="-m-3" onClick={logout} aria-label="Sign out" title="Sign out">
          <LogOut aria-hidden />
        </Button>
      )}
    </>
  )

  return (
    <TaskShell title="Finance" actions={actions} wide>
      {me && !me.authenticated && (
        <section aria-label="Sign in" className="flex gap-3">
          <Button onClick={() => window.location.assign("/auth/start")}>Sign in</Button>
        </section>
      )}
      {me?.authenticated && <Workspace />}
    </TaskShell>
  )
}

function Workspace() {
  const [tab, setTab] = useState<Tab>("overview")
  const [month, setMonth] = useState<string | undefined>()
  const [summary, setSummary] = useState<Summary | null>(null)

  const load = useCallback(() => {
    api<Summary>(`/api/v1/summary${month ? `?month=${month}` : ""}`).then(setSummary, () => toast.error("Could not load"))
  }, [month])
  useEffect(load, [load])

  if (!summary) return null
  if (!summary.months.length) return <p className="text-body text-muted-foreground">No data</p>

  return (
    <TooltipProvider>
      <Tabs value={tab} onValueChange={value => setTab(value as Tab)}>
        <TabsList className="mb-6 max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="recurring">Recurring</TabsTrigger>
          <TabsTrigger value="cards">Cards</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="inbox">Inbox {summary.inbox > 0 && summary.inbox}</TabsTrigger>
        </TabsList>
        {tab === "overview" && <Overview summary={summary} onMonth={setMonth} />}
        {tab === "recurring" && <RecurringView />}
        {tab === "cards" && <CardsView />}
        {tab === "transactions" && <Transactions query={`month=${summary.month}`} summary={summary} onMonth={setMonth} onChange={load} />}
        {tab === "inbox" && <Transactions query="inbox=1" onChange={load} />}
      </Tabs>
    </TooltipProvider>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-title font-medium tabular-nums">{value}</dd>
      {note && <dd className="text-caption text-muted-foreground">{note}</dd>}
    </div>
  )
}

function MonthSelect({ summary, onMonth }: { summary: Summary; onMonth: (month: string) => void }) {
  const items = summary.months.map(m => ({ value: m.month, label: m.month })).reverse()
  return (
    <Select items={items} value={summary.month} onValueChange={value => value && onMonth(value)}>
      <SelectTrigger aria-label="Month" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** One bar per month, from a shared zero. The chosen month is solid; the rest step back. */
function SpendingBars({ summary, onMonth }: { summary: Summary; onMonth: (month: string) => void }) {
  const max = Math.max(...summary.months.map(m => m.spending), 1)
  return (
    <div role="group" aria-label="Spending by month" className="flex h-40 items-end gap-0.5">
      {summary.months.map(m => (
        <Tooltip key={m.month}>
          <TooltipTrigger
            render={
              <button type="button" onClick={() => onMonth(m.month)} aria-label={`${m.month} ${money(m.spending)}`} aria-pressed={m.month === summary.month} className="flex h-full min-w-0 flex-1 flex-col justify-end outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <span className={cn("block w-full rounded-t-[4px] transition-colors duration-state", m.month === summary.month ? "bg-foreground" : "bg-muted-foreground/40 hover:bg-muted-foreground")} style={{ height: `${Math.max((m.spending / max) * 100, 1)}%` }} />
              </button>
            }
          />
          <TooltipContent>{m.month} {money(m.spending)}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

function Overview({ summary, onMonth }: { summary: Summary; onMonth: (month: string) => void }) {
  const top = Math.max(...summary.categories.map(c => c.amount), 1)
  const kinds = ["deposit", "investment", "card", "loan"].filter(kind => summary.accounts.some(a => a.kind === kind))
  return (
    <div className="flex flex-col gap-12">
      <section aria-label="Net worth">
        <p className="text-caption text-muted-foreground">Net worth</p>
        <p className="text-title font-medium tabular-nums sm:text-display">{summary.net_worth === null ? "-" : money(summary.net_worth)}</p>
        <p className="mt-2 text-caption text-muted-foreground tabular-nums">Assets {money(summary.assets)}, debt {money(summary.liabilities)}</p>
      </section>

      <section aria-labelledby="month-title" className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <SectionTitle id="month-title" title="Month" />
          <MonthSelect summary={summary} onMonth={onMonth} />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Income" value={money(summary.income)} />
          <Stat label="Spending" value={money(summary.spending)} />
          <Stat label="Saved" value={money(summary.saved)} />
          <Stat label="Savings rate" value={summary.savings_rate === null ? "-" : percent(summary.savings_rate)} />
          <Stat label="Against usual" value={summary.versus_usual === null ? "-" : `${summary.versus_usual > 0 ? "+" : ""}${percent(summary.versus_usual)}`} note={summary.usual_spending === null ? undefined : `Usual ${money(summary.usual_spending)}`} />
          <Stat label="Runway" value={summary.runway_months === null ? "-" : `${summary.runway_months.toFixed(1)} mo`} />
        </dl>
        {summary.unreviewed.count > 0 && (
          <p className="text-caption text-muted-foreground tabular-nums">
            Not counted: {summary.unreviewed.count} bank rows in the inbox, {money(summary.unreviewed.inflow)} in and {money(summary.unreviewed.outflow)} out
          </p>
        )}
      </section>

      <section aria-labelledby="spending-title" className="flex flex-col gap-4">
        <SectionTitle id="spending-title" title="Spending" />
        <SpendingBars summary={summary} onMonth={onMonth} />
        <div className="flex justify-between text-caption text-muted-foreground tabular-nums">
          <span>{summary.months[0].month}</span>
          <span>{summary.months.at(-1)!.month}</span>
        </div>
      </section>

      <section aria-labelledby="categories-title" className="flex flex-col gap-4">
        <SectionTitle id="categories-title" title="Categories" />
        <Table>
          <TableBody>
            {summary.categories.map(c => (
              <TableRow key={c.category}>
                <TableCell className="w-40">{c.category}</TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span className="block h-2 rounded-r-[4px] bg-foreground" style={{ width: `${Math.max((c.amount / top) * 100, 0.5)}%` }} />
                </TableCell>
                <TableCell className="w-16 text-right text-muted-foreground tabular-nums">{c.count}</TableCell>
                <TableCell className="w-32 text-right tabular-nums">{money(c.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section aria-labelledby="accounts-title" className="flex flex-col gap-4">
        <SectionTitle id="accounts-title" title="Balance sheet" />
        <Table>
          <TableBody>
            {kinds.map(kind => (
              <Group key={kind} label={KIND_LABEL[kind]} total={summary.accounts.filter(a => a.kind === kind).reduce((sum, a) => sum + (a.balance ?? 0), 0)}>
                {summary.accounts.filter(a => a.kind === kind).map(a => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-6">{a.name}</TableCell>
                    <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">{a.balance_date}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.balance === null ? "-" : money(a.balance)}</TableCell>
                  </TableRow>
                ))}
              </Group>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}

function Group({ label, total, children }: { label: string; total: number; children: ReactNode }) {
  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{label}</TableCell>
        <TableCell className="hidden sm:table-cell" />
        <TableCell className="text-right font-medium tabular-nums">{money(total)}</TableCell>
      </TableRow>
      {children}
    </>
  )
}

function RecurringView() {
  const [data, setData] = useState<Recurring | null>(null)
  useEffect(() => {
    api<Recurring>("/api/v1/recurring").then(setData, () => toast.error("Could not load"))
  }, [])
  if (!data) return null
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-2 gap-6 sm:grid-cols-3">
        <Stat label="Each month" value={money(data.monthly_total)} />
        <Stat label="Each year" value={money(data.yearly_total)} />
        <Stat label="Active" value={String(data.items.filter(i => i.active).length)} />
      </dl>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Day</TableHead>
            <TableHead className="text-right">Next</TableHead>
            <TableHead className="hidden text-right md:table-cell">Charges</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map(item => (
            <TableRow key={`${item.merchant}-${item.day_of_month}`} className={cn(!item.active && "text-muted-foreground")}>
              <TableCell className="w-full max-w-0 truncate">{item.merchant}</TableCell>
              <TableCell className="text-right tabular-nums">{money(item.usual_amount)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{item.day_of_month}</TableCell>
              <TableCell className="text-right tabular-nums">{item.active ? item.next_date : "Ended"}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{item.charges}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function CardsView() {
  const [cards, setCards] = useState<Card[] | null>(null)
  useEffect(() => {
    api<Card[]>("/api/v1/cards").then(setCards, () => toast.error("Could not load"))
  }, [])
  if (!cards) return null
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Card</TableHead>
          <TableHead className="text-right">Last statement</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Closes</TableHead>
          <TableHead className="text-right">Next due</TableHead>
          <TableHead className="hidden text-right md:table-cell">Usually paid</TableHead>
          <TableHead className="hidden text-right md:table-cell">Average</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map(card => (
          <TableRow key={card.id}>
            <TableCell>{card.name}</TableCell>
            <TableCell className="text-right tabular-nums">{card.last_statement ? money(card.last_statement.amount_due) : "-"}</TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">{card.next_closing_date ?? "-"}</TableCell>
            <TableCell className="text-right tabular-nums">{card.next_due_date ?? "-"}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{card.payment_day === null ? "-" : `Day ${card.payment_day}`}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{card.average_statement === null ? "-" : money(card.average_statement)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Transactions({ query, summary, onMonth, onChange }: { query: string; summary?: Summary; onMonth?: (month: string) => void; onChange: () => void }) {
  const [rows, setRows] = useState<Transaction[] | null>(null)
  const load = useCallback(() => {
    api<Transaction[]>(`/api/v1/transactions?${query}`).then(setRows, () => toast.error("Could not load"))
  }, [query])
  useEffect(load, [load])

  async function change(id: number, body: { category?: string; kind?: string }) {
    try {
      const result = await patch<{ same_merchant: number }>(`/api/v1/transactions/${id}`, body)
      if (result.same_merchant) toast.success(`${result.same_merchant + 1} rows updated`)
      load()
      onChange()
    } catch {
      toast.error("Could not save")
    }
  }

  if (!rows) return null
  return (
    <div className="flex flex-col gap-6">
      {summary && onMonth && (
        <div className="flex justify-end">
          <MonthSelect summary={summary} onMonth={onMonth} />
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden w-28 sm:table-cell">Date</TableHead>
            <TableHead>Name</TableHead>
            <TableHead className="w-32 sm:w-44">Category</TableHead>
            <TableHead className="hidden w-32 text-right sm:table-cell">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">Empty</TableCell>
            </TableRow>
          )}
          {rows.map(row => (
            <TableRow key={row.id}>
              <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">{row.date}</TableCell>
              <TableCell className="w-full max-w-0" title={row.description}>
                <span className="block truncate">{row.merchant}</span>
                {/* On a phone the date and amount sit under the name. */}
                <span className="block truncate text-caption text-muted-foreground tabular-nums sm:hidden">{row.date.slice(5)} {money(row.amount)}</span>
              </TableCell>
              <TableCell>
                {row.kind === "transfer" ? (
                  <span className="text-muted-foreground">Transfer</span>
                ) : (
                  <div className="flex items-center gap-3">
                    <Select items={CATEGORY_ITEMS} value={row.category} onValueChange={value => value && change(row.id, { category: value })}>
                      <SelectTrigger aria-label={`Category for ${row.merchant}`} className="w-28 sm:w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORY_ITEMS.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {!row.category && <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => change(row.id, { kind: "transfer" })}>Transfer</Button>}
                  </div>
                )}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{money(row.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
