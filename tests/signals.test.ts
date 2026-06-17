import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Aggregator } from "../src/plugin/aggregator"
import { projectKey } from "../src/plugin/config"

const ROOT = "/sig/root"

interface AInput {
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
function assistant(o: Partial<AInput> = {}): AInput {
	return {
		id: "m1",
		sessionID: "ses_main",
		providerID: "anthropic",
		modelID: "claude-opus-4-8",
		cost: 0.1,
		tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
		path: { root: ROOT },
		time: { created: 1000 },
		...o,
	}
}

describe("skills tracking", () => {
	test("aggregates loaded skills by name (deduped by callID)", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant())
		agg.ingestSkill("c1", "nmap", "ses_main", 1200)
		agg.ingestSkill("c2", "nmap", "ses_main", 800)
		agg.ingestSkill("c2", "nmap", "ses_main", 9999) // duplicate callID ignored
		agg.ingestSkill("c3", "sqlmap", "ses_main", 500)

		const skills = agg.computeSnapshot(ROOT).skills
		const nmap = skills.find((s) => s.name === "nmap")
		const sqlmap = skills.find((s) => s.name === "sqlmap")
		expect(nmap?.count).toBe(2)
		expect(nmap?.tokens).toBe(2000)
		expect(sqlmap?.count).toBe(1)
		// sorted by count desc
		expect(skills[0]!.name).toBe("nmap")
	})

	test("only counts skills for sessions in this project", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "m1", sessionID: "ses_main" }))
		agg.ingestSkill("c1", "nmap", "ses_main", 100)
		agg.ingestSkill("c2", "ghidra", "ses_elsewhere", 100) // unknown session → excluded
		expect(agg.computeSnapshot(ROOT).skills.map((s) => s.name)).toEqual(["nmap"])
	})
})

describe("errors, retries, failed tools", () => {
	test("assistant errors roll up to totals, model and session", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "ok", error: null }))
		agg.ingestAssistant(assistant({ id: "bad", error: { name: "APIError" } }))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.errors).toBe(1)
		expect(snap.models[0]!.errors).toBe(1)
		expect(snap.sessions.find((s) => s.sessionID === "ses_main")?.errors).toBe(1)
	})

	test("retries are counted per session and in totals", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant())
		agg.ingestRetry("ses_main")
		agg.ingestRetry("ses_main")
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.retries).toBe(2)
		expect(snap.sessions.find((s) => s.sessionID === "ses_main")?.retries).toBe(2)
	})

	test("failed tool calls are counted as errors", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant())
		agg.ingestTool("c1", "bash", "ses_main", { outputTokens: 0, durationMs: 10, error: true })
		agg.ingestTool("c2", "bash", "ses_main", { outputTokens: 20, durationMs: 5, error: false })
		const bash = agg.computeSnapshot(ROOT).tools.find((t) => t.tool === "bash")
		expect(bash?.count).toBe(2)
		expect(bash?.errors).toBe(1)
	})

	test("forget clears skills and retries for the project", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant())
		agg.ingestSkill("c1", "nmap", "ses_main", 100)
		agg.ingestRetry("ses_main")
		agg.forget(projectKey(ROOT))
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.skills).toEqual([])
		expect(snap.totals.retries).toBe(0)
		expect(snap.totals.messages).toBe(0)
	})
})

describe("signals fuzzing", () => {
	test("error/retry/skill accounting stays consistent and non-negative", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						err: fc.boolean(),
						retry: fc.boolean(),
						toolErr: fc.boolean(),
						skill: fc.option(fc.constantFrom("nmap", "ghidra", "sqlmap"), { nil: undefined }),
					}),
					{ maxLength: 40 },
				),
				(ops) => {
					const agg = new Aggregator()
					ops.forEach((op, i) => {
						agg.ingestAssistant(assistant({ id: `m${i}`, error: op.err ? { name: "APIError" } : null }))
						if (op.retry) agg.ingestRetry("ses_main")
						agg.ingestTool(`c${i}`, "bash", "ses_main", { outputTokens: 1, durationMs: 1, error: op.toolErr })
						if (op.skill) agg.ingestSkill(`s${i}`, op.skill, "ses_main", 10)
					})
					const snap = agg.computeSnapshot(ROOT)
					expect(snap.totals.errors).toBe(ops.filter((o) => o.err).length)
					expect(snap.totals.retries).toBe(ops.filter((o) => o.retry).length)
					// totals.errors equals the sum of per-model errors
					expect(snap.models.reduce((a, m) => a + m.errors, 0)).toBe(snap.totals.errors)
					// per-tool errors equal the number of failed tool ops
					const toolErrs = snap.tools.reduce((a, t) => a + t.errors, 0)
					expect(toolErrs).toBe(ops.filter((o) => o.toolErr).length)
					// skill loads counted
					const skillLoads = snap.skills.reduce((a, s) => a + s.count, 0)
					expect(skillLoads).toBe(ops.filter((o) => o.skill).length)
					expect(snap.totals.errors).toBeGreaterThanOrEqual(0)
				},
			),
			{ numRuns: 300 },
		)
	})
})
