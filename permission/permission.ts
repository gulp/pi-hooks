/**
 * Permission Hook for pi-coding-agent
 *
 * Implements layered permission control.
 *
 * Interactive mode:
 *   Use `/permission` command to view or change the level.
 *   When changing via command, you'll be asked: session-only or global?
 *
 * Print mode (pi -p):
 *   Set PI_PERMISSION_LEVEL env var: PI_PERMISSION_LEVEL=medium pi -p "task"
 *   Operations beyond level will exit with helpful error message.
 *   Use PI_PERMISSION_LEVEL=bypassed for CI/containers (dangerous!)
 *
 * Levels:
 *   off    - Read-only mode (default)
 *            ✅ Read files, ls, grep, git status/log/diff
 *            ❌ No file modifications, no commands with side effects
 *
 *   low    - File operations only
 *            ✅ Create/edit files in project directory
 *            ❌ No package installs, no git commits, no builds
 *
 *   medium - Development operations
 *            ✅ npm/pip install, git commit/pull, make/build
 *            ❌ No git push, no sudo, no production changes
 *
 *   high   - Full operations
 *            ✅ git push, deployments, scripts
 *            ⚠️ Still prompts for destructive commands (rm -rf, etc.)
 */

import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";
import {
  createInitialState,
  handlePermissionCommand,
  handleSessionStart,
  handleBashToolCall,
  handleWriteToolCall,
} from "./permission-hook.js";

export default function (pi: HookAPI) {
  const state = createInitialState();

  pi.registerCommand("permission", {
    description: "View or change permission level",
    handler: (args, ctx) => handlePermissionCommand(state, args, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    handleSessionStart(state, ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return handleBashToolCall(state, event.input.command as string, ctx);
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      return handleWriteToolCall({
        state,
        toolName: event.toolName,
        filePath: event.input.path as string,
        ctx,
      });
    }

    return undefined;
  });
}
