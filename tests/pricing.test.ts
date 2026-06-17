import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { apiEquivalentCost, estimateCost, isFreeModel, rateFor, withoutCachingCost } from "../src/plugin/pricing"
import type { UsageRecord } from "../src/plugin/types"

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		messageID: "msg_1",
		sessionID: "ses_1",
		projectRoot: "/proj",
		providerID: "anthropic",
		modelID: "claude-opus-4-8",
		cost: 0,
		input: 1_000_000,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		estimated: false,
		createdAt: 0,
		...overrides,
	}
}

describe("rateFor", () => {
	test("matches a model family by case-insensitive substring", () => {
		expect(rateFor({ providerID: "anthropic", modelID: "claude-opus-4-8" })).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		})
		expect(rateFor({ providerID: "x", modelID: "Claude-SONNET-4-6" })?.output).toBe(15)
		expect(rateFor({ providerID: "openai", modelID: "GPT-5-mini" })?.input).toBe(1.25)
	})

	test("returns undefined for an unknown model", () => {
		expect(rateFor({ providerID: "acme", modelID: "totally-unknown-model" })).toBeUndefined()
	})
})

describe("estimateCost", () => {
	test("bills each channel at its per-1M rate", () => {
		// opus: input 5, output 25, cacheRead 0.5, cacheWrite 6.25 (USD / 1M)
		const cost = estimateCost(
			record({ input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000, cacheWrite: 1_000_000 }),
		)
		// 5 + 25 + (2 * 0.5) + 6.25 = 37.25
		expect(cost).toBeCloseTo(37.25, 6)
	})

	test("ignores reasoning tokens (not part of the table formula)", () => {
		const base = estimateCost(record({ input: 1_000_000, reasoning: 0 }))
		const withReasoning = estimateCost(record({ input: 1_000_000, reasoning: 9_999 }))
		expect(withReasoning).toBe(base)
	})

	test("returns 0 for an unknown model", () => {
		expect(estimateCost(record({ modelID: "totally-unknown-model", input: 1_000_000 }))).toBe(0)
	})
})

describe("isFreeModel", () => {
	test("detects a free token in the model id", () => {
		expect(isFreeModel("deepseek-v4-flash-free")).toBe(true)
		expect(isFreeModel("owl-alpha:free")).toBe(true)
		expect(isFreeModel("FREE-tier-model")).toBe(true)
		expect(isFreeModel("claude-opus-4-8")).toBe(false)
		expect(isFreeModel("freeform-model")).toBe(false) // "free" must be its own token
	})
})

describe("apiEquivalentCost", () => {
	test("returns the real cost when one was billed", () => {
		expect(apiEquivalentCost(record({ cost: 0.42 }))).toBeCloseTo(0.42, 9)
	})
	test("returns 0 for a free model even with tokens spent", () => {
		expect(apiEquivalentCost(record({ modelID: "deepseek-v4-flash-free", cost: 0, input: 1_000_000 }))).toBe(0)
	})
	test("estimates from the table for a subscription $0 record", () => {
		// opus, cost 0, 1M input → $5 at API rates
		expect(apiEquivalentCost(record({ cost: 0, input: 1_000_000 }))).toBeCloseTo(5, 6)
	})
})

describe("withoutCachingCost", () => {
	test("bills all input-side tokens at the full input rate, plus output+reasoning", () => {
		// opus input 5, output 25
		const cost = withoutCachingCost(
			record({ input: 500_000, cacheRead: 300_000, cacheWrite: 200_000, output: 100_000, reasoning: 100_000 }),
		)
		// inputSide = 1_000_000 * 5 = 5 ; (output+reasoning)=200_000 * 25 = 5 ; total 10
		expect(cost).toBeCloseTo(10, 6)
	})

	test("returns 0 for an unknown model so savings stays neutral", () => {
		expect(withoutCachingCost(record({ modelID: "totally-unknown-model" }))).toBe(0)
	})
})

describe("pricing fuzzing", () => {
	const tokens = () => fc.integer({ min: 0, max: 50_000_000 })
	const knownModel = fc.constantFrom("claude-opus-4-8", "claude-sonnet-4-6", "gpt-5", "gemini-2.5", "deepseek-v3")

	const recordArb = fc
		.record({
			modelID: knownModel,
			input: tokens(),
			output: tokens(),
			reasoning: tokens(),
			cacheRead: tokens(),
			cacheWrite: tokens(),
		})
		.map((p) => record(p))

	test("estimateCost is always a finite, non-negative number", () => {
		fc.assert(
			fc.property(recordArb, (r) => {
				const c = estimateCost(r)
				expect(Number.isFinite(c)).toBe(true)
				expect(c).toBeGreaterThanOrEqual(0)
			}),
			{ numRuns: 500 },
		)
	})

	test("withoutCachingCost is always a finite, non-negative number", () => {
		fc.assert(
			fc.property(recordArb, (r) => {
				const c = withoutCachingCost(r)
				expect(Number.isFinite(c)).toBe(true)
				expect(c).toBeGreaterThanOrEqual(0)
			}),
			{ numRuns: 500 },
		)
	})

	test("never throws on arbitrary provider/model strings", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (providerID, modelID) => {
				const r = record({ providerID, modelID })
				expect(() => {
					rateFor(r)
					estimateCost(r)
					withoutCachingCost(r)
				}).not.toThrow()
			}),
			{ numRuns: 500 },
		)
	})
})
