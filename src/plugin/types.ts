/**
 * Shared data shapes for the usage pipeline.
 *
 * A UsageRecord is one assistant message's billing snapshot (deduped by message id).
 * Everything the dashboard renders is derived from a set of UsageRecords + session/tool
 * metadata. The derived per-project view is a ProjectSnapshot; the merged cross-project
 * view served to the dashboard is a GlobalSnapshot.
 */

export interface UsageRecord {
	messageID: string
	sessionID: string
	projectRoot: string
	providerID: string
	modelID: string
	cost: number
	input: number
	output: number
	reasoning: number
	cacheRead: number
	cacheWrite: number
	/** True when `cost` was estimated locally (subscription plans report cost 0). */
	estimated: boolean
	/** Error class name when the assistant message failed (e.g. "APIError", "MessageAbortedError"). */
	error?: string
	createdAt: number
	completedAt?: number
}

export interface SessionMeta {
	sessionID: string
	parentID?: string
	title?: string
	agent?: string
	projectRoot?: string
}

export interface Totals {
	cost: number
	/** API-equivalent value: real cost where billed, table estimate for subscription $0, 0 for free. */
	estimatedCost: number
	tokens: number
	input: number
	output: number
	reasoning: number
	cacheRead: number
	cacheWrite: number
	messages: number
	sessions: number
	/** Assistant messages that ended in an error. */
	errors: number
	/** Provider retry attempts observed. */
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
	/** First observed activity for this session (ms epoch). */
	startedAt: number
	lastActivity: number
	/** lastActivity − startedAt, the wall-clock window the session has been active. */
	durationMs: number
	errors: number
	retries: number
}

export interface ToolAgg {
	tool: string
	count: number
	/** Estimated tokens emitted by this tool's outputs (attribution, not billing). */
	outputTokens: number
	/** Estimated tokens of the tool's schema/definition (its standing context cost). */
	schemaTokens: number
	/** Schema shape: arrays/objects/nested → "complex", flat scalars → "simple". */
	complexity: "simple" | "complex" | "unknown"
	/** Total wall-clock spent running this tool (ms), summed over completed calls. */
	totalDurationMs: number
	/** Calls that ended in an error state. */
	errors: number
}

/** Which skills were loaded (via the `skill` tool) and how heavy they were. */
export interface SkillAgg {
	name: string
	count: number
	/** Estimated tokens of skill content loaded into context. */
	tokens: number
}

/** Who used what model: cost/usage per (agent, model) pair. */
export interface AgentModelAgg {
	agent: string
	model: string
	cost: number
	estimatedCost: number
	tokens: number
	messages: number
}

/**
 * Where the input/context tokens go. All values are estimates from the system prompt
 * segments + captured tool schemas (see tokenizer.ts).
 */
export interface ContextBreakdown {
	systemPrompt: number
	toolDefinitions: number
	environment: number
	projectTree: number
	customInstructions: number
	other: number
	total: number
}

export function emptyContext(): ContextBreakdown {
	return { systemPrompt: 0, toolDefinitions: 0, environment: 0, projectTree: 0, customInstructions: 0, other: 0, total: 0 }
}

export interface SplitAgg {
	cost: number
	estimatedCost: number
	tokens: number
	apiCalls: number
}

/** Main session vs. spawned subagents. */
export interface Split {
	main: SplitAgg
	subagents: SplitAgg
}

/** Cache-efficiency analysis: what caching saved versus paying full input price. */
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

/** Usage bucketed by hour-of-day (0–23, local time). */
export interface HourBucket {
	hour: number
	tokens: number
	cost: number
	calls: number
}

/** Token channels bucketed per calendar day (ms epoch at local midnight). */
export interface DayTokens {
	day: number
	input: number
	cacheRead: number
	output: number
	cacheWrite: number
}

/**
 * Per-minute spend split across the top models (+ "other"), as *incremental* dollars per
 * bucket. The dashboard cumulates client-side (and can merge across projects by summing
 * increments). `apiEquivalentCost` is used so subscription usage isn't flat.
 */
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

export function emptyTotals(): Totals {
	return {
		cost: 0,
		estimatedCost: 0,
		tokens: 0,
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		messages: 0,
		sessions: 0,
		errors: 0,
		retries: 0,
	}
}
