/**
 * Test preload. Redirects the plugin's data directory to a throwaway temp dir and
 * disables browser auto-open, BEFORE config.ts reads these env vars at import time.
 */

import * as os from "node:os"
import * as path from "node:path"

process.env.OPENCODE_TOKENOMICS_DIR = path.join(os.tmpdir(), `tokenomics-test-${process.pid}`)
process.env.OPENCODE_TOKENOMICS_OPEN = "0"
// A distinct, unlikely-to-collide port for the server integration test.
process.env.OPENCODE_TOKENOMICS_PORT = "5793"
// Keep card settings out of the real ~/.config/opencode during tests.
process.env.OPENCODE_TOKENOMICS_CONFIG_DIR = path.join(os.tmpdir(), `tokenomics-test-cfg-${process.pid}`)
