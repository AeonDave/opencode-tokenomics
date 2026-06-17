import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { config, projectKey } from "../src/plugin/config"
import { ensureDirs, loadRecords, mergeGlobal, readAllSnapshots, writeRecords, writeSnapshot } from "../src/plugin/store"
import type { ProjectSnapshot, UsageRecord } from "../src/plugin/types"

function snapshot(root: string, cost: number, updatedAt = 1000): ProjectSnapshot {
	const tokens = Math.round(cost * 1000)
	return {
		projectKey: projectKey(root),
		projectRoot: root,
		projectName: root,
		updatedAt,
		totals: {
			cost,
			estimatedCost: cost,
			tokens,
			input: tokens,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			messages: 2,
			sessions: 1,
			errors: 0,
			retries: 0,
		},
		apiCalls: 2,
		cache: { hitRate: 0, withoutCachingCost: 0, savings: 0, effectiveRatePerM: 0 },
		split: { main: { cost, tokens, apiCalls: 2 }, subagents: { cost: 0, tokens: 0, apiCalls: 0 } },
		models: [],
		sessions: [],
		tools: [],
		skills: [],
		agentModel: [],
		context: { systemPrompt: 0, toolDefinitions: 0, environment: 0, projectTree: 0, customInstructions: 0, other: 0, total: 0 },
		series: [],
		activityByHour: [],
		tokensByDay: [],
		spendByModel: { models: [], points: [] },
	}
}

describe("mergeGlobal", () => {
	test("sums totals, maxes updatedAt, sorts projects by cost desc", () => {
		const merged = mergeGlobal([snapshot("/a", 1, 100), snapshot("/b", 3, 500), snapshot("/c", 2, 300)])
		expect(merged.totals.cost).toBeCloseTo(6, 9)
		expect(merged.totals.messages).toBe(6)
		expect(merged.apiCalls).toBe(6)
		expect(merged.updatedAt).toBe(500)
		expect(merged.projects.map((p) => p.projectRoot)).toEqual(["/b", "/c", "/a"])
	})

	test("empty input yields zeroed totals", () => {
		const merged = mergeGlobal([])
		expect(merged.totals.cost).toBe(0)
		expect(merged.totals.tokens).toBe(0)
		expect(merged.updatedAt).toBe(0)
		expect(merged.projects).toEqual([])
	})
})

describe("store disk resilience", () => {
	test("round-trips a snapshot and skips a corrupt sibling file", async () => {
		await ensureDirs()
		const root = `/disk-test/${process.pid}/good`
		await writeSnapshot(snapshot(root, 4.2))

		// A half-written / garbage file must not break readAllSnapshots.
		await fsp.writeFile(path.join(config.projectsDir, "corrupt-deadbeef.json"), "{ not valid json", "utf8")

		const all = await readAllSnapshots()
		const mine = all.find((s) => s.projectRoot === root)
		expect(mine?.totals.cost).toBe(4.2)
	})

	test("loadRecords returns [] for missing and corrupt files", async () => {
		await ensureDirs()
		expect(await loadRecords("/disk-test/never-written")).toEqual([])

		const root = `/disk-test/${process.pid}/corrupt-records`
		const records: UsageRecord[] = []
		await writeRecords(root, records) // create the dir/file path
		await fsp.writeFile(path.join(config.recordsDir, `${projectKey(root)}.json`), "}{", "utf8")
		expect(await loadRecords(root)).toEqual([])
	})
})

describe("mergeGlobal fuzzing", () => {
	const snapArb = fc
		.record({ root: fc.string({ minLength: 1 }), cost: fc.double({ min: 0, max: 1000, noNaN: true }), at: fc.integer({ min: 0, max: 2_000_000_000_000 }) })
		.map(({ root, cost, at }) => snapshot(root, cost, at))

	test("totals equal the sum of parts; projects are sorted by cost desc; never throws", () => {
		fc.assert(
			fc.property(fc.array(snapArb, { maxLength: 40 }), (snaps) => {
				const merged = mergeGlobal(snaps)
				const expectedCost = snaps.reduce((acc, s) => acc + s.totals.cost, 0)
				const expectedAt = snaps.reduce((acc, s) => Math.max(acc, s.updatedAt), 0)
				expect(merged.totals.cost).toBeCloseTo(expectedCost, 6)
				expect(merged.updatedAt).toBe(expectedAt)
				expect(merged.projects.length).toBe(snaps.length)
				for (let i = 1; i < merged.projects.length; i++) {
					expect(merged.projects[i - 1]!.totals.cost).toBeGreaterThanOrEqual(merged.projects[i]!.totals.cost)
				}
			}),
			{ numRuns: 300 },
		)
	})
})
