import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Aggregator, classifySegment, schemaComplexity } from "../src/plugin/aggregator"
import { estimateTokens, estimateTokensOf } from "../src/plugin/tokenizer"

const ROOT = "/enrich/root"

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
function assistant(o: Partial<AssistantInput> = {}): AssistantInput {
	return {
		id: "m1",
		sessionID: "ses_main",
		providerID: "anthropic",
		modelID: "claude-opus-4-8",
		cost: 0.1,
		tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
		path: { root: ROOT },
		time: { created: 1000 },
		...o,
	}
}

describe("tokenizer", () => {
	test("empty/blank → 0, non-empty → ≥1", () => {
		expect(estimateTokens("")).toBe(0)
		expect(estimateTokens(undefined)).toBe(0)
		expect(estimateTokens("hi")).toBeGreaterThanOrEqual(1)
	})
	test("longer text estimates more tokens", () => {
		expect(estimateTokens("word ".repeat(200))).toBeGreaterThan(estimateTokens("word ".repeat(5)))
	})
	test("estimateTokensOf sums the parts", () => {
		expect(estimateTokensOf(["alpha beta", "gamma delta"])).toBe(estimateTokens("alpha beta") + estimateTokens("gamma delta"))
	})
	test("fuzz: always a finite non-negative integer, never throws", () => {
		fc.assert(
			fc.property(fc.string(), (s) => {
				const n = estimateTokens(s)
				expect(Number.isInteger(n)).toBe(true)
				expect(n).toBeGreaterThanOrEqual(0)
			}),
			{ numRuns: 500 },
		)
	})
})

describe("classifySegment", () => {
	test("labels segments by content markers", () => {
		expect(classifySegment("The current working directory is /x and today's date is ...")).toBe("environment")
		expect(classifySegment("Here is the repository structure / project tree:")).toBe("projectTree")
		expect(classifySegment("Follow the custom instructions in AGENTS.md")).toBe("customInstructions")
		expect(classifySegment("You are a helpful coding assistant.")).toBe("systemPrompt")
	})
})

describe("schemaComplexity", () => {
	test("object/array schemas are complex, flat scalars simple, null unknown", () => {
		expect(schemaComplexity({ type: "object", properties: { a: { type: "string" } } })).toBe("complex")
		expect(schemaComplexity({ items: { type: "array" } })).toBe("complex")
		expect(schemaComplexity({ properties: { a: { type: "string" } } })).toBe("simple")
		expect(schemaComplexity(null)).toBe("unknown")
	})
})

describe("Aggregator enrichment", () => {
	test("tool aggregation carries output tokens, schema size, complexity, duration", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant())
		agg.ingestToolDef("read", "Read a file from disk", { type: "object", properties: { path: { type: "string" } } })
		agg.ingestTool("c1", "read", "ses_main", { outputTokens: 120, durationMs: 350 })
		agg.ingestTool("c2", "read", "ses_main", { outputTokens: 80, durationMs: 150 })
		agg.ingestTool("c2", "read", "ses_main", { outputTokens: 999, durationMs: 999 }) // dup callID ignored

		const snap = agg.computeSnapshot(ROOT)
		const read = snap.tools.find((t) => t.tool === "read")!
		expect(read.count).toBe(2)
		expect(read.outputTokens).toBe(200)
		expect(read.totalDurationMs).toBe(500)
		expect(read.complexity).toBe("complex")
		expect(read.schemaTokens).toBeGreaterThan(0)
	})

	test("session duration = lastActivity − startedAt", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "a", time: { created: 1000, completed: 2000 } }))
		agg.ingestAssistant(assistant({ id: "b", time: { created: 1500, completed: 6000 } }))
		const s = agg.computeSnapshot(ROOT).sessions.find((x) => x.sessionID === "ses_main")!
		expect(s.startedAt).toBe(1000)
		expect(s.lastActivity).toBe(6000)
		expect(s.durationMs).toBe(5000)
	})

	test("context breakdown is populated from system prompt + tool defs", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant())
		agg.ingestToolDef("read", "Read a file", { type: "object", properties: { path: { type: "string" } } })
		agg.ingestSystemPrompt("ses_main", [
			"You are a coding assistant.",
			"The current working directory is /x; today's date is 2026-06-17.",
			"Project tree:\nsrc/\n  index.ts",
		])
		const ctx = agg.computeSnapshot(ROOT).context
		expect(ctx.systemPrompt).toBeGreaterThan(0)
		expect(ctx.environment).toBeGreaterThan(0)
		expect(ctx.projectTree).toBeGreaterThan(0)
		expect(ctx.toolDefinitions).toBeGreaterThan(0)
		expect(ctx.total).toBe(
			ctx.systemPrompt + ctx.toolDefinitions + ctx.environment + ctx.projectTree + ctx.customInstructions + ctx.other,
		)
	})

	test("agent × model cross-breakdown attributes cost to who used what", () => {
		const agg = new Aggregator()
		agg.ingestAssistant(assistant({ id: "m1", sessionID: "ses_main", cost: 1 }))
		agg.ingestSession({ id: "ses_sub", parentID: "ses_main", title: "docs" })
		agg.ingestAgent("ses_sub", "docs-writer")
		agg.ingestAssistant(assistant({ id: "s1", sessionID: "ses_sub", modelID: "claude-haiku-4-5", cost: 0.2 }))

		const am = agg.computeSnapshot(ROOT).agentModel
		const main = am.find((x) => x.agent === "main")
		const docs = am.find((x) => x.agent === "docs-writer")
		expect(main?.model).toBe("anthropic/claude-opus-4-8")
		expect(main?.cost).toBeCloseTo(1, 9)
		expect(docs?.model).toBe("anthropic/claude-haiku-4-5")
		expect(docs?.cost).toBeCloseTo(0.2, 9)
	})
})
