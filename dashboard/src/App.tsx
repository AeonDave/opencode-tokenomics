import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Activity, AlertTriangle, ChevronRight, Clock, Coins, Cpu, Database, GitBranch, Gauge, Layers, Menu, Search, Settings2, Sparkles, Trash2, Users, Wrench, Zap } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { useSnapshot } from "@/lib/use-snapshot"
import { ago, clock, clockDay, compact, dur, money, num, pct, providerOf, shortModel } from "@/lib/format"
import type {
  AgentModelAgg,
  CacheMetrics,
  ContextBreakdown,
  DayTokens,
  GlobalSnapshot,
  HourBucket,
  ModelAgg,
  ModelSeries,
  ProjectSnapshot,
  SeriesPoint,
  SessionAgg,
  SkillAgg,
  Split,
  ToolAgg,
  Totals,
} from "@/lib/types"

interface View {
  totals: Totals
  apiCalls: number
  cache: CacheMetrics
  split: Split
  models: ModelAgg[]
  sessions: (SessionAgg & { projectName?: string })[]
  tools: ToolAgg[]
  skills: SkillAgg[]
  agentModel: AgentModelAgg[]
  context: ContextBreakdown
  series: SeriesPoint[]
  activityByHour: HourBucket[]
  tokensByDay: DayTokens[]
  spendByModel: ModelSeries
}

/** Toggleable cards — must mirror CARD_IDS in src/plugin/settings.ts. */
const CARDS: { id: string; label: string }[] = [
  { id: "spend", label: "Cumulative spend" },
  { id: "tokenDistribution", label: "Token distribution" },
  { id: "tree", label: "Delegation tree" },
  { id: "models", label: "By model" },
  { id: "context", label: "Context breakdown" },
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills loaded" },
  { id: "agentModel", label: "Agent × model" },
  { id: "effByModel", label: "Cost efficiency ($/M)" },
  { id: "activityByHour", label: "Activity by hour" },
  { id: "spendByModel", label: "Spend over time by model" },
  { id: "tokensByDay", label: "Tokens by day" },
]
type Cards = Record<string, boolean>
const allCardsOn = (): Cards => Object.fromEntries(CARDS.map((c) => [c.id, true]))

const CONTEXT_PARTS = [
  { key: "systemPrompt", label: "system", color: "var(--chart-1)" },
  { key: "toolDefinitions", label: "tool defs", color: "var(--chart-4)" },
  { key: "environment", label: "environment", color: "var(--chart-2)" },
  { key: "projectTree", label: "project tree", color: "var(--chart-3)" },
  { key: "customInstructions", label: "instructions", color: "var(--chart-5)" },
  { key: "other", label: "other", color: "var(--muted-foreground)" },
] as const

function emptyContext(): ContextBreakdown {
  return { systemPrompt: 0, toolDefinitions: 0, environment: 0, projectTree: 0, customInstructions: 0, other: 0, total: 0 }
}

const CHANNELS = [
  { key: "input", label: "input", color: "var(--chart-1)" },
  { key: "cacheRead", label: "cache read", color: "var(--chart-2)" },
  { key: "output", label: "output", color: "var(--chart-3)" },
  { key: "cacheWrite", label: "cache write", color: "var(--chart-4)" },
] as const

const chartConfig = {
  cost: { label: "Cost", color: "var(--chart-5)" },
  tokens: { label: "Tokens", color: "var(--chart-1)" },
} satisfies ChartConfig

function combineSeries(projects: ProjectSnapshot[]): SeriesPoint[] {
  const deltas = new Map<number, { cost: number; tokens: number }>()
  for (const p of projects) {
    let prevC = 0
    let prevT = 0
    for (const pt of p.series) {
      const slot = deltas.get(pt.t) ?? { cost: 0, tokens: 0 }
      slot.cost += pt.cost - prevC
      slot.tokens += pt.tokens - prevT
      deltas.set(pt.t, slot)
      prevC = pt.cost
      prevT = pt.tokens
    }
  }
  let c = 0
  let t = 0
  return [...deltas.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, d]) => {
      c += d.cost
      t += d.tokens
      return { t: time, cost: Number(c.toFixed(6)), tokens: Math.round(t) }
    })
}

function mergeHourly(projects: ProjectSnapshot[]): HourBucket[] {
  const out: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, cost: 0, calls: 0 }))
  for (const p of projects)
    for (const b of p.activityByHour ?? []) {
      const o = out[b.hour]
      if (!o) continue
      o.tokens += b.tokens
      o.cost += b.cost
      o.calls += b.calls
    }
  return out
}

function mergeTokensByDay(projects: ProjectSnapshot[]): DayTokens[] {
  const map = new Map<number, DayTokens>()
  for (const p of projects)
    for (const d of p.tokensByDay ?? []) {
      const e = map.get(d.day) ?? { day: d.day, input: 0, cacheRead: 0, output: 0, cacheWrite: 0 }
      e.input += d.input
      e.cacheRead += d.cacheRead
      e.output += d.output
      e.cacheWrite += d.cacheWrite
      map.set(d.day, e)
    }
  return [...map.values()].sort((a, b) => a.day - b.day)
}

