/**
 * In-memory usage aggregation for the project(s) this opencode instance touches.
 *
 * Sources (all from plugin events, no polling):
 *   - assistant message.updated  -> billing record (deduped by message id)
 *   - session.created/updated     -> tree metadata (parentID, title)
 *   - tool / agent message parts  -> tool-call counts, agent name per session
 *
 * On each ingest we debounce a per-project flush that recomputes the snapshot, persists
 * it, and pokes the change bus so SSE clients refresh.
 */

import { config, projectKey, projectName } from "./config"
import { apiEquivalentCost, estimateCost, withoutCachingCost } from "./pricing"
import type { Bus } from "./store"
import { loadRecords, writeRecords, writeSnapshot } from "./store"
import { estimateTokens } from "./tokenizer"
import {
	type AgentModelAgg,
	type ContextBreakdown,
	type DayTokens,
	emptyContext,
	emptyTotals,
	type HourBucket,
	type ModelAgg,
	type ModelSeries,
	type ProjectSnapshot,
	type SeriesPoint,
	type SessionAgg,
	type SessionMeta,
	type SkillAgg,
	type ToolAgg,
	type UsageRecord,
} from "./types"

/** Minimal view of card settings the aggregator needs to gate (heavy) computations. */
interface CardGate {
	enabled(id: string): boolean
}

type ContextComponent = "systemPrompt" | "environment" | "projectTree" | "customInstructions" | "other"

