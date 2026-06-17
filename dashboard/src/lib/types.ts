// Mirror of the plugin's snapshot shapes (src/plugin/types.ts).
export interface Totals {
  cost: number
  estimatedCost: number
  tokens: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  messages: number
  sessions: number
  errors: number
  retries: number
}
export interface ModelAgg {
  model: string
  providerID: string
  modelID: string
  cost: number
  estimatedCost: number
  tokens: number
  messages: number
  errors: number
}
export interface SessionAgg {
  sessionID: string
  parentID?: string
  title?: string
  agent?: string
  model?: string
  isSubagent: boolean
  cost: number
  estimatedCost: number
  tokens: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  messages: number
  startedAt: number
  lastActivity: number
  durationMs: number
  errors: number
  retries: number
}
export interface ToolAgg {
  tool: string
  count: number
  outputTokens: number
  schemaTokens: number
  complexity: "simple" | "complex" | "unknown"
  totalDurationMs: number
  errors: number
}
export interface SkillAgg {
  name: string
  count: number
  tokens: number
}
export interface AgentModelAgg {
  agent: string
  model: string
  cost: number
  estimatedCost: number
  tokens: number
  messages: number
}
export interface ContextBreakdown {
  systemPrompt: number
  toolDefinitions: number
  environment: number
  projectTree: number
  customInstructions: number
  other: number
  total: number
}
export interface SplitAgg {
  cost: number
  estimatedCost: number
  tokens: number
  apiCalls: number
}
export interface Split {
  main: SplitAgg
  subagents: SplitAgg
}
export interface CacheMetrics {
  hitRate: number
  withoutCachingCost: number
  savings: number
  effectiveRatePerM: number
}
export interface SeriesPoint {
  t: number
  cost: number
  tokens: number
}
export interface HourBucket {
  hour: number
  tokens: number
  cost: number
  calls: number
}
export interface DayTokens {
  day: number
  input: number
  cacheRead: number
  output: number
  cacheWrite: number
}
export interface ModelSeries {
  models: string[]
  points: Array<{ t: number; [model: string]: number }>
}
export interface ProjectSnapshot {
  projectKey: string
  projectRoot: string
  projectName: string
  updatedAt: number
  totals: Totals
  apiCalls: number
  cache: CacheMetrics
  split: Split
  models: ModelAgg[]
  sessions: SessionAgg[]
  tools: ToolAgg[]
  skills: SkillAgg[]
  agentModel: AgentModelAgg[]
  context: ContextBreakdown
  series: SeriesPoint[]
  activityByHour: HourBucket[]
  tokensByDay: DayTokens[]
  spendByModel: ModelSeries
}
export interface GlobalSnapshot {
  updatedAt: number
  totals: Totals
  apiCalls: number
  projects: ProjectSnapshot[]
}