// Merge per-project incremental model-series: union models (top 6 by weight + "other"), sum increments per minute.
function mergeModelSeries(projects: ProjectSnapshot[]): ModelSeries {
  const weight = new Map<string, number>()
  const byMinute = new Map<number, Record<string, number>>()
  for (const p of projects) {
    const ms = p.spendByModel
    if (!ms?.points?.length) continue
    for (const pt of ms.points) {
      const slot = byMinute.get(pt.t) ?? {}
      for (const m of ms.models) {
        const v = (pt as Record<string, number>)[m] ?? 0
        if (!v) continue
        slot[m] = (slot[m] ?? 0) + v
        weight.set(m, (weight.get(m) ?? 0) + v)
      }
      byMinute.set(pt.t, slot)
    }
  }
  if (!byMinute.size) return { models: [], points: [] }
  const ranked = [...weight.keys()].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))
  // keep "other" last if present
  const named = ranked.filter((m) => m !== "other")
  const top = named.slice(0, 6)
  const hasOther = ranked.includes("other") || named.length > top.length
  const topSet = new Set(top)
  const models = hasOther ? [...top, "other"] : top
  const points = [...byMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, slot]) => {
      const row: { t: number; [m: string]: number } = { t }
      for (const m of models) row[m] = 0
      for (const [m, v] of Object.entries(slot)) row[topSet.has(m) ? m : "other"] += v
      return row
    })
  return { models, points }
}

/** Cumulate incremental model-series for stacked-area display. */
function cumulateModelSeries(ms: ModelSeries): { models: string[]; points: Array<{ t: number; [m: string]: number }> } {
  const cum: Record<string, number> = {}
  for (const m of ms.models) cum[m] = 0
  const points = ms.points.map((pt) => {
    for (const m of ms.models) cum[m] += (pt as Record<string, number>)[m] ?? 0
    return { t: pt.t, ...cum }
  })
  return { models: ms.models, points }
}

function buildView(g: GlobalSnapshot, selected: string): View {
  if (selected !== "all") {
    const p = g.projects.find((x) => x.projectKey === selected)
    if (p) return { ...p }
  }
  // "All projects" — merge across projects.
  const models = new Map<string, ModelAgg>()
  const tools = new Map<string, ToolAgg>()
  const skills = new Map<string, SkillAgg>()
  const agentModel = new Map<string, AgentModelAgg>()
  const sessions: (SessionAgg & { projectName?: string })[] = []
  const context = emptyContext()
  const split: Split = {
    main: { cost: 0, estimatedCost: 0, tokens: 0, apiCalls: 0 },
    subagents: { cost: 0, estimatedCost: 0, tokens: 0, apiCalls: 0 },
  }
  let withoutCaching = 0
  let savings = 0
  for (const p of g.projects) {
    for (const m of p.models) {
      const cur = models.get(m.model) ?? { ...m, cost: 0, estimatedCost: 0, tokens: 0, messages: 0, errors: 0 }
      cur.cost += m.cost
      cur.estimatedCost += m.estimatedCost
      cur.tokens += m.tokens
      cur.messages += m.messages
      cur.errors += m.errors
      models.set(m.model, cur)
    }
    for (const t of p.tools) {
      const cur = tools.get(t.tool) ?? { ...t, count: 0, outputTokens: 0, totalDurationMs: 0, errors: 0 }
      cur.count += t.count
      cur.outputTokens += t.outputTokens
      cur.totalDurationMs += t.totalDurationMs
      cur.errors += t.errors
      cur.schemaTokens = t.schemaTokens || cur.schemaTokens
      tools.set(t.tool, cur)
    }
    for (const sk of p.skills ?? []) {
      const cur = skills.get(sk.name) ?? { name: sk.name, count: 0, tokens: 0 }
      cur.count += sk.count
      cur.tokens += sk.tokens
      skills.set(sk.name, cur)
    }
    for (const a of p.agentModel ?? []) {
      const key = `${a.agent} ${a.model}`
      const cur = agentModel.get(key) ?? { ...a, cost: 0, estimatedCost: 0, tokens: 0, messages: 0 }
      cur.cost += a.cost
      cur.estimatedCost += a.estimatedCost
      cur.tokens += a.tokens
      cur.messages += a.messages
      agentModel.set(key, cur)
    }
    for (const s of p.sessions) sessions.push({ ...s, projectName: p.projectName })
    for (const part of CONTEXT_PARTS) context[part.key] += p.context?.[part.key] ?? 0
    split.main.cost += p.split.main.cost
    split.main.estimatedCost += p.split.main.estimatedCost
    split.main.tokens += p.split.main.tokens
    split.main.apiCalls += p.split.main.apiCalls
    split.subagents.cost += p.split.subagents.cost
    split.subagents.estimatedCost += p.split.subagents.estimatedCost
    split.subagents.tokens += p.split.subagents.tokens
    split.subagents.apiCalls += p.split.subagents.apiCalls
    withoutCaching += p.cache.withoutCachingCost
    savings += p.cache.savings
  }
  context.total =
    context.systemPrompt + context.toolDefinitions + context.environment + context.projectTree + context.customInstructions + context.other
  const totals = g.totals
  const hitRate = totals.cacheRead + totals.input > 0
    ? totals.cacheRead / (totals.cacheRead + totals.input)
    : 0
  return {
    totals,
    apiCalls: g.apiCalls,
    cache: {
      hitRate,
      withoutCachingCost: withoutCaching,
      savings,
      effectiveRatePerM: totals.tokens > 0 ? (totals.cost / totals.tokens) * 1_000_000 : 0,
    },
    split,
    models: [...models.values()].sort((a, b) => b.cost - a.cost),
    sessions: sessions.sort((a, b) => b.cost - a.cost),
    tools: [...tools.values()].sort((a, b) => b.count - a.count),
    skills: [...skills.values()].sort((a, b) => b.count - a.count || b.tokens - a.tokens),
    agentModel: [...agentModel.values()].sort((a, b) => b.cost - a.cost),
    context,
    series: combineSeries(g.projects),
    activityByHour: mergeHourly(g.projects),
    tokensByDay: mergeTokensByDay(g.projects),
    spendByModel: mergeModelSeries(g.projects),
  }
}

