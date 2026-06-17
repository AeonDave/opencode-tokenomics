import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { Aggregator } from "../src/plugin/aggregator"
import { config, projectKey } from "../src/plugin/config"
import { startServer } from "../src/plugin/server"
import {
	Bus,
	deleteAllProjects,
	deleteProjectFiles,
	ensureDirs,
	readAllSnapshots,
	writeRecords,
	writeSnapshot,
} from "../src/plugin/store"
import type { ProjectSnapshot } from "../src/plugin/types"

function snap(root: string, cost = 1): ProjectSnapshot {
	return {
		projectKey: projectKey(root),
		projectRoot: root,
		projectName: root,
		updatedAt: 1000,
		totals: { cost, estimatedCost: cost, tokens: 10, input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, messages: 1, sessions: 1, errors: 0, retries: 0 },
		apiCalls: 1,
		cache: { hitRate: 0, withoutCachingCost: 0, savings: 0, effectiveRatePerM: 0 },
		split: { main: { cost, estimatedCost: cost, tokens: 10, apiCalls: 1 }, subagents: { cost: 0, estimatedCost: 0, tokens: 0, apiCalls: 0 } },
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

describe("store.deleteProjectFiles", () => {
	test("removes a project's snapshot + records by key", async () => {
		await ensureDirs()
		const root = `/del/${process.pid}/one`
		const key = projectKey(root)
		await writeSnapshot(snap(root))
		await writeRecords(root, [])
		expect(await deleteProjectFiles(key)).toBe(true)
		const all = await readAllSnapshots()
		expect(all.find((s) => s.projectRoot === root)).toBeUndefined()
		await expect(fsp.readFile(path.join(config.recordsDir, `${key}.json`))).rejects.toThrow()
	})

	test("rejects an invalid (non-hex) key and deletes nothing", async () => {
		expect(await deleteProjectFiles("not-a-key")).toBe(false)
		expect(await deleteProjectFiles("../etc")).toBe(false)
		expect(await deleteProjectFiles("ABCDEF0123456789")).toBe(false) // uppercase not allowed
	})

	test("is a no-op (returns true) when the files are already gone", async () => {
		await ensureDirs()
		expect(await deleteProjectFiles("0123456789abcdef")).toBe(true)
	})
})

describe("store.deleteProjectFiles — fuzzing / path-traversal safety", () => {
	test("never escapes the data dir and only accepts 16-hex keys", async () => {
		await ensureDirs()
		// A sentinel one level up from projects/records — must survive every call.
		const sentinel = path.join(config.dataDir, "SENTINEL.json")
		await fsp.writeFile(sentinel, "keep", "utf8")

		await fc.assert(
			fc.asyncProperty(
				fc.oneof(
					fc.string(),
					fc.constantFrom("../SENTINEL", "..\\SENTINEL", "../../SENTINEL", "%2e%2e/SENTINEL", "a/../../SENTINEL", ""),
					fc.stringMatching(/^[0-9a-f]{16}$/), // valid keys (should be accepted)
				),
				async (key) => {
					const ok = await deleteProjectFiles(key)
					expect(ok).toBe(/^[0-9a-f]{16}$/.test(key))
				},
			),
			{ numRuns: 400 },
		)
		// The sentinel outside projects/records was never touched.
		expect(await fsp.readFile(sentinel, "utf8")).toBe("keep")
		await fsp.rm(sentinel, { force: true })
	})
})

describe("store.deleteAllProjects", () => {
	test("removes every project and reports the count", async () => {
		await ensureDirs()
		const roots = [`/all/${process.pid}/a`, `/all/${process.pid}/b`, `/all/${process.pid}/c`]
		for (const r of roots) {
			await writeSnapshot(snap(r))
			await writeRecords(r, [])
		}
		const removed = await deleteAllProjects()
		expect(removed).toBeGreaterThanOrEqual(roots.length)
		expect(await readAllSnapshots()).toEqual([])
	})
})

describe("Aggregator.forget / forgetAll", () => {
	function seed(agg: Aggregator, root: string, id: string) {
		agg.ingestAssistant({
			id,
			sessionID: `ses_${id}`,
			providerID: "anthropic",
			modelID: "claude-opus-4-8",
			cost: 0.1,
			tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
			path: { root },
			time: { created: 1000 },
		})
		agg.ingestTool(`call_${id}`, "read", `ses_${id}`)
	}

	test("forget(key) drops one project but leaves the others", () => {
		const agg = new Aggregator()
		seed(agg, "/p/a", "a")
		seed(agg, "/p/b", "b")
		agg.forget(projectKey("/p/a"))
		expect(agg.computeSnapshot("/p/a").totals.messages).toBe(0)
		expect(agg.computeSnapshot("/p/a").tools).toEqual([])
		expect(agg.computeSnapshot("/p/b").totals.messages).toBe(1)
		expect(agg.computeSnapshot("/p/b").tools.find((t) => t.tool === "read")?.count).toBe(1)
	})

	test("forgetAll clears everything", () => {
		const agg = new Aggregator()
		seed(agg, "/p/a", "a")
		seed(agg, "/p/b", "b")
		agg.forgetAll()
		expect(agg.computeSnapshot("/p/a").totals.messages).toBe(0)
		expect(agg.computeSnapshot("/p/b").totals.messages).toBe(0)
	})

	test("fuzz: forgetting a project never throws and never disturbs the survivor", () => {
		fc.assert(
			fc.property(fc.array(fc.stringMatching(/^[ab][a-z0-9]{0,6}$/), { maxLength: 20 }), (ids) => {
				const agg = new Aggregator()
				seed(agg, "/keep/root", "keep")
				for (const id of ids) seed(agg, "/drop/root", id)
				agg.forget(projectKey("/drop/root"))
				expect(agg.computeSnapshot("/drop/root").totals.messages).toBe(0)
				expect(agg.computeSnapshot("/keep/root").totals.messages).toBe(1)
			}),
			{ numRuns: 300 },
		)
	})
})

describe("server DELETE routes (integration)", () => {
	test("deletes one project by key and clears all", async () => {
		await ensureDirs()
		await deleteAllProjects() // clean slate
		const bus = new Bus()
		const agg = new Aggregator(bus)
		const server = await startServer(bus, agg)
		if (!server) return // a real tokenomics server already owns the port — skip
		try {
			const rootA = `/srv/${process.pid}/a`
			const rootB = `/srv/${process.pid}/b`
			await writeSnapshot(snap(rootA))
			await writeSnapshot(snap(rootB))

			// invalid key → 400
			const bad = await fetch(`${server.url}/api/projects/not-a-key`, { method: "DELETE" })
			expect(bad.status).toBe(400)

			// delete A by key
			const res = await fetch(`${server.url}/api/projects/${projectKey(rootA)}`, { method: "DELETE" })
			expect(res.status).toBe(200)
			let all = await readAllSnapshots()
			expect(all.find((s) => s.projectRoot === rootA)).toBeUndefined()
			expect(all.find((s) => s.projectRoot === rootB)).toBeDefined()

			// delete all
			const resAll = await fetch(`${server.url}/api/projects`, { method: "DELETE" })
			const body = (await resAll.json()) as { ok: boolean; deleted: number }
			expect(body.ok).toBe(true)
			all = await readAllSnapshots()
			expect(all.find((s) => s.projectRoot === rootB)).toBeUndefined()
		} finally {
			server.stop()
		}
	})
})
