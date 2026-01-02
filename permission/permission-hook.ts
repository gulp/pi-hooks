/**
 * Permission hook utilities - UI helpers, state management, and handlers
 */

import { exec } from "node:child_process";
import {
  type PermissionLevel,
  LEVELS,
  LEVEL_INDEX,
  LEVEL_INFO,
  LEVEL_ALLOWED_DESC,
  loadGlobalPermission,
  saveGlobalPermission,
  classifyCommand,
} from "./permission-core.js";

// Re-export types and constants needed by the hook
export {
  type PermissionLevel,
  LEVELS,
  LEVEL_INFO,
};

// ============================================================================
// SOUND NOTIFICATION
// ============================================================================

function playPermissionSound(): void {
  const isMac = process.platform === "darwin";

  if (isMac) {
    exec('afplay /System/Library/Sounds/Funk.aiff 2>/dev/null', (err) => {
      if (err) process.stdout.write("\x07");
    });
  } else {
    process.stdout.write("\x07");
  }
}

// ============================================================================
// STATUS TEXT
// ============================================================================

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

const LEVEL_COLORS: Record<PermissionLevel, string> = {
  off: RED,
  low: YELLOW,
  medium: CYAN,
  high: GREEN,
  bypassed: DIM,
};

function getStatusText(level: PermissionLevel): string {
  const info = LEVEL_INFO[level];
  const color = LEVEL_COLORS[level];
  return `${BOLD}${color}${info.label}${RESET} ${DIM}- ${info.desc}${RESET}`;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export interface PermissionState {
  currentLevel: PermissionLevel;
  isSessionOnly: boolean;
}

export function createInitialState(): PermissionState {
  return { currentLevel: "off", isSessionOnly: false };
}

function setLevel(
  state: PermissionState,
  level: PermissionLevel,
  saveGlobally: boolean,
  ctx: any
): void {
  state.currentLevel = level;
  state.isSessionOnly = !saveGlobally;
  if (saveGlobally) {
    saveGlobalPermission(level);
  }
  if (ctx.ui?.setStatus) {
    ctx.ui.setStatus("permission", getStatusText(level));
  }
}

// ============================================================================
// HANDLERS
// ============================================================================

/** Handle /permission command */
export async function handlePermissionCommand(
  state: PermissionState,
  args: string,
  ctx: any
): Promise<void> {
  const arg = args.trim().toLowerCase();

  // Direct level set: /permission medium
  if (arg && LEVELS.includes(arg as PermissionLevel)) {
    const newLevel = arg as PermissionLevel;

    if (ctx.hasUI) {
      const scope = await ctx.ui.select("Save permission level to:", [
        "Session only",
        "Global (persists)",
      ]);
      if (!scope) return;

      setLevel(state, newLevel, scope === "Global (persists)", ctx);
      const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
      ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
    } else {
      setLevel(state, newLevel, false, ctx);
      ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}`, "info");
    }
    return;
  }

  // Show current level (no UI)
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Current permission: ${LEVEL_INFO[state.currentLevel].label} (${LEVEL_INFO[state.currentLevel].desc})`,
      "info"
    );
    return;
  }

  // Show selector
  const options = LEVELS.map((level) => {
    const info = LEVEL_INFO[level];
    const marker = level === state.currentLevel ? " ← current" : "";
    return `${info.label}: ${info.desc}${marker}`;
  });

  const choice = await ctx.ui.select("Select permission level", options);
  if (!choice) return;

  const selectedLabel = choice.split(":")[0].trim();
  const newLevel = LEVELS.find((l) => LEVEL_INFO[l].label === selectedLabel);
  if (!newLevel || newLevel === state.currentLevel) return;

  const scope = await ctx.ui.select("Save to:", ["Session only", "Global (persists)"]);
  if (!scope) return;

  setLevel(state, newLevel, scope === "Global (persists)", ctx);
  const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
  ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
}

