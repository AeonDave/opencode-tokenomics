import { describe, expect, test } from "bun:test"
import { Aggregator } from "../src/plugin/aggregator"
import { backfillProject } from "../src/plugin/backfill"

const ROOT = "/bf/proj"

function fakeClient() {
	const sessions = [
		{ id: "ses_main", title: "main", directory: ROOT },
		{ id: "ses_sub", parentID: "ses_main", title: "docs", directory: ROOT },
		{ id: "ses_other", title: "other project", directory: "/somewhere/else" },
	]
	const messages: Record<string, unknown[]> = {
		ses_main: [
			{
				info: {
					id: "h1", sessionID: "ses_main", role: "assistant", providerID: "anthropic", modelID: "claude-opus-4-8",
					cost: 0.5, tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
					path: { root: ROOT }, time: { created: 1000, completed: 2000 },
				},
				parts: [
					{ type: "tool", callID: "c1", tool: "read", sessionID: "ses_main", state: { status: "completed", output: "the file contents", time: { start: 1000, end: 1200 } } },
				],
			},
		],
		ses_sub: [
			{
				info: {
					id: "h2", sessionID: "ses_sub", role: "assistant", providerID: "anthropic", modelID: "claude-haiku-4-5",
					cost: 0.1, tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
					path: { root: ROOT }, time: { created: 1500, completed: 3000 },
				},
				parts: [{ type: "agent", sessionID: "ses_sub", name: "docs-writer" }],
			},
		],
	}
	let messagesCalls = 0
	return {
		client: {
			session: {
				list: async () => ({ data: sessions }),
				messages: async ({ path }: { path: { id: string } }) => {
					messagesCalls++
					return { data: messages[path.id] ?? [] }
				},
			},
		},
		fetched: () => messagesCalls,
	}
}

describe("backfillProject", () => {
	test("imports the current project's history into the aggregator", async () => {
		const agg = new Aggregator()
		const { client } = fakeClient()
		const n = await backfillProject(agg, client, ROOT)
		expect(n).toBe(2) // ses_main + ses_sub; ses_other filtered out by directory

		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.messages).toBe(2)
		expect(snap.totals.cost).toBeCloseTo(0.6, 9)
		const sub = snap.sessions.find((s) => s.sessionID === "ses_sub")
		expect(sub?.isSubagent).toBe(true)
		expect(sub?.agent).toBe("docs-writer")
		expect(snap.tools.find((t) => t.tool === "read")?.outputTokens).toBeGreaterThan(0)
		expect(snap.agentModel.some((a) => a.agent === "docs-writer")).toBe(true)
	})

	test("only fetches messages for sessions in the current project directory", async () => {
		const agg = new Aggregator()
		const fc = fakeClient()
		await backfillProject(agg, fc.client, ROOT)
		expect(fc.fetched()).toBe(2) // never fetched ses_other
	})

	test("is idempotent — replaying does not double-count", async () => {
		const agg = new Aggregator()
		const { client } = fakeClient()
		await backfillProject(agg, client, ROOT)
		await backfillProject(agg, client, ROOT)
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.totals.messages).toBe(2)
		expect(snap.totals.cost).toBeCloseTo(0.6, 9)
	})

	test("backfills skills, assistant errors, retries and failed tools from history", async () => {
		const client = {
			session: {
				list: async () => ({ data: [{ id: "ses_x", title: "x", directory: ROOT }] }),
				messages: async () => ({
					data: [
						{
							info: {
								id: "h9", sessionID: "ses_x", role: "assistant", providerID: "anthropic", modelID: "claude-opus-4-8",
								cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
								path: { root: ROOT }, time: { created: 1000 }, error: { name: "APIError" },
							},
							parts: [
								{ type: "tool", callID: "k1", tool: "skill", sessionID: "ses_x", state: { status: "completed", output: "skill body text", input: { name: "nmap" }, time: { start: 1, end: 2 } } },
								{ type: "tool", callID: "b1", tool: "bash", sessionID: "ses_x", state: { status: "error", error: "boom", time: { start: 1, end: 3 } } },
								{ type: "retry", sessionID: "ses_x" },
							],
						},
					],
				}),
			},
		}
		const agg = new Aggregator()
		await backfillProject(agg, client, ROOT)
		const snap = agg.computeSnapshot(ROOT)
		expect(snap.skills.find((s) => s.name === "nmap")?.count).toBe(1)
		expect(snap.tools.find((t) => t.tool === "bash")?.errors).toBe(1)
		expect(snap.totals.errors).toBe(1)
		expect(snap.totals.retries).toBe(1)
	})

	test("is a safe no-op without a client or directory", async () => {
		const agg = new Aggregator()
		expect(await backfillProject(agg, undefined, ROOT)).toBe(0)
		expect(await backfillProject(agg, {}, undefined)).toBe(0)
	})

	test("swallows a failing client and returns 0", async () => {
		const agg = new Aggregator()
		const bad = { session: { list: async () => { throw new Error("boom") }, messages: async () => ({ data: [] }) } }
		expect(await backfillProject(agg, bad, ROOT)).toBe(0)
	})
})
