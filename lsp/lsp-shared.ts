/**
 * LSP Shared - Singleton manager for both hook and tool
 *
 * This module provides a shared LSPManager instance that can be used by:
 * - lsp-hook.ts: For lifecycle management and auto-diagnostics on write/edit
 * - index.ts: For on-demand LSP queries (definitions, references, etc.)
 */

import { LSPManager } from "./lsp-core.js";

// ============================================================================
// Singleton Manager
// ============================================================================

let sharedManager: LSPManager | null = null;
let managerCwd: string | null = null;

/**
 * Get or create the shared LSP manager.
 * Called by the hook on session_start.
 */
export function getOrCreateManager(cwd: string): LSPManager {
  if (!sharedManager || managerCwd !== cwd) {
    // If cwd changed (different project), shutdown old manager
    if (sharedManager && managerCwd !== cwd) {
      sharedManager.shutdown().catch(() => {});
    }
    sharedManager = new LSPManager(cwd);
    managerCwd = cwd;
  }
  return sharedManager;
}

/**
 * Get the current shared manager.
 * Returns null if not initialized (hook not loaded or session not started).
 */
export function getManager(): LSPManager | null {
  return sharedManager;
}

/**
 * Shutdown the shared manager.
 * Called by the hook on session_shutdown.
 */
export async function shutdownManager(): Promise<void> {
  if (sharedManager) {
    await sharedManager.shutdown();
    sharedManager = null;
    managerCwd = null;
  }
}

/**
 * Check if the manager is initialized and ready.
 */
export function isManagerReady(): boolean {
  return sharedManager !== null;
}

/**
 * Get the current working directory of the manager.
 */
export function getManagerCwd(): string | null {
  return managerCwd;
}