/** Handle session_start - initialize level and show status */
export function handleSessionStart(state: PermissionState, ctx: any): void {
  // Check env var first (for print mode)
  const envLevel = process.env.PI_PERMISSION_LEVEL?.toLowerCase();
  if (envLevel && LEVELS.includes(envLevel as PermissionLevel)) {
    state.currentLevel = envLevel as PermissionLevel;
  } else {
    const globalLevel = loadGlobalPermission();
    if (globalLevel) {
      state.currentLevel = globalLevel;
    }
  }

  if (ctx.hasUI) {
    if (ctx.ui?.setStatus) {
      ctx.ui.setStatus("permission", getStatusText(state.currentLevel));
    }
    if (state.currentLevel === "bypassed") {
      ctx.ui.notify("⚠️ Permission bypassed - all checks disabled!", "warning");
    } else {
      ctx.ui.notify(`Permission: ${LEVEL_INFO[state.currentLevel].label} (use /permission to change)`, "info");
    }
  }
}

/** Handle bash tool_call - check permission and prompt if needed */
export async function handleBashToolCall(
  state: PermissionState,
  command: string,
  ctx: any
): Promise<{ block: true; reason: string } | undefined> {
  if (state.currentLevel === "bypassed") return undefined;

  const classification = classifyCommand(command);

  // Dangerous commands - always prompt
  if (classification.dangerous) {
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Dangerous command requires confirmation: ${command}
User can re-run with: PI_PERMISSION_LEVEL=bypassed pi -p "..."`
      };
    }

    playPermissionSound();
    const choice = await ctx.ui.select(
      `⚠️ Dangerous command:\n\n  ${command}\n`,
      ["Allow once", "Cancel"]
    );

    if (choice !== "Allow once") {
      return { block: true, reason: "Cancelled" };
    }
    return undefined;
  }

  // Check level
  const requiredIndex = LEVEL_INDEX[classification.level];
  const currentIndex = LEVEL_INDEX[state.currentLevel];

  if (requiredIndex <= currentIndex) return undefined;

  const requiredLevel = classification.level;
  const requiredInfo = LEVEL_INFO[requiredLevel];

  // Print mode: block
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}). Command: ${command}
Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
User can re-run with: PI_PERMISSION_LEVEL=${requiredLevel} pi -p "..."`
    };
  }

  // Interactive mode: prompt
  playPermissionSound();
  const choice = await ctx.ui.select(
    `Requires ${requiredInfo.label}: ${command}`,
    ["Allow once", `Allow all (${requiredInfo.label})`, "Cancel"]
  );

  if (choice === "Allow once") return undefined;

  if (choice === `Allow all (${requiredInfo.label})`) {
    setLevel(state, requiredLevel, true, ctx);
    ctx.ui.notify(`Permission → ${requiredInfo.label} (saved globally)`, "info");
    return undefined;
  }

  return { block: true, reason: "Cancelled" };
}

/** Options for handleWriteToolCall */
export interface WriteToolCallOptions {
  state: PermissionState;
  toolName: string;
  filePath: string;
  ctx: any;
}

/** Handle write/edit tool_call and tool_before_apply - check permission and prompt if needed */
export async function handleWriteToolCall(
  opts: WriteToolCallOptions
): Promise<{ block: true; reason: string } | undefined> {
  const { state, toolName, filePath, ctx } = opts;
  
  if (state.currentLevel === "bypassed") return undefined;

  if (LEVEL_INDEX[state.currentLevel] >= LEVEL_INDEX["low"]) return undefined;

  const action = toolName === "write" ? "Write" : "Edit";
  const message = `Requires Low: ${action} ${filePath}`;

  // Print mode: block
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}). ${action}: ${filePath}
Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
User can re-run with: PI_PERMISSION_LEVEL=low pi -p "..."`
    };
  }

  // Interactive mode: prompt
  playPermissionSound();
  const choice = await ctx.ui.select(
    message,
    ["Allow once", "Allow all (Low)", "Cancel"]
  );

  if (choice === "Allow once") return undefined;

  if (choice === "Allow all (Low)") {
    setLevel(state, "low", true, ctx);
    ctx.ui.notify(`Permission → Low (saved globally)`, "info");
    return undefined;
  }

  return { block: true, reason: "Cancelled" };
}
