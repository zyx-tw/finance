import { money, type Summary } from "@/lib/api"

type Node = { label: string; amount: number }
type Placed = Node & { y: number; h: number }

const W = 800
const SPAN = 320
const GAP = 10
const BAR = 10
const LEFT = 150
const RIGHT = W - 170
const MID = (LEFT + RIGHT) / 2

/**
 * Keeps the largest n and folds the rest into one node, so a column stays
 * readable. A node under 3% of the month is folded too: its label would not fit.
 */
function top(nodes: Node[], n: number, rest: string, total: number) {
  const sorted = nodes.filter(x => x.amount > 0).sort((a, b) => b.amount - a.amount)
  const keep = sorted.slice(0, n - 1).filter(x => x.amount >= total * 0.03)
  const tail = sorted.slice(keep.length).reduce((sum, x) => sum + x.amount, 0)
  return tail > 0 ? [...keep, { label: rest, amount: tail }] : keep
}

/** Stacks a column from the top; a thin node still takes room for its label. */
function place(nodes: Node[], scale: number, room: number): Placed[] {
  let y = 0
  return nodes.map(x => {
    const p = { ...x, y, h: Math.max(x.amount * scale, 2) }
    y += Math.max(p.h, room) + GAP
    return p
  })
}

function band(x0: number, y0: number, x1: number, y1: number, h: number) {
  const xm = (x0 + x1) / 2
  return `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + h} C${xm},${y1 + h} ${xm},${y0 + h} ${x0},${y0 + h} Z`
}

/**
 * One month as a flow: where the money came from on the left, the month in the
 * middle, where it went on the right. A month that spent more than it earned
 * draws the difference as money taken from savings.
 */
export function MonthFlow({ summary, label }: { summary: Summary; label: (category: string) => string }) {
  const sources: Node[] = summary.income_sources.map(s => ({ label: s.name, amount: s.amount }))
  const short = summary.spending - summary.income
  const total = Math.max(summary.income, summary.spending)
  const left = top(sources, 5, "其他收入", total)
  if (short > 0) left.push({ label: "動用存款", amount: short })
  const right = top(summary.categories.map(c => ({ label: label(c.category), amount: c.amount })), 7, "其他支出", total)
  if (short < 0) right.push({ label: "結餘", amount: -short })
  if (total <= 0) return <p className="text-body text-muted-foreground">這個月沒有收支</p>

  const scale = SPAN / total
  const l = place(left, scale, 34)
  const r = place(right, scale, 18)
  const H = Math.max(...[...l, ...r].map(n => n.y + Math.max(n.h, 18)), SPAN)
  const middle = { y: 0, h: SPAN }

  // Each band joins the middle bar just below the one before it.
  const at = (nodes: Placed[]) => nodes.map((_, i) => middle.y + nodes.slice(0, i).reduce((sum, x) => sum + x.h, 0))
  const inAt = at(l)
  const outAt = at(r)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${summary.month} 收支流向`} className="h-auto w-full text-foreground">
      {l.map((n, i) => {
        const d = band(LEFT + BAR, n.y, MID, inAt[i], n.h)
        return <path key={`l-${n.label}`} d={d} className={n.label === "動用存款" ? "fill-destructive/25" : "fill-foreground/15"}><title>{`${n.label} ${money(n.amount)}`}</title></path>
      })}
      {r.map((n, i) => {
        const d = band(MID + BAR, outAt[i], RIGHT, n.y, n.h)
        return <path key={`r-${n.label}`} d={d} className={n.label === "結餘" ? "fill-foreground/35" : "fill-foreground/15"}><title>{`${n.label} ${money(n.amount)}`}</title></path>
      })}
      {l.map(n => (
        <g key={`ln-${n.label}`}>
          <rect x={LEFT} y={n.y} width={BAR} height={n.h} rx={2} className="fill-foreground" />
          <text x={LEFT - 8} y={n.y + n.h / 2} textAnchor="end" dominantBaseline="middle" className="fill-foreground text-[13px]">{n.label}</text>
          <text x={LEFT - 8} y={n.y + n.h / 2 + 16} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[12px] tabular-nums">{money(n.amount)}</text>
        </g>
      ))}
      <rect x={MID} y={middle.y} width={BAR} height={middle.h} rx={2} className="fill-foreground" />
      {r.map(n => (
        <g key={`rn-${n.label}`}>
          <rect x={RIGHT} y={n.y} width={BAR} height={n.h} rx={2} className="fill-foreground" />
          <text x={RIGHT + BAR + 8} y={n.y + n.h / 2} dominantBaseline="middle" className="fill-foreground text-[13px]">
            {n.label} <tspan className="fill-muted-foreground tabular-nums">{money(n.amount)}</tspan>
          </text>
        </g>
      ))}
    </svg>
  )
}

/** Net worth at the end of each month, one line from the first month to the last. */
export function WorthLine({ summary }: { summary: Summary }) {
  const points = summary.months.filter(m => m.net_worth !== null) as { month: string; net_worth: number }[]
  if (points.length < 2) return <p className="text-body text-muted-foreground">淨資產資料不到 2 個月</p>
  const w = 800
  const h = 240
  const pad = { l: 8, r: 8, t: 16, b: 28 }
  const values = points.map(p => p.net_worth)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b)
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.net_worth)}`).join(" ")
  const last = points.at(-1)!
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="每月淨資產" className="h-auto w-full text-foreground">
      <path d={`${line} L${x(points.length - 1)},${h - pad.b} L${x(0)},${h - pad.b} Z`} className="fill-foreground/10" />
      <path d={line} fill="none" strokeWidth={2} strokeLinejoin="round" className="stroke-foreground" />
      {points.map((p, i) => (
        <circle key={p.month} cx={x(i)} cy={y(p.net_worth)} r={i === points.length - 1 ? 4 : 2.5} className="fill-foreground">
          <title>{`${p.month} ${money(p.net_worth)}`}</title>
        </circle>
      ))}
      <text x={x(points.length - 1)} y={y(last.net_worth) - 10} textAnchor="end" className="fill-foreground text-[13px] tabular-nums">{money(last.net_worth)}</text>
      <text x={pad.l} y={h - 6} className="fill-muted-foreground text-[12px] tabular-nums">{points[0].month}</text>
      <text x={w - pad.r} y={h - 6} textAnchor="end" className="fill-muted-foreground text-[12px] tabular-nums">{last.month}</text>
    </svg>
  )
}