/* ── small presentational pieces ───────────────────────────── */

function Kpi(props: { icon: ReactNode; label: string; value: string; sub?: string; accent?: string }) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="opacity-70">{props.icon}</span>
          <span className="text-[10.5px] uppercase tracking-[0.16em]">{props.label}</span>
        </div>
        <div
          className="mt-2 text-3xl font-semibold tracking-tight tabular-nums"
          style={props.accent ? { color: props.accent } : undefined}
        >
          {props.value}
        </div>
        {props.sub && <div className="mt-1 text-xs text-muted-foreground tabular-nums">{props.sub}</div>}
      </CardContent>
    </Card>
  )
}

function DistributionBar({ totals }: { totals: Totals }) {
  const sum = totals.input + totals.cacheRead + totals.output + totals.cacheWrite || 1
  const value: Record<string, number> = {
    input: totals.input,
    cacheRead: totals.cacheRead,
    output: totals.output,
    cacheWrite: totals.cacheWrite,
  }
  return (
    <div>
      <div className="flex h-3.5 w-full overflow-hidden rounded-sm border border-border bg-muted">
        {CHANNELS.map((c) => (
          <div key={c.key} style={{ width: `${(value[c.key] / sum) * 100}%`, background: c.color }} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {CHANNELS.map((c) => (
          <div key={c.key} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2.5 rounded-[2px]" style={{ background: c.color }} />
            {c.label} <b className="font-medium text-foreground tabular-nums">{compact(value[c.key])}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelBars({ models }: { models: ModelAgg[] }) {
  if (!models.length) return <Empty />
  const max = models.reduce((mx, m) => Math.max(mx, m.tokens), 0) || 1 // bars show token share (works for free models too)
  return (
    <div className="space-y-3">
      {models.slice(0, 8).map((m) => (
        <div key={m.model}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="truncate text-sm">{shortModel(m.model)}</span>
            <CostText cost={m.cost} est={m.estimatedCost} className="shrink-0 text-sm font-medium tabular-nums" />
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-muted">
            <div className="h-full rounded-sm" style={{ width: `${(m.tokens / max) * 100}%`, background: "var(--chart-4)" }} />
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
            <span className="text-foreground/70">{m.providerID}</span> · {compact(m.tokens)} tok · {m.messages} calls
          </div>
        </div>
      ))}
    </div>
  )
}

type SAgg = SessionAgg & { projectName?: string }

interface TNode {
  s: SAgg
  depth: number
  children: TNode[]
  descendants: number
  subtreeCost: number
  subtreeEst: number
  subtreeTokens: number
}

function buildForest(sessions: SAgg[]): TNode[] {
  const byParent = new Map<string, SAgg[]>()
  const ids = new Set(sessions.map((s) => s.sessionID))
  for (const s of sessions) {
    const key = s.parentID && ids.has(s.parentID) ? s.parentID : "__root"
    const arr = byParent.get(key) ?? []
    arr.push(s)
    byParent.set(key, arr)
  }
  const byWeight = (a: TNode, b: TNode) => b.subtreeCost - a.subtreeCost || b.subtreeTokens - a.subtreeTokens
  const build = (s: SAgg, depth: number): TNode => {
    const children = (byParent.get(s.sessionID) ?? []).map((c) => build(c, depth + 1)).sort(byWeight)
    const node: TNode = { s, depth, children, descendants: 0, subtreeCost: s.cost, subtreeEst: s.estimatedCost, subtreeTokens: s.tokens }
    for (const c of children) {
      node.descendants += c.descendants + 1
      node.subtreeCost += c.subtreeCost
      node.subtreeEst += c.subtreeEst
      node.subtreeTokens += c.subtreeTokens
    }
    return node
  }
  return (byParent.get("__root") ?? []).map((s) => build(s, 0)).sort(byWeight)
}

const startOfDay = (ts: number) => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function dayLabel(ts: number): string {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86_400_000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })
}

interface DayGroup {
  key: string
  ts: number
  label: string
  roots: TNode[]
  cost: number
  est: number
  tokens: number
  sessions: number
}

function groupByDay(forest: TNode[]): DayGroup[] {
  const map = new Map<string, DayGroup>()
  for (const node of forest) {
    const ts = node.s.startedAt || node.s.lastActivity || 0
    const dk = startOfDay(ts)
    const key = `day:${dk}`
    const g = map.get(key) ?? { key, ts: dk, label: dayLabel(ts), roots: [], cost: 0, est: 0, tokens: 0, sessions: 0 }
    g.roots.push(node)
    g.cost += node.subtreeCost
    g.est += node.subtreeEst
    g.tokens += node.subtreeTokens
    g.sessions += node.descendants + 1
    map.set(key, g)
  }
  return [...map.values()].sort((a, b) => b.ts - a.ts)
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight size={13} className={"shrink-0 text-muted-foreground transition-transform " + (open ? "rotate-90" : "")} />
}

function Branch({ node, showProject, collapsed, toggle }: { node: TNode; showProject: boolean; collapsed: Set<string>; toggle: (k: string) => void }) {
  const hasKids = node.children.length > 0
  const isOpen = !collapsed.has(node.s.sessionID)
  const dot = node.s.isSubagent ? "var(--chart-4)" : "var(--chart-1)"
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_96px] items-center gap-3 border-b border-border/30 py-1.5 last:border-0">
        <div className="flex min-w-0 items-center" style={{ paddingLeft: `${node.depth * 16}px` }}>
          {hasKids ? (
            <button type="button" onClick={() => toggle(node.s.sessionID)} className="mr-1 flex items-center" aria-label={isOpen ? "Collapse" : "Expand"}>
              <Chevron open={isOpen} />
            </button>
          ) : (
            <span className="mr-1 inline-block w-[13px]" />
          )}
          <span className="mr-2 size-1.5 shrink-0 rounded-full" style={{ background: dot }} />
          <span className="truncate text-sm">
            {node.s.agent || node.s.title || node.s.sessionID.slice(0, 10)}
            {showProject && node.s.projectName && <span className="ml-2 text-[11px] text-muted-foreground">· {node.s.projectName}</span>}
            <span className="ml-2 text-[11px] text-muted-foreground tabular-nums">
              {compact(isOpen ? node.s.tokens : node.subtreeTokens)} tok · {node.s.messages} calls · {dur(node.s.durationMs)}
              {hasKids && !isOpen && <span className="text-[var(--chart-4)]"> · +{node.descendants} merged</span>}
              {(node.s.errors > 0 || node.s.retries > 0) && (
                <span style={{ color: "var(--destructive)" }}>
                  {" · "}
                  {node.s.errors > 0 ? `${node.s.errors} err` : ""}
                  {node.s.errors > 0 && node.s.retries > 0 ? " " : ""}
                  {node.s.retries > 0 ? `${node.s.retries} retry` : ""}
                </span>
              )}
            </span>
          </span>
        </div>
        <Badge variant="outline" className="hidden font-normal text-muted-foreground sm:inline-flex" title={node.s.model}>
          {shortModel(node.s.model)}
        </Badge>
        <CostText
          cost={isOpen ? node.s.cost : node.subtreeCost}
          est={isOpen ? node.s.estimatedCost : node.subtreeEst}
          className="text-right text-sm tabular-nums"
        />
      </div>
      {hasKids && isOpen && node.children.map((c) => <Branch key={c.s.sessionID} node={c} showProject={showProject} collapsed={collapsed} toggle={toggle} />)}
    </>
  )
}

function Tree({ sessions, showProject }: { sessions: SAgg[]; showProject: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (k: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const days = useMemo(() => groupByDay(buildForest(sessions)), [sessions])
  if (!days.length) return <Empty />
  return (
    <div className="space-y-1">
      {days.map((day) => {
        const open = !collapsed.has(day.key)
        return (
          <div key={day.key}>
            <button
              type="button"
              onClick={() => toggle(day.key)}
              className="flex w-full items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-left transition-colors hover:bg-muted/70"
            >
              <Chevron open={open} />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{day.label}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {day.sessions} session{day.sessions === 1 ? "" : "s"} · {compact(day.tokens)} tok
              </span>
              <CostText cost={day.cost} est={day.est} className="ml-auto text-sm tabular-nums" />
            </button>
            {open && (
              <div className="mt-0.5">
                {day.roots.map((node) => (
                  <Branch key={node.s.sessionID} node={node} showProject={showProject} collapsed={collapsed} toggle={toggle} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ContextBar({ context }: { context: ContextBreakdown }) {
  if (!context || !context.total) {
    return <div className="py-4 text-center text-xs text-muted-foreground">awaiting first request…</div>
  }
  const parts = CONTEXT_PARTS.filter((p) => context[p.key] > 0)
  return (
    <div>
      <div className="flex h-3.5 w-full overflow-hidden rounded-sm border border-border bg-muted">
        {parts.map((p) => (
          <div key={p.key} style={{ width: `${(context[p.key] / context.total) * 100}%`, background: p.color }} title={p.label} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2.5 rounded-[2px]" style={{ background: p.color }} />
            {p.label} <b className="font-medium text-foreground tabular-nums">{compact(context[p.key])}</b>
          </div>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">
          est. <b className="font-medium text-foreground tabular-nums">{compact(context.total)}</b> tok
        </span>
      </div>
    </div>
  )
}

function AgentModelTable({ rows }: { rows: AgentModelAgg[] }) {
  if (!rows.length) return <Empty />
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          <th className="pb-1.5 text-left font-normal">agent</th>
          <th className="pb-1.5 text-left font-normal">model</th>
          <th className="pb-1.5 text-right font-normal">tokens</th>
          <th className="pb-1.5 text-right font-normal">calls</th>
          <th className="pb-1.5 text-right font-normal">cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 10).map((a) => (
          <tr key={`${a.agent} ${a.model}`} className="border-b border-border/40 last:border-0">
            <td className="py-1.5 text-left">{a.agent}</td>
            <td className="py-1.5 text-left text-muted-foreground" title={a.model}>
              {shortModel(a.model)}
              {providerOf(a.model) && <span className="ml-1 text-[10px] opacity-70">· {providerOf(a.model)}</span>}
            </td>
            <td className="py-1.5 text-right tabular-nums">{compact(a.tokens)}</td>
            <td className="py-1.5 text-right tabular-nums">{a.messages}</td>
            <td className="py-1.5 text-right tabular-nums"><CostText cost={a.cost} est={a.estimatedCost} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ToolTable({ tools }: { tools: ToolAgg[] }) {
  if (!tools.length) return <Empty />
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          <th className="w-[13ch] pb-1.5 text-left font-normal">tool</th>
          <th className="whitespace-nowrap pb-1.5 pl-2 text-right font-normal">calls</th>
          <th className="whitespace-nowrap pb-1.5 pl-2 text-right font-normal">err</th>
          <th className="whitespace-nowrap pb-1.5 pl-2 text-right font-normal">out tok</th>
          <th className="whitespace-nowrap pb-1.5 pl-2 text-right font-normal">time</th>
          <th className="whitespace-nowrap pb-1.5 pl-2 text-right font-normal">avg</th>
        </tr>
      </thead>
      <tbody>
        {tools.slice(0, 10).map((t) => (
          <tr key={t.tool} className="border-b border-border/40 last:border-0">
            <td className="py-1.5 text-left">
              <span className="block truncate" title={t.tool}>
                {t.tool}
                {t.complexity === "complex" && (
                  <Badge variant="outline" className="ml-1.5 border-amber-500/30 px-1 py-0 text-[9px] font-normal text-amber-400">cplx</Badge>
                )}
              </span>
            </td>
            <td className="whitespace-nowrap py-1.5 pl-2 text-right text-xs tabular-nums">{compact(t.count)}</td>
            <td className="whitespace-nowrap py-1.5 pl-2 text-right text-xs tabular-nums" style={t.errors > 0 ? { color: "var(--destructive)" } : undefined}>
              {t.errors > 0 ? compact(t.errors) : "—"}
            </td>
            <td className="whitespace-nowrap py-1.5 pl-2 text-right text-xs tabular-nums text-muted-foreground">{compact(t.outputTokens)}</td>
            <td className="whitespace-nowrap py-1.5 pl-2 text-right text-xs tabular-nums text-muted-foreground">{dur(t.totalDurationMs)}</td>
            <td className="whitespace-nowrap py-1.5 pl-2 text-right text-xs tabular-nums text-muted-foreground">{dur(t.count ? t.totalDurationMs / t.count : 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SkillTable({ skills }: { skills: SkillAgg[] }) {
  if (!skills.length) return <Empty />
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          <th className="pb-1.5 text-left font-normal">skill</th>
          <th className="pb-1.5 text-right font-normal">loads</th>
          <th className="pb-1.5 text-right font-normal">tokens</th>
        </tr>
      </thead>
      <tbody>
        {skills.slice(0, 12).map((s) => (
          <tr key={s.name} className="border-b border-border/40 last:border-0">
            <td className="py-1.5 text-left">{s.name}</td>
            <td className="py-1.5 text-right tabular-nums">{s.count}</td>
            <td className="py-1.5 text-right tabular-nums text-muted-foreground">{compact(s.tokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Empty() {
  return <div className="py-6 text-center text-sm text-muted-foreground">—</div>
}

/**
 * Cost cell that never shows phantom spend:
 *   real cost (paid)  → "$0.42"
 *   subscription $0   → "~$0.03" (muted, estimated API-equivalent)
 *   free model        → "free"
 */
function CostText({ cost, est, className }: { cost: number; est: number; className?: string }) {
  if (cost > 0) return <span className={className} style={{ color: "var(--chart-5)" }}>{money(cost)}</span>
  if (est > 0)
    return (
      <span className={(className ?? "") + " text-muted-foreground"} title="estimated API-equivalent — your plan/model reports $0">
        ~{money(est)}
      </span>
    )
  return <span className={(className ?? "") + " text-muted-foreground"}>free</span>
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{children}</h2>
}

/* ── new charts ────────────────────────────────────────────── */

const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "#FF7AB6", "var(--muted-foreground)"]
const TOOLTIP_STYLE = { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }

function EffByModel({ models }: { models: ModelAgg[] }) {
  const rows = models
    .map((m) => ({ model: m.model, providerID: m.providerID, perM: m.tokens > 0 ? ((m.cost > 0 ? m.cost : m.estimatedCost) / m.tokens) * 1_000_000 : 0, tokens: m.tokens }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.perM - a.perM)
    .slice(0, 8)
  if (!rows.length) return <Empty />
  const max = rows.reduce((mx, r) => Math.max(mx, r.perM), 0) || 1
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.model}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm">
              {shortModel(r.model)} <span className="text-[11px] text-muted-foreground">· {r.providerID}</span>
            </span>
            <span className="shrink-0 text-sm font-medium tabular-nums" style={{ color: "var(--chart-5)" }}>{money(r.perM, 2)}/M</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-muted">
            <div className="h-full rounded-sm" style={{ width: `${(r.perM / max) * 100}%`, background: "var(--chart-2)" }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function ActivityByHour({ data }: { data: HourBucket[] }) {
  if (!data.some((d) => d.tokens > 0)) return <Empty />
  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 4, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="hour" tickFormatter={(h) => `${h}`} tickLine={false} axisLine={false} tickMargin={6} minTickGap={12} fontSize={10} stroke="var(--muted-foreground)" />
          <YAxis tickFormatter={(v) => compact(v as number)} tickLine={false} axisLine={false} width={42} fontSize={10} stroke="var(--muted-foreground)" />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.3 }} contentStyle={TOOLTIP_STYLE} formatter={(v) => [compact(v as number), "tokens"]} labelFormatter={(h) => `${h}:00–${h}:59`} />
          <Bar dataKey="tokens" fill="var(--chart-1)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

const DAY_CHANNELS = [
  { key: "input", color: "var(--chart-1)" },
  { key: "cacheRead", color: "var(--chart-2)" },
  { key: "output", color: "var(--chart-3)" },
  { key: "cacheWrite", color: "var(--chart-4)" },
] as const

function TokensByDay({ data }: { data: DayTokens[] }) {
  if (!data.length) return <Empty />
  const rows = data.map((d) => ({ ...d, label: clockDay(d.day) }))
  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ left: 4, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={20} fontSize={10} stroke="var(--muted-foreground)" />
          <YAxis tickFormatter={(v) => compact(v as number)} tickLine={false} axisLine={false} width={42} fontSize={10} stroke="var(--muted-foreground)" />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.3 }} contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [compact(v as number), n as string]} />
          {DAY_CHANNELS.map((c) => (
            <Bar key={c.key} dataKey={c.key} stackId="t" fill={c.color} radius={c.key === "cacheWrite" ? [2, 2, 0, 0] : undefined} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function SpendByModel({ series }: { series: ModelSeries }) {
  const data = useMemo(() => cumulateModelSeries(series), [series])
  if (!data.points.length || !data.models.length) return <Empty />
  return (
    <div>
      <div className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.points} margin={{ left: 4, right: 8, top: 6 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={clock} tickLine={false} axisLine={false} tickMargin={6} minTickGap={40} fontSize={10} stroke="var(--muted-foreground)" />
            <YAxis tickFormatter={(v) => money(v as number, 2)} tickLine={false} axisLine={false} width={48} fontSize={10} stroke="var(--muted-foreground)" />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(t) => clock(Number(t))} formatter={(v, n) => [money(v as number, 4), shortModel(n as string)]} />
            {data.models.map((m, i) => (
              <Area key={m} dataKey={m} stackId="1" type="monotone" stroke={SERIES_COLORS[i % SERIES_COLORS.length]} fill={SERIES_COLORS[i % SERIES_COLORS.length]} fillOpacity={0.5} strokeWidth={1} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {data.models.map((m, i) => (
          <span key={m} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-2 rounded-[2px]" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {shortModel(m)}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ── project navigation (scales to hundreds of projects) ───── */

type Sort = "spend" | "recent" | "name"

const activeNow = (updatedAt: number) => Date.now() - updatedAt < 60_000

/** Compact an absolute path for the narrow sidebar: "C:/…/Desktop/ctf". */
function shortPath(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return p
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`
}

function Brand() {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-bold tracking-tight">
        <span className="mr-2" style={{ color: "var(--chart-1)" }}>◖◗</span>tokenomics
      </span>
    </div>
  )
}

function ProjectRow({
  p,
  active,
  onSelect,
  onDelete,
}: {
  p: ProjectSnapshot
  active: boolean
  onSelect: (k: string) => void
  onDelete: (key: string, name: string) => void
}) {
  const live = activeNow(p.updatedAt)
  return (
    <div
      className={
        "group flex items-center gap-1 rounded-md pr-1 transition-colors " +
        (active ? "bg-primary/10" : "hover:bg-muted/60")
      }
    >
      <button type="button" onClick={() => onSelect(p.projectKey)} title={p.projectRoot} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: live ? "var(--chart-2)" : "var(--muted-foreground)" }} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm">{p.projectName}</span>
            <CostText cost={p.totals.cost} est={p.totals.estimatedCost} className="shrink-0 text-xs tabular-nums" />
          </span>
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[10.5px] text-muted-foreground">{shortPath(p.projectRoot)}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{ago(p.updatedAt)}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Delete ${p.projectName}`}
        title="Delete this project's data"
        onClick={() => onDelete(p.projectKey, p.projectName)}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-[var(--destructive)] focus:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function ProjectList({
  projects,
  selected,
  onSelect,
  onDelete,
  onDeleteAll,
  totalCost,
}: {
  projects: ProjectSnapshot[]
  selected: string
  onSelect: (k: string) => void
  onDelete: (key: string, name: string) => void
  onDeleteAll: () => void
  totalCost: number
}) {
  const [q, setQ] = useState("")
  const [sort, setSort] = useState<Sort>("spend")
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = projects.filter(
      (p) => !needle || p.projectName.toLowerCase().includes(needle) || p.projectRoot.toLowerCase().includes(needle),
    )
    const sorted = [...list]
    if (sort === "spend") sorted.sort((a, b) => b.totals.cost - a.totals.cost)
    else if (sort === "recent") sorted.sort((a, b) => b.updatedAt - a.updatedAt)
    else sorted.sort((a, b) => a.projectName.localeCompare(b.projectName))
    return sorted
  }, [projects, q, sort])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" className="h-9 pl-8" />
      </div>
      <div className="flex gap-1 text-[11px]">
        {(["spend", "recent", "name"] as Sort[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSort(s)}
            className={
              "rounded px-2 py-1 capitalize transition-colors " +
              (sort === s ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")
            }
          >
            {s}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={
          "flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors " +
          (selected === "all"
            ? "border-primary/60 bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:text-foreground")
        }
      >
        <span>All projects</span>
        <span className="tabular-nums" style={{ color: "var(--chart-5)" }}>{money(totalCost)}</span>
      </button>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">No matching projects</div>
        ) : (
          filtered.map((p) => (
            <ProjectRow key={p.projectKey} p={p} active={selected === p.projectKey} onSelect={onSelect} onDelete={onDelete} />
          ))
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border pt-2 text-[10.5px] text-muted-foreground">
        <span>
          {projects.length} project{projects.length === 1 ? "" : "s"} tracked
        </span>
        {projects.length > 0 && (
          <button
            type="button"
            onClick={onDeleteAll}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-[var(--destructive)]"
          >
            <Trash2 size={11} /> Clear all
          </button>
        )}
      </div>
    </div>
  )
}

/* ── card settings ─────────────────────────────────────────── */

function useCardConfig() {
  const [cards, setCards] = useState<Cards>(allCardsOn())
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => { if (d?.cards) setCards({ ...allCardsOn(), ...d.cards }) })
      .catch(() => {})
  }, [])
  const save = (next: Cards) => {
    setCards(next)
    void fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: next }) }).catch(() => {})
  }
  return { cards, save }
}

function SettingsPanel({ cards, onSave }: { cards: Cards; onSave: (c: Cards) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Cards>(cards)
  useEffect(() => { if (open) setDraft(cards) }, [open, cards])
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Settings"
      >
        <Settings2 size={15} />
      </SheetTrigger>
      <SheetContent side="right" className="flex w-80 flex-col gap-4 p-4">
        <SheetHeader className="p-0">
          <SheetTitle>Cards</SheetTitle>
        </SheetHeader>
        <p className="text-xs text-muted-foreground">
          Toggle what's shown. Hidden cards also stop being computed — lighter on big histories. Saved to <code>tokenomics.json</code>.
        </p>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {CARDS.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/60">
              <span>{c.label}</span>
              <input
                type="checkbox"
                className="size-4 accent-[var(--chart-2)]"
                checked={draft[c.id] !== false}
                onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.checked }))}
              />
            </label>
          ))}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => setDraft(allCardsOn())} className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
            All on
          </button>
          <button
            type="button"
            onClick={() => { onSave(draft); setOpen(false) }}
            className="flex-1 rounded-md border border-primary/60 bg-primary/10 px-3 py-2 text-sm text-foreground transition-colors hover:bg-primary/20"
          >
            Save
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/* ── main ──────────────────────────────────────────────────── */

export default function App() {
  const { data, connected } = useSnapshot()
  const { cards, save } = useCardConfig()
  const [selected, setSelected] = useState<string>("all")
  const [drawerOpen, setDrawerOpen] = useState(false)

  const view = useMemo(() => (data ? buildView(data, selected) : null), [data, selected])
  const projects = data?.projects ?? []
  const showProjectCol = selected === "all"
  const selectedProject = selected === "all" ? undefined : projects.find((p) => p.projectKey === selected)
  const selectedName = selected === "all" ? "All projects" : selectedProject?.projectName ?? "All projects"

  const deleteProject = async (key: string, name: string) => {
    if (!window.confirm(`Delete all stored tokenomics data for "${name}"?\nThis only clears the dashboard's data, not your code. It can't be undone.`)) return
    await fetch(`/api/projects/${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {})
    if (selected === key) setSelected("all")
    // the SSE stream pushes the refreshed snapshot; no manual refetch needed
  }
  const deleteAll = async () => {
    if (!window.confirm("Delete stored tokenomics data for ALL projects?\nThis only clears the dashboard's data, not your code. It can't be undone.")) return
    await fetch("/api/projects", { method: "DELETE" }).catch(() => {})
    setSelected("all")
    setDrawerOpen(false)
  }

  return (
    <div className="flex min-h-screen">
      {/* desktop sidebar — searchable, sortable, scrollable; scales to hundreds of projects */}
      <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col gap-4 border-r border-border p-4 lg:flex">
        <Brand />
        <ProjectList projects={projects} selected={selected} onSelect={setSelected} onDelete={deleteProject} onDeleteAll={deleteAll} totalCost={data?.totals.cost ?? 0} />
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-8">
          {/* header */}
          <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
            <div className="flex min-w-0 items-center gap-3">
              {/* mobile project drawer */}
              <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                <SheetTrigger className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground lg:hidden">
                  <Menu size={16} />
                </SheetTrigger>
                <SheetContent side="left" className="flex w-80 flex-col gap-4 p-4">
                  <SheetHeader className="p-0">
                    <SheetTitle><Brand /></SheetTitle>
                  </SheetHeader>
                  <ProjectList
                    projects={projects}
                    selected={selected}
                    onSelect={(k) => {
                      setSelected(k)
                      setDrawerOpen(false)
                    }}
                    onDelete={deleteProject}
                    onDeleteAll={deleteAll}
                    totalCost={data?.totals.cost ?? 0}
                  />
                </SheetContent>
              </Sheet>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-tight">{selectedName}</h1>
                <span className="block truncate text-xs text-muted-foreground" title={selectedProject?.projectRoot}>
                  {selectedProject ? selectedProject.projectRoot : "opencode usage & cost"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                <span
                  className="size-2 rounded-full transition-colors"
                  style={{ background: connected ? "var(--chart-2)" : "var(--destructive)" }}
                />
                {connected ? "live" : "reconnecting"}
                {data && <span className="normal-case tracking-normal">· {ago(data.updatedAt || Date.now())}</span>}
              </div>
              <SettingsPanel cards={cards} onSave={save} />
            </div>
          </header>

      {!view || view.totals.messages === 0 ? (
        <Card>
          <CardContent className="py-20 text-center text-muted-foreground">
            {connected
              ? "No usage yet — send a message in opencode and it will appear here in real time."
              : "Connecting to the tokenomics server…"}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPIs */}
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-6">
            <Kpi icon={<Coins size={14} />} label="Spend" value={money(view.totals.cost)} accent="var(--chart-5)"
              sub={
                view.totals.cost > 0
                  ? `eff. ${money(view.cache.effectiveRatePerM)}/M`
                  : view.totals.estimatedCost > 0
                    ? `≈ ${money(view.totals.estimatedCost)} at API rates`
                    : view.totals.tokens > 0
                      ? "free"
                      : "—"
              } />
            <Kpi icon={<Zap size={14} />} label="Tokens" value={compact(view.totals.tokens)} sub={`${num(view.totals.tokens)} total`} />
            <Kpi icon={<Activity size={14} />} label="API calls" value={num(view.apiCalls)}
              sub={`${view.totals.sessions} sessions`} />
            <Kpi icon={<Database size={14} />} label="Cache hit" value={pct(view.cache.hitRate)} accent="var(--chart-2)"
              sub={`${compact(view.totals.cacheRead)} cached`} />
            <Kpi icon={<Coins size={14} />} label="Cache saved" value={money(view.cache.savings)} accent="var(--chart-2)"
              sub="vs no-cache API price" />
            <Kpi icon={<AlertTriangle size={14} />} label="Errors" value={num(view.totals.errors)}
              accent={view.totals.errors > 0 ? "var(--destructive)" : undefined} sub={`${num(view.totals.retries)} retries`} />
          </div>

          {/* charts row */}
          {(cards.spend || cards.tokenDistribution) && (
            <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
              {cards.spend && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle>Cumulative spend</SectionTitle>
                    <ChartContainer config={chartConfig} className="h-[220px] w-full">
                      <AreaChart data={view.series} margin={{ left: 4, right: 8, top: 4 }}>
                        <defs>
                          <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--color-cost)" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="var(--color-cost)" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                        <XAxis dataKey="t" tickFormatter={clock} tickLine={false} axisLine={false}
                          tickMargin={8} minTickGap={40} fontSize={11} stroke="var(--muted-foreground)" />
                        <YAxis tickFormatter={(v) => money(v as number, 2)} tickLine={false} axisLine={false}
                          width={54} fontSize={11} stroke="var(--muted-foreground)" />
                        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => clock(Number(p?.[0]?.payload?.t))} />} />
                        <Area dataKey="cost" type="monotone" stroke="var(--color-cost)" strokeWidth={2} fill="url(#fillCost)" />
                      </AreaChart>
                    </ChartContainer>
                  </CardContent>
                </Card>
              )}
              {cards.tokenDistribution && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle>Token distribution</SectionTitle>
                    <DistributionBar totals={view.totals} />
                    <Separator className="my-4" />
                    <div className="grid grid-cols-2 gap-y-3 text-xs">
                      <SplitStat label="Main" cost={view.split.main.cost} est={view.split.main.estimatedCost} calls={view.split.main.apiCalls} />
                      <SplitStat label="Subagents" cost={view.split.subagents.cost} est={view.split.subagents.estimatedCost} calls={view.split.subagents.apiCalls} />
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* new charts */}
          {(cards.spendByModel || cards.tokensByDay) && (
            <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              {cards.spendByModel && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle><Coins size={11} className="mr-1.5 inline" />Spend over time, by model</SectionTitle>
                    <SpendByModel series={view.spendByModel} />
                  </CardContent>
                </Card>
              )}
              {cards.tokensByDay && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle><Zap size={11} className="mr-1.5 inline" />Tokens by day</SectionTitle>
                    <TokensByDay data={view.tokensByDay} />
                  </CardContent>
                </Card>
              )}
            </div>
          )}
          {(cards.activityByHour || cards.effByModel) && (
            <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
              {cards.activityByHour && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle><Clock size={11} className="mr-1.5 inline" />Activity by hour of day</SectionTitle>
                    <ActivityByHour data={view.activityByHour} />
                  </CardContent>
                </Card>
              )}
              {cards.effByModel && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle><Gauge size={11} className="mr-1.5 inline" />Cost efficiency · $/M tokens</SectionTitle>
                    <EffByModel models={view.models} />
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* tree + model/tools */}
          {(cards.tree || cards.models || cards.tools || cards.skills) && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
              {cards.tree && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle><GitBranch size={11} className="mr-1.5 inline" />Delegation tree</SectionTitle>
                    <Tree sessions={view.sessions} showProject={showProjectCol} />
                  </CardContent>
                </Card>
              )}
              {(cards.models || cards.tools || cards.skills) && (
                <div className="space-y-4">
                  {cards.models && (
                    <Card>
                      <CardContent className="pt-5">
                        <SectionTitle><Cpu size={11} className="mr-1.5 inline" />By model</SectionTitle>
                        <ModelBars models={view.models} />
                      </CardContent>
                    </Card>
                  )}
                  {cards.tools && (
                    <Card>
                      <CardContent className="pt-5">
                        <SectionTitle><Wrench size={11} className="mr-1.5 inline" />Tools</SectionTitle>
                        <ToolTable tools={view.tools} />
                      </CardContent>
                    </Card>
                  )}
                  {cards.skills && (
                    <Card>
                      <CardContent className="pt-5">
                        <SectionTitle><Sparkles size={11} className="mr-1.5 inline" />Skills loaded</SectionTitle>
                        <SkillTable skills={view.skills} />
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}
            </div>
          )}

          {/* context breakdown + agent × model */}
          {(cards.context || cards.agentModel) && (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.6fr]">
              {cards.context && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle><Layers size={11} className="mr-1.5 inline" />Context breakdown</SectionTitle>
                    <ContextBar context={view.context} />
                  </CardContent>
                </Card>
              )}
              {cards.agentModel && (
                <Card>
                  <CardContent className="pt-5">
                    <SectionTitle><Users size={11} className="mr-1.5 inline" />Agent × model — who used what</SectionTitle>
                    <AgentModelTable rows={view.agentModel} />
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}

          <footer className="mt-8 border-t border-border pt-4 text-[11px] text-muted-foreground">
            Real-time via SSE · split by project · cache savings &amp; cost shown at API pricing when your plan reports $0.
          </footer>
        </div>
      </div>
    </div>
  )
}

function SplitStat({ label, cost, est, calls }: { label: string; cost: number; est: number; calls: number }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <CostText cost={cost} est={est} className="mt-0.5 block text-base font-medium tabular-nums" />
      <div className="text-[11px] text-muted-foreground tabular-nums">{calls} calls</div>
    </div>
  )
}