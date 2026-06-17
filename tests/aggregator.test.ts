import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Aggregator } from "../src/plugin/aggregator"

const ROOT = "/fuzz/root"

interface AssistantInput {
	id: string
	sessionID: string
	providerID: string
	modelID: string
	cost: number
	tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
	path: { root: string }
	time: { created: number; completed?: number }
}

function assistant(overrides: Partial<AssistantInput> = {}): AssistantInput {
	return {
		id: "msg_1",
		sessionID: "ses_main",
		providerID: "anthropic",
		modelID: "claude-opus-4-8",
		cost: 0.1,
		tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
		path: { root: ROOT },
		time: { created: 60_000 },
		...overrides,
	}
}

/** abs/relative tolerance for sums of floating costs. */
function approx(a: number, b: number) {
	expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-6 * (1 + Math.abs(b)))
}

describe("Aggregator — core aggregation", () => {
	test("single assistant message populates totals, models, and one session", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ cost: 0.25, tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 100 } } }))
		const snap = agg.computeSnapshot(ROOT)

		expect(snap.totals.messages).toBe(1)
		expect(snap.totals.cost).toBeCloseTo(0.25, 9)
		expect(snap.totals.input).toBe(1000)
		expect(snap.totals.output).toBe(200)
		expect(snap.totals.cacheRead).toBe(300)
		expect(snap.totals.cacheWrite).toBe(100)
		expect(snap.totals.tokens).toBe(1000 + 200 + 300 + 100)
		expect(snap.apiCalls).toBe(1)
		expect(snap.models).toHaveLength(1)
		expect(snap.models[0]!.model).toBe("anthropic/claude-opus-4-8")
		expect(snap.sessions).toHaveLength(1)
		expect(snap.sessions[0]!.isSubagent).toBe(false)
	})

	test("degenerate path.root ('/') falls back to the plugin's project directory", () => {
		const dir = "C:/Users/me/ctf"
		const agg = new Aggregator(undefined, dir)
		agg.ingestAssistant(assistant({ path: { root: "/" } }))
		const snap = agg.computeSnapshot(dir)
		expect(snap.totals.messages).toBe(1)
		expect(snap.projectName).toBe("ctf")
		expect(snap.projectRoot).toBe(dir)
	})

	test("with no fallback, a degenerate root is skipped (not keyed under '/')", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ path: { root: "/" } }))
		expect(agg.computeSnapshot("/").totals.messages).toBe(0)
	})

	test("records are deduped by message id (last write wins)", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "msg_x", cost: 0.1 }))
		agg.ingestAssistant(assistant({ id: "msg_x", cost: 0.9 }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.messages).toBe(1)
		expect(snap.totals.cost).toBeCloseTo(0.9, 9)
	})

	test("splits main vs subagents using session parentID", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "m1", sessionID: "ses_main", cost: 1 }))
		agg.ingestSession({ id: "ses_sub", parentID: "ses_main", title: "docs" })
		agg.ingestAssistant(assistant({ id: "s1", sessionID: "ses_sub", cost: 0.2 }))
		const snap = agg.computeSnapshot(ROOT)

		expect(snap.totals.sessions).toBe(2)
		expect(snap.split.main.cost).toBeCloseTo(1, 9)
		expect(snap.split.subagents.cost).toBeCloseTo(0.2, 9)
		const sub = snap.sessions.find((s) => s.sessionID === "ses_sub")
		expect(sub?.isSubagent).toBe(true)
		expect(sub?.title).toBe("docs")
	})

	test("cache hit rate = cacheRead / (cacheRead + fresh input)", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ cost: 0.5, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 900, write: 0 } } }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.cache.hitRate).toBeCloseTo(0.9, 9)
	})

	test("subscription $0 keeps real cost 0 but exposes an API-equivalent estimate", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ cost: 0, tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.cost).toBe(0) // real spend on a subscription/zen plan is $0
		expect(snap.totals.estimatedCost).toBeCloseTo(5, 6) // opus 1M input ≈ $5 at API rates
		expect(snap.models[0]!.cost).toBe(0)
		expect(snap.models[0]!.estimatedCost).toBeCloseTo(5, 6)
	})

	test("free models show $0 real AND $0 estimate (no phantom spend)", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(
			assistant({ modelID: "deepseek-v4-flash-free", cost: 0, tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 500_000, write: 0 } } }),
		)
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.cost).toBe(0)
		expect(snap.totals.estimatedCost).toBe(0) // free → no API-equivalent
		expect(snap.cache.savings).toBe(0) // savings is meaningless for free usage
		expect(snap.models[0]!.estimatedCost).toBe(0)
	})

	test("paid usage keeps real cost and mirrors it in the estimate", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ cost: 0.42 }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.cost).toBeCloseTo(0.42, 9)
		expect(snap.totals.estimatedCost).toBeCloseTo(0.42, 9)
	})

	test("cache savings counts only real-cost (paid) usage", () => {
		// Paid record with heavy cache → real savings (table delta input-vs-cache rate).
		const paid = new Aggregator()
		paid.ingestAssistant(assistant({ cost: 0.5, tokens: { input: 100_000, output: 0, reasoning: 0, cache: { read: 900_000, write: 0 } } }))
		expect(paid.computeSnapshot(ROOT).cache.savings).toBeGreaterThan(0)

		// Same token shape but billed $0 (subscription/free) → no real money saved.
		const sub = new Aggregator()
		sub.ingestAssistant(assistant({ cost: 0, tokens: { input: 100_000, output: 0, reasoning: 0, cache: { read: 900_000, write: 0 } } }))
		const snap = sub.computeSnapshot(ROOT)
		expect(snap.cache.savings).toBe(0)
		expect(snap.totals.estimatedCost).toBeGreaterThan(0) // estimate still available, just not "saved"
	})

	test("counts tool calls (deduped by callID) only for sessions in this root", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "m1", sessionID: "ses_main" }))
		agg.ingestTool("call_1", "read", "ses_main")
		agg.ingestTool("call_1", "read", "ses_main") // duplicate callID
		agg.ingestTool("call_2", "read", "ses_main")
		agg.ingestTool("call_3", "bash", "ses_main")
		agg.ingestTool("call_4", "read", "ses_unknown") // no record → not in this root
		const snap = agg.computeSnapshot(ROOT)

		const read = snap.tools.find((t) => t.tool === "read")
		const bash = snap.tools.find((t) => t.tool === "bash")
		expect(read?.count).toBe(2)
		expect(bash?.count).toBe(1)
		expect(snap.tools.reduce((a, t) => a + t.count, 0)).toBe(3)
	})

	test("series is cumulative and ends at the project total cost", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "m1", cost: 1, time: { created: 60_000 } }))
		agg.ingestAssistant(assistant({ id: "m2", cost: 2, time: { created: 180_000 } }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.series.length).toBeGreaterThanOrEqual(2)
		for (let i = 1; i < snap.series.length; i++) {
			expect(snap.series[i]!.cost).toBeGreaterThanOrEqual(snap.series[i - 1]!.cost)
		}
		expect(snap.series.at(-1)!.cost).toBeCloseTo(snap.totals.cost, 6)
	})
})

