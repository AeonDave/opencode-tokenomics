/**
 * Cost fallback + rate lookup.
 *
 * OpenCode already attaches a computed `cost` to each assistant message, so we use
 * that whenever it is > 0. But subscription/zen plans report `cost: 0` even though
 * tokens were spent — for those we estimate from a small per-1M-token price table so
 * the dashboard still shows a meaningful "what this would cost on API pricing" number.
 *
 * Rates are also used for the cache-efficiency analysis (the hypothetical "what this
 * would have cost with no caching"), so we expose a synchronous `rateFor()`.
 *
 * Prices are USD per 1M tokens. Override/extend via {dataDir}/pricing.json:
 *   { "anthropic/claude-opus-4-8": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }
 * Keys match first by exact "provider/model", then by case-insensitive substring of the model id.
 */

import { config } from "./config"
import type { UsageRecord } from "./types"

export interface Rate {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

// Conservative defaults for common families. Matched by substring of the model id.
const DEFAULT_RATES: Record<string, Rate> = {
	opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
	"gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
	"gpt-4": { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
	glm: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.6 },
	kimi: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },
	deepseek: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
	qwen: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
	gemini: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.25 },
}

let table: Record<string, Rate> = { ...DEFAULT_RATES }

/** Load user pricing overrides once at startup. Safe to call repeatedly. */
export async function initPricing(): Promise<void> {
	try {
		const file = Bun.file(config.pricingFile)
		if (await file.exists()) {
			const overrides = (await file.json()) as Record<string, Rate>
			table = { ...DEFAULT_RATES, ...overrides }
		}
	} catch {
		// keep defaults
	}
}

/** Resolve the price rate for a record's model, or undefined when unknown. */
export function rateFor(record: Pick<UsageRecord, "providerID" | "modelID">): Rate | undefined {
	const exact = table[`${record.providerID}/${record.modelID}`]
	if (exact) return exact
	const id = record.modelID.toLowerCase()
	for (const [key, rate] of Object.entries(table)) {
		if (id.includes(key.toLowerCase())) return rate
	}
	return undefined
}

/** True for models that are genuinely free (name carries a `free` token), e.g. `deepseek-v4-flash-free`, `…:free`. */
export function isFreeModel(modelID: string): boolean {
	return /\bfree\b/i.test(modelID)
}

/**
 * Best-known *dollar value* of a record:
 *   - real cost when opencode billed one (paid API),
 *   - 0 for genuinely free models (no API-equivalent to show),
 *   - otherwise the table estimate (subscription/zen $0 → "what it'd cost at API rates").
 * Kept separate from the real `cost` so free/subscription usage never shows phantom spend.
 */
export function apiEquivalentCost(record: UsageRecord): number {
	if (record.cost > 0) return record.cost
	if (isFreeModel(record.modelID)) return 0
	return estimateCost(record)
}

/** Estimate USD cost from token counts. Returns 0 when no rate is known. */
export function estimateCost(record: UsageRecord): number {
	const rate = rateFor(record)
	if (!rate) return 0
	return (
		(record.input * rate.input +
			record.output * rate.output +
			record.cacheRead * rate.cacheRead +
			record.cacheWrite * rate.cacheWrite) /
		1_000_000
	)
}

/**
 * Hypothetical cost if NOTHING had been cached: every input-side token billed at the
 * full input rate. Paired with estimateCost() (the table-based WITH-caching number) it
 * yields an apples-to-apples cache-savings figure, independent of how the headline cost
 * was sourced. Returns 0 when the model has no known rate (so savings stays at 0).
 */
export function withoutCachingCost(record: UsageRecord): number {
	const rate = rateFor(record)
	if (!rate) return 0
	const inputSide = record.input + record.cacheRead + record.cacheWrite
	return (inputSide * rate.input + (record.output + record.reasoning) * rate.output) / 1_000_000
}