/** Best-effort label for a system-prompt segment by its content markers. */
export function classifySegment(text: string): ContextComponent {
	const t = text.toLowerCase()
	if (/cwd|working directory|today'?s date|platform|operating system|<env|environment\b/.test(t)) return "environment"
	if (/directory structure|file tree|project (tree|structure)|<project|files in the|repository structure/.test(t))
		return "projectTree"
	if (/agents?\.md|claude\.md|opencode\.md|\.cursorrules|custom instruction|user'?s instructions/.test(t))
		return "customInstructions"
	return "systemPrompt"
}

/** Classify a tool's JSON-schema parameters as simple (flat scalars) or complex. */
export function schemaComplexity(parameters: unknown): "simple" | "complex" | "unknown" {
	if (parameters == null) return "unknown"
	let json: string
	try {
		json = JSON.stringify(parameters)
	} catch {
		return "unknown"
	}
	if (!json) return "unknown"
	if (/"type"\s*:\s*"(array|object)"/.test(json)) return "complex"
	const props = (json.match(/"properties"/g) ?? []).length
	return props > 1 ? "complex" : "simple"
}

const FLUSH_DEBOUNCE_MS = 400
const MAX_SERIES_POINTS = 500

/**
 * opencode sets a message's `path.root` to the worktree, which is the git root for git
 * projects but degenerates to "/" (or empty) for non-git directories — collapsing every
 * non-git project onto one key. Reject those so we can fall back to the real directory.
 */
function normalizeRoot(root: string | undefined): string | undefined {
	if (!root) return undefined
	const t = root.trim()
	if (!t || t === "/" || t === "\\" || t === "." || /^[A-Za-z]:[\\/]?$/.test(t)) return undefined
	return t
}

interface AssistantInput {
	id: string
	sessionID: string
	providerID: string
	modelID: string
	cost: number
	tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
	path: { root: string }
	time: { created: number; completed?: number }
	error?: { name?: string } | null
}

export class Aggregator {
	private records = new Map<string, UsageRecord>()
	private sessionMeta = new Map<string, SessionMeta>()
	private sessionRoot = new Map<string, string>()
	private toolCalls = new Map<string, { tool: string; sessionID: string; outputTokens: number; durationMs: number; error: boolean; done: boolean }>()
	private toolDefs = new Map<string, { schemaTokens: number; complexity: "simple" | "complex" | "unknown" }>()
	private skillCalls = new Map<string, { name: string; sessionID: string; tokens: number }>()
	private retriesBySession = new Map<string, number>()
	private systemBySession = new Map<string, Record<ContextComponent, number>>()
	private loadedRoots = new Set<string>()
	private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()

	/** @param fallbackRoot the plugin's own project directory, used when path.root degenerates to "/". */
	constructor(
		private readonly bus?: Bus,
		private readonly fallbackRoot?: string,
		private readonly settings?: CardGate,
	) {}

	/** A card (and its computation) is on unless settings explicitly disable it. */
	private on(id: string): boolean {
		return this.settings ? this.settings.enabled(id) : true
	}

	/** Ingest a completed/streaming assistant message. */
	ingestAssistant(info: AssistantInput): void {
		const root = normalizeRoot(info.path?.root) ?? normalizeRoot(this.fallbackRoot)
		if (!root) return
		void this.ensureLoaded(root)
		this.sessionRoot.set(info.sessionID, root)

		const record: UsageRecord = {
			messageID: info.id,
			sessionID: info.sessionID,
			projectRoot: root,
			providerID: info.providerID,
			modelID: info.modelID,
			cost: info.cost,
			input: info.tokens.input,
			output: info.tokens.output,
			reasoning: info.tokens.reasoning,
			cacheRead: info.tokens.cache.read,
			cacheWrite: info.tokens.cache.write,
			// `cost` stays exactly what opencode reported (real money: 0 for free/subscription).
			// The API-equivalent estimate is computed separately in buildSnapshot and shown as
			// a clearly-labeled secondary figure — never conflated with real spend.
			estimated: info.cost === 0,
			error: info.error?.name ?? undefined,
			createdAt: info.time.created,
			completedAt: info.time.completed,
		}
		this.records.set(record.messageID, record)
		this.scheduleFlush(root)
	}

	/** Ingest session metadata for the subagent tree. */
	ingestSession(info: { id: string; parentID?: string; title?: string; directory?: string }): void {
		const prev = this.sessionMeta.get(info.id)
		this.sessionMeta.set(info.id, {
			sessionID: info.id,
			parentID: info.parentID ?? prev?.parentID,
			title: info.title ?? prev?.title,
			agent: prev?.agent,
			projectRoot: this.sessionRoot.get(info.id) ?? info.directory ?? prev?.projectRoot,
		})
		const root = this.sessionRoot.get(info.id)
		if (root) this.scheduleFlush(root)
	}

	/** Record the agent name that owns a session (from an `agent` message part). */
	ingestAgent(sessionID: string, name: string): void {
		const prev = this.sessionMeta.get(sessionID)
		this.sessionMeta.set(sessionID, {
			sessionID,
			parentID: prev?.parentID,
			title: prev?.title,
			agent: name,
			projectRoot: prev?.projectRoot ?? this.sessionRoot.get(sessionID),
		})
	}

	/**
	 * Count a tool invocation (deduped by callID). When the tool part has completed,
	 * `result` carries the estimated output tokens + wall-clock duration, recorded once.
	 */
	ingestTool(
		callID: string,
		tool: string,
		sessionID: string,
		result?: { outputTokens: number; durationMs: number; error?: boolean },
	): void {
		let entry = this.toolCalls.get(callID)
		if (!entry) {
			entry = { tool, sessionID, outputTokens: 0, durationMs: 0, error: false, done: false }
			this.toolCalls.set(callID, entry)
		}
		if (result && !entry.done) {
			entry.outputTokens = result.outputTokens
			entry.durationMs = result.durationMs
			entry.error = result.error ?? false
			entry.done = true
		}
		const root = this.sessionRoot.get(sessionID)
		if (root) this.scheduleFlush(root)
	}

	/** Record a loaded skill (the `skill` tool), deduped by callID. */
	ingestSkill(callID: string, name: string, sessionID: string, tokens: number): void {
		if (this.skillCalls.has(callID)) return
		this.skillCalls.set(callID, { name, sessionID, tokens })
		const root = this.sessionRoot.get(sessionID)
		if (root) this.scheduleFlush(root)
	}

	/** Count a provider retry attempt for a session (from a `retry` message part). */
	ingestRetry(sessionID: string): void {
		this.retriesBySession.set(sessionID, (this.retriesBySession.get(sessionID) ?? 0) + 1)
		const root = this.sessionRoot.get(sessionID)
		if (root) this.scheduleFlush(root)
	}

	/** Record a tool's schema size + complexity (from the tool.definition hook). */
	ingestToolDef(toolID: string, description: string, parameters: unknown): void {
		const schemaTokens = estimateTokens(`${description ?? ""} ${safeJson(parameters)}`)
		this.toolDefs.set(toolID, { schemaTokens, complexity: schemaComplexity(parameters) })
	}

	/** Record the system-prompt composition for a session (from the system.transform hook). */
	ingestSystemPrompt(sessionID: string | undefined, segments: ReadonlyArray<string>): void {
		if (!sessionID) return
		const buckets: Record<ContextComponent, number> = {
			systemPrompt: 0,
			environment: 0,
			projectTree: 0,
			customInstructions: 0,
			other: 0,
		}
		for (const seg of segments) buckets[classifySegment(seg)] += estimateTokens(seg)
		this.systemBySession.set(sessionID, buckets)
		const root = this.sessionRoot.get(sessionID)
		if (root) this.scheduleFlush(root)
	}

	/** Drop all in-memory state for one project (by its 16-hex key) so a deleted file isn't re-flushed. */
	forget(key: string): void {
		const dead = new Set<string>()
		for (const [sid, root] of this.sessionRoot) if (projectKey(root) === key) dead.add(sid)
		for (const r of this.records.values()) if (projectKey(r.projectRoot) === key) dead.add(r.sessionID)
		for (const [id, r] of this.records) if (projectKey(r.projectRoot) === key) this.records.delete(id)
		for (const sid of dead) {
			this.sessionRoot.delete(sid)
			this.sessionMeta.delete(sid)
			this.systemBySession.delete(sid)
		}
		for (const [cid, t] of this.toolCalls) if (dead.has(t.sessionID)) this.toolCalls.delete(cid)
		for (const [cid, sk] of this.skillCalls) if (dead.has(sk.sessionID)) this.skillCalls.delete(cid)
		for (const sid of dead) this.retriesBySession.delete(sid)
		for (const [root, timer] of this.flushTimers) {
			if (projectKey(root) === key) {
				clearTimeout(timer)
				this.flushTimers.delete(root)
			}
		}
		for (const root of this.loadedRoots) if (projectKey(root) === key) this.loadedRoots.delete(root)
	}

	/** Drop all in-memory state for every project. */
	forgetAll(): void {
		for (const timer of this.flushTimers.values()) clearTimeout(timer)
		this.flushTimers.clear()
		this.records.clear()
		this.sessionMeta.clear()
		this.sessionRoot.clear()
		this.systemBySession.clear()
		this.toolCalls.clear()
		this.toolDefs.clear()
		this.skillCalls.clear()
		this.retriesBySession.clear()
		this.loadedRoots.clear()
	}

	/** Compute the project snapshot from current in-memory state without persisting. */
	computeSnapshot(root: string): ProjectSnapshot {
		const recs = [...this.records.values()].filter((r) => r.projectRoot === root)
		return this.buildSnapshot(root, recs)
	}

	private async ensureLoaded(root: string): Promise<void> {
		if (this.loadedRoots.has(root)) return
		this.loadedRoots.add(root)
		const persisted = await loadRecords(root)
		for (const rec of persisted) {
			if (!this.records.has(rec.messageID)) this.records.set(rec.messageID, rec)
			this.sessionRoot.set(rec.sessionID, rec.projectRoot)
		}
	}

	private scheduleFlush(root: string): void {
		const existing = this.flushTimers.get(root)
		if (existing) clearTimeout(existing)
		this.flushTimers.set(
			root,
			setTimeout(() => {
				this.flushTimers.delete(root)
				void this.flush(root)
			}, FLUSH_DEBOUNCE_MS),
		)
	}

	private async flush(root: string): Promise<void> {
		const recs = [...this.records.values()].filter((r) => r.projectRoot === root)
		const snapshot = this.buildSnapshot(root, recs)
		try {
			await writeRecords(root, recs)
			await writeSnapshot(snapshot)
		} catch {
			// disk hiccup — next event retries
		}
		this.bus?.emit()
	}

	private buildSnapshot(root: string, recs: UsageRecord[]): ProjectSnapshot {
		const totals = emptyTotals()
		const models = new Map<string, ModelAgg>()
		const sessions = new Map<string, SessionAgg>()
		let withoutCache = 0
		let tableWith = 0

		for (const r of recs) {
			const estCost = apiEquivalentCost(r)
			totals.cost += r.cost
			totals.estimatedCost += estCost
			totals.input += r.input
			totals.output += r.output
			totals.reasoning += r.reasoning
			totals.cacheRead += r.cacheRead
			totals.cacheWrite += r.cacheWrite
			totals.messages += 1
			// Cache-savings = real money only: count it solely where opencode actually billed a
			// per-token cost (paid API). Free, self-hosted and subscription usage (cost 0) save
			// you nothing real, so they contribute $0 — no phantom savings.
			if (r.cost > 0) {
				withoutCache += withoutCachingCost(r)
				tableWith += estimateCost(r)
			}

			const recTokens = r.input + r.output + r.cacheRead + r.cacheWrite
			const modelKey = `${r.providerID}/${r.modelID}`
			const m = models.get(modelKey) ?? {
				model: modelKey,
				providerID: r.providerID,
				modelID: r.modelID,
				cost: 0,
				estimatedCost: 0,
				tokens: 0,
				messages: 0,
				errors: 0,
			}
			m.cost += r.cost
			m.estimatedCost += estCost
			m.tokens += recTokens
			m.messages += 1
			if (r.error) {
				m.errors += 1
				totals.errors += 1
			}
			models.set(modelKey, m)

			const meta = this.sessionMeta.get(r.sessionID)
			const s = sessions.get(r.sessionID) ?? {
				sessionID: r.sessionID,
				parentID: meta?.parentID,
				title: meta?.title,
				agent: meta?.agent,
				model: modelKey,
				isSubagent: Boolean(meta?.parentID),
				cost: 0,
				estimatedCost: 0,
				tokens: 0,
				input: 0,
				output: 0,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				messages: 0,
				startedAt: r.createdAt,
				lastActivity: 0,
				durationMs: 0,
				errors: 0,
				retries: 0,
			}
			s.cost += r.cost
			s.estimatedCost += estCost
			if (r.error) s.errors += 1
			s.tokens += recTokens
			s.input += r.input
			s.output += r.output
			s.reasoning += r.reasoning
			s.cacheRead += r.cacheRead
			s.cacheWrite += r.cacheWrite
			s.messages += 1
			s.model = modelKey
			s.startedAt = Math.min(s.startedAt, r.createdAt)
			s.lastActivity = Math.max(s.lastActivity, r.completedAt ?? r.createdAt)
			s.durationMs = Math.max(0, s.lastActivity - s.startedAt)
			// metadata may have arrived after the first record for this session
			s.parentID = meta?.parentID ?? s.parentID
			s.title = meta?.title ?? s.title
			s.agent = meta?.agent ?? s.agent
			s.isSubagent = Boolean(s.parentID)
			sessions.set(r.sessionID, s)
		}

		totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
		totals.sessions = sessions.size
		// retries are tracked per session (from retry parts), independent of records
		for (const [sid, s] of sessions) {
			s.retries = this.retriesBySession.get(sid) ?? 0
			totals.retries += s.retries
		}

		// main vs subagents
		const split = {
			main: { cost: 0, estimatedCost: 0, tokens: 0, apiCalls: 0 },
			subagents: { cost: 0, estimatedCost: 0, tokens: 0, apiCalls: 0 },
		}
		for (const s of sessions.values()) {
			const bucket = s.isSubagent ? split.subagents : split.main
			bucket.cost += s.cost
			bucket.estimatedCost += s.estimatedCost
			bucket.tokens += s.tokens
			bucket.apiCalls += s.messages
		}

		// cache efficiency
		const freshPlusCache = totals.cacheRead + totals.input
		const hitRate = freshPlusCache > 0 ? totals.cacheRead / freshPlusCache : 0
		const savings = Math.max(0, withoutCache - tableWith)
		const effectiveRatePerM = totals.tokens > 0 ? (totals.cost / totals.tokens) * 1_000_000 : 0

		// tool usage (only tools whose session belongs to this project): count + output
		// tokens + wall-clock, enriched with the captured schema size/complexity.
		let tools: ToolAgg[] = []
		if (this.on("tools")) {
			const toolAgg = new Map<string, ToolAgg>()
			for (const { tool, sessionID, outputTokens, durationMs, error } of this.toolCalls.values()) {
				if (this.sessionRoot.get(sessionID) !== root) continue
				const def = this.toolDefs.get(tool)
				const t = toolAgg.get(tool) ?? {
					tool,
					count: 0,
					outputTokens: 0,
					schemaTokens: def?.schemaTokens ?? 0,
					complexity: def?.complexity ?? "unknown",
					totalDurationMs: 0,
					errors: 0,
				}
				t.count += 1
				t.outputTokens += outputTokens
				t.totalDurationMs += durationMs
				if (error) t.errors += 1
				toolAgg.set(tool, t)
			}
			tools = [...toolAgg.values()].sort((a, b) => b.count - a.count)
		}

		// skills loaded (via the `skill` tool), scoped to this project
		let skills: SkillAgg[] = []
		if (this.on("skills")) {
			const skillAgg = new Map<string, SkillAgg>()
			for (const { name, sessionID, tokens } of this.skillCalls.values()) {
				if (this.sessionRoot.get(sessionID) !== root) continue
				const sk = skillAgg.get(name) ?? { name, count: 0, tokens: 0 }
				sk.count += 1
				sk.tokens += tokens
				skillAgg.set(name, sk)
			}
			skills = [...skillAgg.values()].sort((a, b) => b.count - a.count || b.tokens - a.tokens)
		}

		// agent × model cross-breakdown — who used what.
		let agentModel: AgentModelAgg[] = []
		if (this.on("agentModel")) {
			const agentModelMap = new Map<string, AgentModelAgg>()
			for (const r of recs) {
				const meta = this.sessionMeta.get(r.sessionID)
				const agent = meta?.agent ?? (meta?.parentID ? "subagent" : "main")
				const model = `${r.providerID}/${r.modelID}`
				const key = `${agent} ${model}`
				const am = agentModelMap.get(key) ?? { agent, model, cost: 0, estimatedCost: 0, tokens: 0, messages: 0 }
				am.cost += r.cost
				am.estimatedCost += apiEquivalentCost(r)
				am.tokens += r.input + r.output + r.cacheRead + r.cacheWrite
				am.messages += 1
				agentModelMap.set(key, am)
			}
			agentModel = [...agentModelMap.values()].sort((a, b) => b.cost - a.cost)
		}

		// context breakdown: the system-prompt composition (any session in this root,
		// preferring a main session) plus the standing tool-definition cost.
		const context = this.on("context") ? this.contextFor(root, sessions) : emptyContext()

		return {
			projectKey: projectKey(root),
			projectRoot: root,
			projectName: projectName(root),
			updatedAt: Date.now(),
			totals,
			apiCalls: totals.messages,
			cache: { hitRate, withoutCachingCost: withoutCache, savings, effectiveRatePerM },
			split,
			models: [...models.values()].sort((a, b) => b.cost - a.cost),
			sessions: [...sessions.values()].sort((a, b) => b.cost - a.cost),
			tools,
			skills,
			agentModel,
			context,
			series: this.on("spend") ? buildSeries(recs) : [],
			activityByHour: this.on("activityByHour") ? buildActivityByHour(recs) : [],
			tokensByDay: this.on("tokensByDay") ? buildTokensByDay(recs) : [],
			spendByModel: this.on("spendByModel") ? buildSeriesByModel(recs) : { models: [], points: [] },
		}
	}

	/** Assemble the context breakdown for a project from captured system prompts + tool defs. */
	private contextFor(root: string, sessions: Map<string, SessionAgg>): ContextBreakdown {
		const ctx = emptyContext()
		for (const def of this.toolDefs.values()) ctx.toolDefinitions += def.schemaTokens

		// Prefer a main session's system prompt; fall back to any session in this root.
		const candidates = [...sessions.values()]
			.filter((s) => this.systemBySession.has(s.sessionID))
			.sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent))
		const buckets = candidates.length ? this.systemBySession.get(candidates[0]!.sessionID) : undefined
		if (buckets) {
			ctx.systemPrompt = buckets.systemPrompt
			ctx.environment = buckets.environment
			ctx.projectTree = buckets.projectTree
			ctx.customInstructions = buckets.customInstructions
			ctx.other = buckets.other
		}
		ctx.total =
			ctx.systemPrompt + ctx.toolDefinitions + ctx.environment + ctx.projectTree + ctx.customInstructions + ctx.other
		return ctx
	}
}