describe("Aggregator — fuzzing", () => {
	const sessionId = fc.constantFrom("ses_a", "ses_b", "ses_c", "ses_d")
	const toolName = fc.constantFrom("read", "write", "bash", "edit", "task")
	const model = fc.constantFrom("claude-opus-4-8", "claude-sonnet-4-6", "gpt-5", "unknown-model")
	const count = () => fc.integer({ min: 0, max: 100_000 })

	const command = fc.oneof(
		fc.record({
			kind: fc.constant("assistant" as const),
			id: fc.stringMatching(/^msg[0-9]{1,4}$/),
			sessionID: sessionId,
			modelID: model,
			cost: fc.double({ min: 0, max: 10, noNaN: true }),
			input: count(),
			output: count(),
			reasoning: count(),
			cacheRead: count(),
			cacheWrite: count(),
			created: fc.integer({ min: 0, max: 600_000 }),
		}),
		fc.record({
			kind: fc.constant("session" as const),
			id: sessionId,
			parentID: fc.option(sessionId, { nil: undefined }),
			title: fc.string({ maxLength: 12 }),
		}),
		fc.record({ kind: fc.constant("tool" as const), callID: fc.stringMatching(/^c[0-9]{1,4}$/), tool: toolName, sessionID: sessionId }),
		fc.record({ kind: fc.constant("agent" as const), sessionID: sessionId, name: fc.string({ maxLength: 12 }) }),
	)

	test("computeSnapshot never throws and holds its accounting invariants", () => {
		fc.assert(
			fc.property(fc.array(command, { maxLength: 60 }), (cmds) => {
				const agg = new Aggregator()
				for (const c of cmds) {
					if (c.kind === "assistant") {
						agg.ingestAssistant({
							id: c.id,
							sessionID: c.sessionID,
							providerID: "anthropic",
							modelID: c.modelID,
							cost: c.cost,
							tokens: { input: c.input, output: c.output, reasoning: c.reasoning, cache: { read: c.cacheRead, write: c.cacheWrite } },
							path: { root: ROOT },
							time: { created: c.created },
						})
					} else if (c.kind === "session") {
						agg.ingestSession({ id: c.id, parentID: c.parentID, title: c.title })
					} else if (c.kind === "tool") {
						agg.ingestTool(c.callID, c.tool, c.sessionID)
					} else {
						agg.ingestAgent(c.sessionID, c.name)
					}
				}

				const snap = agg.computeSnapshot(ROOT)

				// tokens identity
				expect(snap.totals.tokens).toBe(snap.totals.input + snap.totals.output + snap.totals.cacheRead + snap.totals.cacheWrite)
				// cost is finite & non-negative
				expect(Number.isFinite(snap.totals.cost)).toBe(true)
				expect(snap.totals.cost).toBeGreaterThanOrEqual(0)
				// apiCalls mirror message count
				expect(snap.apiCalls).toBe(snap.totals.messages)
				// sessions and models partition the total cost
				approx(snap.sessions.reduce((a, s) => a + s.cost, 0), snap.totals.cost)
				approx(snap.models.reduce((a, m) => a + m.cost, 0), snap.totals.cost)
				approx(snap.split.main.cost + snap.split.subagents.cost, snap.totals.cost)
				// cache hit rate is a probability
				expect(snap.cache.hitRate).toBeGreaterThanOrEqual(0)
				expect(snap.cache.hitRate).toBeLessThanOrEqual(1)
				// savings never negative (max(0, …) guard)
				expect(snap.cache.savings).toBeGreaterThanOrEqual(0)
				// models/sessions sorted by cost desc
				for (let i = 1; i < snap.models.length; i++) expect(snap.models[i - 1]!.cost).toBeGreaterThanOrEqual(snap.models[i]!.cost)
			}),
			{ numRuns: 400 },
		)
	})
})
