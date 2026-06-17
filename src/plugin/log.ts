/**
 * Debug logger.
 *
 * Routes plugin chatter (startup banner, backfill notice) to OpenCode's logging API at
 * `debug` level so it stays out of normal startup output and only surfaces when the user
 * runs opencode with debug logging enabled. Falls back to console.debug when no client is
 * available (e.g. running outside opencode).
 */

import type { OpencodeClient } from "@opencode-ai/sdk"

const SERVICE = "tokenomics"

/** Log a message at debug level via the OpenCode client, or console.debug as a fallback. */
export function logDebug(client: OpencodeClient | undefined, message: string): void {
	if (!client) {
		console.debug(`[${SERVICE}] ${message}`)
		return
	}
	client.app.log({ body: { service: SERVICE, level: "debug", message } }).catch(() => {
		// Never let a logging failure disrupt the plugin.
	})
}