/** JSON.stringify that never throws (returns "" on cyclic / unserializable input). */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? ""
	} catch {
		return ""
	}
}

const startOfDayMs = (ts: number) => {
	const d = new Date(ts)
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Usage bucketed by hour-of-day (0–23, local time). Always 24 buckets. */
function buildActivityByHour(recs: UsageRecord[]): HourBucket[] {
	const buckets: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, cost: 0, calls: 0 }))
	for (const r of recs) {
		const b = buckets[new Date(r.createdAt).getHours()]!
		b.tokens += r.input + r.output + r.cacheRead + r.cacheWrite
		b.cost += r.cost
		b.calls += 1
	}
	return buckets
}

/** Token channels bucketed per calendar day (most recent 90 days). */
function buildTokensByDay(recs: UsageRecord[]): DayTokens[] {
	const map = new Map<number, DayTokens>()
	for (const r of recs) {
		const day = startOfDayMs(r.createdAt)
		const e = map.get(day) ?? { day, input: 0, cacheRead: 0, output: 0, cacheWrite: 0 }
		e.input += r.input
		e.cacheRead += r.cacheRead
		e.output += r.output
		e.cacheWrite += r.cacheWrite
		map.set(day, e)
	}
	return [...map.values()].sort((a, b) => a.day - b.day).slice(-90)
}

