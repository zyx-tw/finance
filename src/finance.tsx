import { useCallback, useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { MonthFlow, WorthLine } from "@/charts"
import { Ascii, textField } from "@/components/ascii"
import { BlockColumns, BrailleChart, Meter } from "@/components/glyph-chart"
import { cornerLink } from "@/components/corners"
import { SectionTitle } from "@/components/section-title"
import { TaskShell } from "@/components/task-shell"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CATEGORIES, api, money, patch, post, type Card, type Recurring, type Summary, type Transaction } from "@/lib/api"
import { cn } from "@/lib/utils"

type Me = { authenticated: boolean }
type Tab = "overview" | "transactions" | "recurring"

const KIND_LABEL: Record<string, string> = { deposit: "現金", investment: "投資", card: "信用卡", loan: "貸款" }
// The interface is in Traditional Chinese; the API and the database keep the English category names.
const CATEGORY_LABEL: Record<string, string> = {
  Food: "餐飲", Delivery: "外送", Groceries: "生活採買", Transport: "交通", Shopping: "購物", Subscriptions: "訂閱", Telecom: "電信", Travel: "旅遊",
  Health: "醫療", Entertainment: "娛樂", Education: "教育", Housing: "居住", Income: "收入", Fees: "手續費", Other: "其他", Transfer: "轉帳", Uncategorized: "未分類",
}
// A row is one of the categories, or a transfer between own accounts, which is no cost and no income.
const CATEGORY_ITEMS = [...CATEGORIES, "Transfer"].map(value => ({ value, label: CATEGORY_LABEL[value] }))

// The sign-in screen's word, drawn in characters that glow in the dark theme.
const WORDMARK = textField("FINANCE")

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

  // The top right corner is text, as every corner is. The d key switches light and dark.
  const actions = me?.authenticated && (
    <button type="button" onClick={logout} className={cornerLink}>
      登出
    </button>
  )

  return (
    <TaskShell title="Finance" actions={actions} wide center={!me?.authenticated} hideTitle={!me?.authenticated} lang="zh-TW">
      {me && !me.authenticated && (
        <section aria-label="登入" className="flex w-full max-w-xl flex-col items-center gap-6">
          <Ascii aria-hidden="true" source={WORDMARK} look="classic" cell={7} effects={{ bloom: 1.2, scanlines: true }} className="block h-40 w-full" />
          <Button onClick={() => window.location.assign("/auth/start")}>登入</Button>
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
    api<Summary>(`/api/v1/summary${month ? `?month=${month}` : ""}`).then(setSummary, () => toast.error("載入失敗"))
  }, [month])
  useEffect(load, [load])

  if (!summary) return null
  if (!summary.months.length) return <p className="text-body text-muted-foreground">沒有資料</p>

  return (
    <TooltipProvider>
      <Tabs value={tab} onValueChange={value => setTab(value as Tab)}>
        <TabsList className="mb-6 max-w-full overflow-x-auto">
          <TabsTrigger value="overview">總覽</TabsTrigger>
          <TabsTrigger value="transactions">交易</TabsTrigger>
          <TabsTrigger value="recurring">定期扣款</TabsTrigger>
        </TabsList>
        {tab === "overview" && <Overview summary={summary} onMonth={setMonth} />}
        {tab === "recurring" && <RecurringView />}
        {tab === "transactions" && <Transactions summary={summary} onMonth={setMonth} onChange={load} />}
      </Tabs>
    </TooltipProvider>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "low" | "high" }) {
  return (
    <div>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className={cn("text-title font-medium tabular-nums", tone === "low" && "text-data-low", tone === "high" && "text-data-high")}>{value}</dd>
    </div>
  )
}

