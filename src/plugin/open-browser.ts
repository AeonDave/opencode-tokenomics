/**
 * Best-effort cross-platform "open this URL in the default browser".
 * Detached + fire-and-forget: never blocks plugin startup, never throws.
 */

import { spawn } from "node:child_process"

export function openBrowser(url: string): void {
	try {
		if (process.platform === "win32") {
			// `start` is a cmd builtin; the empty "" is the (ignored) window title.
			// windowsHide avoids a console flash when opencode runs in a TUI.
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref()
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref()
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
		}
	} catch {
		// no browser available (headless/CI) — the server still serves the dashboard.
	}
}