/**
 * Per-minute *incremental* spend (API-equivalent) split across the top-6 models + "other".
 * Incremental (not cumulative) so the dashboard can cumulate and merge across projects.
 */
function buildSeriesByModel(recs: UsageRecord[]): ModelSeries {
	if (recs.length === 0) return { models: [], points: [] }
	const weight = new Map<string, number>()
	for (const r of recs) {
		const k = `${r.providerID}/${r.modelID}`
		weight.set(k, (weight.get(k) ?? 0) + apiEquivalentCost(r))
	}
	const ranked = [...weight.keys()].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))
	const top = ranked.slice(0, 6)
	const topSet = new Set(top)
	const models = ranked.length > top.length ? [...top, "other"] : [...top]

	const byMinute = new Map<number, Record<string, number>>()
	for (const r of recs) {
		const minute = Math.floor(r.createdAt / 60_000) * 60_000
		const k = `${r.providerID}/${r.modelID}`
		const key = topSet.has(k) ? k : "other"
		const slot = byMinute.get(minute) ?? {}
		slot[key] = (slot[key] ?? 0) + apiEquivalentCost(r)
		byMinute.set(minute, slot)
	}
	const points = [...byMinute.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([t, slot]) => ({ t, ...slot }))
	return { models, points: points.length > MAX_SERIES_POINTS ? points.slice(-MAX_SERIES_POINTS) : points }
}

/** Bucket records into a cumulative cost/token series (per minute, capped). */
function buildSeries(recs: UsageRecord[]): SeriesPoint[] {
	if (recs.length === 0) return []
	const sorted = [...recs].sort((a, b) => a.createdAt - b.createdAt)
	const byMinute = new Map<number, { cost: number; tokens: number }>()
	for (const r of sorted) {
		const minute = Math.floor(r.createdAt / 60_000) * 60_000
		const slot = byMinute.get(minute) ?? { cost: 0, tokens: 0 }
		slot.cost += r.cost
		slot.tokens += r.input + r.output + r.cacheRead + r.cacheWrite
		byMinute.set(minute, slot)
	}
	let cumCost = 0
	let cumTokens = 0
	const points: SeriesPoint[] = []
	for (const [t, v] of [...byMinute.entries()].sort((a, b) => a[0] - b[0])) {
		cumCost += v.cost
		cumTokens += v.tokens
		points.push({ t, cost: cumCost, tokens: cumTokens })
	}
	return points.length > MAX_SERIES_POINTS ? points.slice(-MAX_SERIES_POINTS) : points
}