function MonthSelect({ summary, onMonth }: { summary: Summary; onMonth: (month: string) => void }) {
  // A whole year sits above its months, so the flow can show the year at once.
  const years = [...new Set(summary.months.map(m => m.month.slice(0, 4)))].reverse()
  const items = years.flatMap(y => [{ value: y, label: `${y} 全年` }, ...summary.months.filter(m => m.month.startsWith(`${y}-`)).map(m => ({ value: m.month, label: m.month })).reverse()])
  return (
    <Select items={items} value={summary.month} onValueChange={value => value && onMonth(value)}>
      <SelectTrigger aria-label="月份" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** A month is in the chosen period when it is that month or a month of that year. */
const inPeriod = (month: string, period: string | null) => month === period || (period?.length === 4 && month.startsWith(`${period}-`))

/** One column per month, from a shared zero, shaded by how much went out. The chosen period is solid; the rest step back. */
function SpendingBars({ summary, onMonth }: { summary: Summary; onMonth: (month: string) => void }) {
  return (
    <BlockColumns
      aria-label="每月支出"
      role="group"
      values={summary.months.map(m => m.spending)}
      labels={summary.months.map(m => `${m.month} ${money(m.spending)}`)}
      rows={7}
      tone="heat"
      selected={i => inPeriod(summary.months[i].month, summary.month)}
      onSelect={i => onMonth(summary.months[i].month)}
    />
  )
}

function Overview({ summary, onMonth }: { summary: Summary; onMonth: (month: string) => void }) {
  const top = Math.max(...summary.categories.map(c => c.amount), 1)
  const worth = summary.months.flatMap(m => (m.net_worth === null ? [] : [m.net_worth]))
  const kinds = ["deposit", "investment", "card", "loan"].filter(kind => summary.accounts.some(a => a.kind === kind))
  return (
    <div className="flex flex-col gap-12">
      {PREVIEW && <Candidates summary={summary} onMonth={onMonth} />}
      <section aria-label="淨資產">
        <p className="text-caption text-muted-foreground">淨資產</p>
        <p className="text-title font-medium tabular-nums sm:text-display">{summary.net_worth === null ? "-" : money(summary.net_worth)}</p>
        <p className="mt-2 text-caption text-muted-foreground tabular-nums">資產 {money(summary.assets)}，負債 {money(summary.liabilities)}</p>
        {worth.length > 1 && <BrailleChart aria-label="淨資產走勢" values={worth} rows={3} variant="area" className="mt-6 text-muted-foreground" />}
      </section>

      <section aria-labelledby="month-title" className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <SectionTitle id="month-title" title={summary.month?.length === 4 ? "全年" : "本月"} />
          <MonthSelect summary={summary} onMonth={onMonth} />
        </div>
        {/* 2 columns on a phone: a 6 digit amount in the title size is wider than a third of the row. */}
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-3">
          <Stat label="收入" value={money(summary.income)} />
          <Stat label="支出" value={money(summary.spending)} />
          <Stat label="結餘" value={money(summary.saved)} tone={summary.saved < 0 ? "high" : "low"} />
        </dl>
      </section>

      <section aria-labelledby="spending-title" className="flex flex-col gap-4">
        <SectionTitle id="spending-title" title="支出" />
        <SpendingBars summary={summary} onMonth={onMonth} />
        <div className="flex justify-between text-caption text-muted-foreground tabular-nums">
          <span>{summary.months[0].month}</span>
          <span>{summary.months.at(-1)!.month}</span>
        </div>
      </section>

      <section aria-labelledby="categories-title" className="flex flex-col gap-4">
        <SectionTitle id="categories-title" title="分類" />
        <Table>
          <TableBody>
            {summary.categories.map(c => (
              <TableRow key={c.category}>
                <TableCell className="w-40">{CATEGORY_LABEL[c.category] ?? c.category}</TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Meter value={c.amount / top} tone="heat" />
                </TableCell>
                <TableCell className="w-16 text-right text-muted-foreground tabular-nums">{c.count}</TableCell>
                <TableCell className="w-32 text-right tabular-nums">{money(c.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section aria-labelledby="accounts-title" className="flex flex-col gap-4">
        <SectionTitle id="accounts-title" title="資產負債" />
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

// finance.zyx.tw/?preview shows the 2 candidates for the main chart above the overview.
const PREVIEW = new URLSearchParams(window.location.search).has("preview")

function Candidates({ summary, onMonth }: { summary: Summary; onMonth: (month: string) => void }) {
  return (
    <>
      <section aria-labelledby="flow-title" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <SectionTitle id="flow-title" title="A 收支流向" />
          <MonthSelect summary={summary} onMonth={onMonth} />
        </div>
        <MonthFlow summary={summary} label={category => CATEGORY_LABEL[category] ?? category} />
      </section>
      <section aria-labelledby="worth-title" className="flex flex-col gap-4">
        <SectionTitle id="worth-title" title="B 淨資產走勢" />
        <WorthLine summary={summary} />
      </section>
    </>
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
    api<Recurring>("/api/v1/recurring").then(setData, () => toast.error("載入失敗"))
  }, [])
  if (!data) return null
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-2 gap-6 sm:grid-cols-3">
        <Stat label="每月" value={money(data.monthly_total)} />
        <Stat label="每年" value={money(data.yearly_total)} />
      </dl>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名稱</TableHead>
            <TableHead className="text-right">金額</TableHead>
            <TableHead className="hidden text-right sm:table-cell">扣款日</TableHead>
            <TableHead className="text-right">下次</TableHead>
            <TableHead className="hidden text-right md:table-cell">次數</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map(item => (
            <TableRow key={`${item.merchant}-${item.day_of_month}`} className={cn(!item.active && "text-muted-foreground")}>
              <TableCell className="w-full max-w-0 truncate">{item.merchant}</TableCell>
              <TableCell className="text-right tabular-nums">{money(item.usual_amount)}</TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{item.day_of_month}</TableCell>
              <TableCell className="text-right tabular-nums">{item.active ? item.next_date : "已停止"}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{item.charges}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <CardsView />
    </div>
  )
}

function CardsView() {
  const [cards, setCards] = useState<Card[] | null>(null)
  useEffect(() => {
    api<Card[]>("/api/v1/cards").then(setCards, () => toast.error("載入失敗"))
  }, [])
  if (!cards?.length) return null
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>信用卡</TableHead>
          <TableHead className="text-right">上期帳單</TableHead>
          <TableHead className="hidden text-right sm:table-cell">結帳日</TableHead>
          <TableHead className="text-right">繳款截止</TableHead>
          <TableHead className="hidden text-right md:table-cell">通常繳款日</TableHead>
          <TableHead className="hidden text-right md:table-cell">平均</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map(card => (
          <TableRow key={card.id}>
            <TableCell>{card.name}</TableCell>
            <TableCell className="text-right tabular-nums">{card.last_statement ? money(card.last_statement.amount_due) : "-"}</TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">{card.next_closing_date ?? "-"}</TableCell>
            <TableCell className="text-right tabular-nums">{card.next_due_date ?? "-"}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{card.payment_day === null ? "-" : `${card.payment_day} 日`}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{card.average_statement === null ? "-" : money(card.average_statement)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Transactions({ summary, onMonth, onChange }: { summary: Summary; onMonth: (month: string) => void; onChange: () => void }) {
  const [rows, setRows] = useState<Transaction[] | null>(null)
  const load = useCallback(() => {
    api<Transaction[]>(`/api/v1/transactions?month=${summary.month}`).then(setRows, () => toast.error("載入失敗"))
  }, [summary.month])
  useEffect(load, [load])

  async function change(id: number, value: string) {
    try {
      const result = await patch<{ same_merchant: number }>(`/api/v1/transactions/${id}`, value === "Transfer" ? { kind: "transfer" } : { category: value })
      if (result.same_merchant) toast.success(`已更新 ${result.same_merchant + 1} 筆`)
      load()
      onChange()
    } catch {
      toast.error("儲存失敗")
    }
  }

  if (!rows) return null
  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <MonthSelect summary={summary} onMonth={onMonth} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden w-28 sm:table-cell">日期</TableHead>
            <TableHead>名稱</TableHead>
            <TableHead className="w-32 sm:w-44">分類</TableHead>
            <TableHead className="hidden w-32 text-right sm:table-cell">金額</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">沒有交易</TableCell>
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
                <Select items={CATEGORY_ITEMS} value={row.kind === "transfer" ? "Transfer" : row.category} onValueChange={value => value && change(row.id, value)}>
                  <SelectTrigger aria-label={`${row.merchant} 的分類`} className={cn("w-28 sm:w-40", row.kind === "transfer" && "text-muted-foreground")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_ITEMS.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="hidden text-right tabular-nums sm:table-cell">{money(row.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
