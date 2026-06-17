import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Aggregator } from "../src/plugin/aggregator"
import { apiEquivalentCost } from "../src/plugin/pricing"
import type { UsageRecord } from "../src/plugin/types"

const ROOT = "/charts/root"
const DAY = 86_400_000

interface AInput {
	id: string
	sessionID: string
	providerID: string
	modelID: string
	cost: number
	tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
	path: { root: string }
	time: { created: number; completed?: number }
}
function assistant(o: Partial<AInput> & { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {}): AInput {
	const { input = 100, output = 50, cacheRead = 0, cacheWrite = 0, ...rest } = o
	return {
		id: "m1",
		sessionID: "ses_main",
		providerID: "anthropic",
		modelID: "claude-opus-4-8",
		cost: 0.1,
		tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: cacheWrite } },
		path: { root: ROOT },
		time: { created: 1_700_000_000_000 },
		...rest,
	}
}
function rec(o: Partial<AInput> & { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): UsageRecord {
	const a = assistant(o)
	return {
		messageID: a.id, sessionID: a.sessionID, projectRoot: ROOT, providerID: a.providerID, modelID: a.modelID,
		cost: a.cost, input: a.tokens.input, output: a.tokens.output, reasoning: a.tokens.reasoning,
		cacheRead: a.tokens.cache.read, cacheWrite: a.tokens.cache.write, estimated: a.cost === 0, createdAt: a.time.created,
	}
}

describe("activityByHour", () => {
	test("always 24 buckets; tokens and calls sum to the totals", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "a", input: 100, output: 0, time: { created: 1_700_000_000_000 } }))
		agg.ingestAssistant(assistant({ id: "b", input: 200, output: 0, time: { created: 1_700_000_000_000 + 5 * 3_600_000 } }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.activityByHour.length).toBe(24)
		expect(snap.activityByHour.reduce((s, b) => s + b.tokens, 0)).toBe(snap.totals.tokens)
		expect(snap.activityByHour.reduce((s, b) => s + b.calls, 0)).toBe(snap.totals.messages)
		snap.activityByHour.forEach((b, i) => expect(b.hour).toBe(i))
	})
})

describe("tokensByDay", () => {
	test("buckets per day, sorted, channels sum to totals", () => {
		const agg = new Aggregator()
		const base = 1_700_000_000_000
		agg.ingestAssistant(assistant({ id: "d1a", input: 100, cacheRead: 10, time: { created: base } }))
		agg.ingestAssistant(assistant({ id: "d1b", input: 50, output: 20, time: { created: base + 3_600_000 } }))
		agg.ingestAssistant(assistant({ id: "d2", input: 70, cacheWrite: 5, time: { created: base + 2 * DAY } }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.tokensByDay.length).toBe(2)
		expect(snap.tokensByDay[0]!.day).toBeLessThan(snap.tokensByDay[1]!.day)
		expect(snap.tokensByDay.reduce((s, d) => s + d.input, 0)).toBe(snap.totals.input)
		expect(snap.tokensByDay.reduce((s, d) => s + d.cacheRead, 0)).toBe(snap.totals.cacheRead)
		expect(snap.tokensByDay.reduce((s, d) => s + d.cacheWrite, 0)).toBe(snap.totals.cacheWrite)
	})
})

describe("spendByModel", () => {
	test("caps to top-6 models + 'other' and conserves total spend", () => {
		const agg = new Aggregator()
		const base = 1_700_000_000_000
		// 8 distinct models → top 6 + other
		for (let i = 0; i < 8; i++) {
			agg.ingestAssistant(assistant({ id: `m${i}`, modelID: `model-${i}`, providerID: "p", cost: (i + 1) / 10, time: { created: base + i * 60_000 } }))
		}
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.spendByModel.models).toContain("other")
		expect(snap.spendByModel.models.length).toBe(7) // 6 + other
		const summed = snap.spendByModel.points.reduce((s, pt) => {
			for (const m of snap.spendByModel.models) s += (pt as Record<string, number>)[m] ?? 0
			return s
		}, 0)
		const expected = [...Array(8).keys()].reduce((s, i) => s + (i + 1) / 10, 0)
		expect(summed).toBeCloseTo(expected, 6)
	})

	test("empty when there are no records", () => {
		expect(new Aggregator().computeSnapshot(ROOT).spendByModel).toEqual({ models: [], points: [] })
	})
})

describe("chart aggregation fuzzing", () => {
	const recArb = fc.record({
		id: fc.stringMatching(/^m[0-9]{1,4}$/),
		modelID: fc.constantFrom("claude-opus-4-8", "claude-haiku-4-5", "gpt-5", "deepseek-v3", "model-x", "model-y", "model-z", "model-w"),
		cost: fc.double({ min: 0, max: 5, noNaN: true }),
		input: fc.integer({ min: 0, max: 100_000 }),
		output: fc.integer({ min: 0, max: 100_000 }),
		cacheRead: fc.integer({ min: 0, max: 100_000 }),
		cacheWrite: fc.integer({ min: 0, max: 100_000 }),
		created: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
	})

	test("invariants hold and nothing throws", () => {
		fc.assert(
			fc.property(fc.array(recArb, { maxLength: 50 }), (rows) => {
				const agg = new Aggregator()
				const recs: UsageRecord[] = []
				for (const r of rows) {
					agg.ingestAssistant(assistant({ id: r.id, modelID: r.modelID, providerID: "p", cost: r.cost, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, time: { created: r.created } }))
					recs.push(rec({ id: r.id, modelID: r.modelID, providerID: "p", cost: r.cost, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, time: { created: r.created } }))
				}
				const dedup = new Map(recs.map((r) => [r.messageID, r]))
				const snap = agg.computeSnapshot(ROOT)

				expect(snap.activityByHour.length).toBe(24)
				expect(snap.activityByHour.reduce((s, b) => s + b.tokens, 0)).toBe(snap.totals.tokens)
				expect(snap.spendByModel.models.length).toBeLessThanOrEqual(7)

				const summed = snap.spendByModel.points.reduce((s, pt) => {
					for (const m of snap.spendByModel.models) s += (pt as Record<string, number>)[m] ?? 0
					return s
				}, 0)
				const expected = [...dedup.values()].reduce((s, r) => s + apiEquivalentCost(r), 0)
				expect(Math.abs(summed - expected)).toBeLessThanOrEqual(1e-6 * (1 + Math.abs(expected)))
			}),
			{ numRuns: 250 },
		)
	})
})
