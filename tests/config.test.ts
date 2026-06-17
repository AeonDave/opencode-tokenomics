import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import * as path from "node:path"
import { projectKey, projectName } from "../src/plugin/config"

describe("projectKey", () => {
	test("is a stable 16-char lowercase hex digest", () => {
		const key = projectKey("/home/me/project-a")
		expect(key).toMatch(/^[0-9a-f]{16}$/)
		expect(projectKey("/home/me/project-a")).toBe(key) // deterministic
	})

	test("distinguishes different roots", () => {
		expect(projectKey("/a")).not.toBe(projectKey("/b"))
	})
})

describe("projectName", () => {
	test("is the final path segment", () => {
		expect(projectName(path.join("/home", "me", "opencode-tokenomics"))).toBe("opencode-tokenomics")
	})

	test("falls back to the full root when there is no basename", () => {
		expect(projectName("")).toBe("")
	})
})

describe("config fuzzing", () => {
	test("projectKey is total, deterministic, and always 16 hex chars", () => {
		fc.assert(
			fc.property(fc.string(), (s) => {
				const a = projectKey(s)
				const b = projectKey(s)
				expect(a).toBe(b)
				expect(a).toMatch(/^[0-9a-f]{16}$/)
			}),
			{ numRuns: 500 },
		)
	})

	test("projectName never throws and returns a string for any input", () => {
		fc.assert(
			fc.property(fc.string(), (s) => {
				const name = projectName(s)
				expect(typeof name).toBe("string")
			}),
			{ numRuns: 500 },
		)
	})
})
