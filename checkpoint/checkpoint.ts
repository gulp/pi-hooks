/**
 * Git-based checkpoint hook for pi-coding-agent
 *
 * Creates checkpoints at the start of each turn so you can restore
 * code state when branching conversations.
 *
 * Features:
 * - Captures tracked, staged, AND untracked files (respects .gitignore)
 * - Persists checkpoints as git refs (survives session resume)
 * - Saves current state before restore (allows going back to latest)
 *
 * Usage:
 *   pi --hook ./checkpoint.ts
 *
 * Or add to ~/.pi/agent/hooks/ or .pi/hooks/ for automatic loading.
 */

import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";
import { exec } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================================
// Async git helpers
// ============================================================================

function execAsync(
  command: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = exec(
      command,
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    if (options.input && proc.stdin) {
      proc.stdin.write(options.input);
      proc.stdin.end();
    }
  });
}

// ============================================================================
// Checkpointing using git refs (like Conductor PR)
// Captures HEAD + index + worktree (including untracked files)
// ============================================================================

const ZEROS = "0".repeat(40);
const REF_BASE = "refs/pi-checkpoints";
const MAX_CHECKPOINTS = 100;

interface CheckpointData {
  id: string;
  turnIndex: number;
  sessionId: string; // Session UUID - stable across branches
  headSha: string;
  indexTreeSha: string; // Staged changes
  worktreeTreeSha: string; // All files including untracked
  timestamp: number;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree", { cwd });
    return true;
  } catch {
    return false;
  }
}

async function getRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd });
  return stdout.trim();
}

async function createCheckpoint(
  cwd: string,
  id: string,
  turnIndex: number,
  sessionId: string,
): Promise<CheckpointData> {
  const root = await getRepoRoot(cwd);
  const timestamp = Date.now();
  const isoTimestamp = new Date(timestamp).toISOString();

  // 1. Get HEAD (handle unborn HEAD)
  let headSha: string;
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", { cwd: root });
    headSha = stdout.trim();
  } catch {
    headSha = ZEROS;
  }

  // 2. Capture index (staged changes)
  const { stdout: indexStdout } = await execAsync("git write-tree", {
    cwd: root,
  });
  const indexTreeSha = indexStdout.trim();

  // 3. Capture worktree (ALL files including untracked) via temp index
  // This is the key difference from git stash - we capture everything
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
  const tmpIndex = join(tmpDir, "index");

  try {
    // Add all files to temp index (honors .gitignore)
    await execAsync("git add -A .", {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
    });

    // Write temp index to tree object
    const { stdout: wtStdout } = await execAsync("git write-tree", {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
    });
    const worktreeTreeSha = wtStdout.trim();

    // 4. Create checkpoint commit with metadata
    const message = [
      `checkpoint:${id}`,
      `sessionId ${sessionId}`,
      `turn ${turnIndex}`,
      `head ${headSha}`,
      `index-tree ${indexTreeSha}`,
      `worktree-tree ${worktreeTreeSha}`,
      `created ${isoTimestamp}`,
    ].join("\n");

    const { stdout: commitStdout } = await execAsync(
      `git commit-tree ${worktreeTreeSha}`,
      {
        cwd: root,
        input: message,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "pi-checkpoint",
          GIT_AUTHOR_EMAIL: "checkpoint@pi",
          GIT_AUTHOR_DATE: isoTimestamp,
          GIT_COMMITTER_NAME: "pi-checkpoint",
          GIT_COMMITTER_EMAIL: "checkpoint@pi",
          GIT_COMMITTER_DATE: isoTimestamp,
        },
      },
    );
    const commitSha = commitStdout.trim();

    // 5. Store as git ref
    const ref = `${REF_BASE}/${id}`;
    await execAsync(`git update-ref ${ref} ${commitSha}`, { cwd: root });

    return {
      id,
      turnIndex,
      sessionId,
      headSha,
      indexTreeSha,
      worktreeTreeSha,
      timestamp,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function restoreCheckpoint(
  cwd: string,
  checkpoint: CheckpointData,
): Promise<void> {
  const root = await getRepoRoot(cwd);
  console.error(`[checkpoint] Restoring checkpoint ${checkpoint.id}`);
  console.error(`[checkpoint] HEAD: ${checkpoint.headSha}`);
  console.error(`[checkpoint] Worktree: ${checkpoint.worktreeTreeSha}`);
  console.error(`[checkpoint] Index: ${checkpoint.indexTreeSha}`);

  if (checkpoint.headSha === ZEROS) {
    throw new Error("Cannot restore: checkpoint was saved with no commits");
  }

  // 1. Reset HEAD to saved commit
  console.error(`[checkpoint] Step 1: git reset --hard ${checkpoint.headSha}`);
  await execAsync(`git reset --hard ${checkpoint.headSha}`, { cwd: root });

  // 2. Update index to match worktree tree (without -u, doesn't touch files yet)
  console.error(`[checkpoint] Step 2: git read-tree --reset ${checkpoint.worktreeTreeSha}`);
  await execAsync(`git read-tree --reset ${checkpoint.worktreeTreeSha}`, {
    cwd: root,
  });

  // 3. Checkout files from index (overwrites existing, but doesn't delete extras)
  console.error(`[checkpoint] Step 3: git checkout-index -a -f`);
  await execAsync(`git checkout-index -a -f`, { cwd: root });

  // 4. Restore index to staged state
  console.error(`[checkpoint] Step 4: git read-tree --reset ${checkpoint.indexTreeSha}`);
  await execAsync(`git read-tree --reset ${checkpoint.indexTreeSha}`, {
    cwd: root,
  });
  
  console.error(`[checkpoint] Restore complete`);
}

async function loadCheckpointFromRef(
  cwd: string,
  refName: string,
): Promise<CheckpointData | null> {
  try {
    const root = await getRepoRoot(cwd);
    const ref = `${REF_BASE}/${refName}`;

    const { stdout: commitSha } = await execAsync(
      `git rev-parse --verify ${ref}`,
      { cwd: root },
    );

    const { stdout: commitMsg } = await execAsync(
      `git cat-file commit ${commitSha.trim()}`,
      { cwd: root },
    );

    const sessionMatch = commitMsg.match(/^sessionId (.+)$/m);
    const turnMatch = commitMsg.match(/^turn (-?\d+)$/m);
    const headMatch = commitMsg.match(/^head (.+)$/m);
    const indexMatch = commitMsg.match(/^index-tree (.+)$/m);
    const worktreeMatch = commitMsg.match(/^worktree-tree (.+)$/m);
    const createdMatch = commitMsg.match(/^created (.+)$/m);

    if (
      !sessionMatch ||
      !turnMatch ||
      !headMatch ||
      !indexMatch ||
      !worktreeMatch
    )
      return null;

    return {
      id: refName,
      turnIndex: parseInt(turnMatch[1], 10),
      sessionId: sessionMatch[1].trim(),
      headSha: headMatch[1].trim(),
      indexTreeSha: indexMatch[1].trim(),
      worktreeTreeSha: worktreeMatch[1].trim(),
      timestamp: createdMatch ? new Date(createdMatch[1].trim()).getTime() : 0,
    };
  } catch {
    return null;
  }
}

async function listCheckpointRefs(cwd: string): Promise<string[]> {
  try {
    const root = await getRepoRoot(cwd);
    const prefix = `${REF_BASE}/`;
    const { stdout } = await execAsync(
      `git for-each-ref --format='%(refname)' ${prefix}`,
      { cwd: root },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((ref) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : ref));
  } catch {
    return [];
  }
}

async function pruneCheckpoints(cwd: string): Promise<void> {
  try {
    const root = await getRepoRoot(cwd);
    const prefix = `${REF_BASE}/`;
    const { stdout } = await execAsync(
      `git for-each-ref --sort=committerdate --format='%(refname)' ${prefix}`,
      { cwd: root },
    );

    const refs = stdout.split("\n").filter(Boolean);
    if (refs.length <= MAX_CHECKPOINTS) return;

    const toDelete = refs.slice(0, refs.length - MAX_CHECKPOINTS);
    for (const ref of toDelete) {
      await execAsync(`git update-ref -d ${ref}`, { cwd: root }).catch(
        () => {},
      );
    }
  } catch {
    // Ignore errors
  }
}

// ============================================================================
// Hook implementation
// ============================================================================

export default function (pi: HookAPI) {
  const completedCheckpoints: CheckpointData[] = [];
  const pendingCheckpoints: Promise<CheckpointData | null>[] = [];

  let gitAvailable = false;
  let checkpointingFailed = false;
  let currentSessionId = "";
  let currentSessionFile = "";

  async function loadCheckpointsForSession(
    cwd: string,
    sessionId: string,
    clearExisting = true,
  ) {
    if (clearExisting) {
      completedCheckpoints.length = 0;
    }
    const refs = await listCheckpointRefs(cwd);
    let loaded = 0;
    for (const refName of refs) {
      const data = await loadCheckpointFromRef(cwd, refName);
      if (data && data.sessionId === sessionId) {
        // Avoid duplicates
        if (!completedCheckpoints.find((c) => c.id === data.id)) {
          completedCheckpoints.push(data);
          loaded++;
        }
      }
    }
    console.error(
      `[checkpoint] Loaded ${loaded} checkpoints for session ${sessionId}`,
    );
  }

  async function getSessionIdFromFile(sessionFile: string): Promise<string> {
    try {
      const { readFile } = await import("fs/promises");
      const content = await readFile(sessionFile, "utf-8");
      const firstLine = content.split("\n")[0];
      const header = JSON.parse(firstLine);
      return header.id || "";
    } catch {
      return "";
    }
  }

  pi.on("session_start", async (event, ctx) => {
    gitAvailable = await isGitRepo(ctx.cwd);
    if (!gitAvailable) {
      console.error("[checkpoint] Not a git repo");
      return;
    }

    if (ctx.sessionFile) {
      currentSessionFile = ctx.sessionFile;
      currentSessionId = await getSessionIdFromFile(ctx.sessionFile);
      console.error(`[checkpoint] Session ID: ${currentSessionId}`);
      if (currentSessionId) {
        await loadCheckpointsForSession(ctx.cwd, currentSessionId);
        console.error(
          `[checkpoint] Loaded ${completedCheckpoints.length} checkpoints`,
        );
      }
    } else {
      console.error("[checkpoint] No session file");
    }
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!gitAvailable || checkpointingFailed) return;

    // Try to get session ID if not available yet (new session)
    if (!currentSessionId && currentSessionFile) {
      currentSessionId = await getSessionIdFromFile(currentSessionFile);
      console.error(
        `[checkpoint] Got session ID on turn_start: ${currentSessionId}`,
      );
    }
    if (!currentSessionId) {
      console.error("[checkpoint] No session ID, skipping checkpoint");
      return;
    }

    // Fire and forget - don't block the turn
    const checkpointPromise = (async (): Promise<CheckpointData | null> => {
      try {
        const id = `${currentSessionId}-turn-${event.turnIndex}-${event.timestamp}`;
        const data = await createCheckpoint(
          ctx.cwd,
          id,
          event.turnIndex,
          currentSessionId,
        );

        completedCheckpoints.push(data);
        console.error(`[checkpoint] Created checkpoint: ${id}`);

        // Prune old checkpoints periodically
        if (Math.random() < 0.1) {
          pruneCheckpoints(ctx.cwd).catch(() => {});
        }

        return data;
      } catch (err) {
        // Log error for debugging, disable future attempts
        console.error("[checkpoint] Failed to create checkpoint:", err);
        checkpointingFailed = true;
        return null;
      }
    })();

    pendingCheckpoints.push(checkpointPromise);
  });

  pi.on("branch", async (event, ctx) => {
    console.error(
      `[checkpoint] Branch event fired, gitAvailable=${gitAvailable}`,
    );
    if (!gitAvailable) return undefined;

    // Wait for pending checkpoints
    await Promise.all(pendingCheckpoints);
    console.error(
      `[checkpoint] Pending checkpoints resolved, total=${completedCheckpoints.length}`,
    );

    // Get sessionId from entries header (this is the session we're branching FROM)
    const header = event.entries.find((e) => e.type === "session") as
      | { type: "session"; id: string }
      | undefined;
    const entriesSessionId = header?.id;
    console.error(
      `[checkpoint] Entries sessionId=${entriesSessionId}, current=${currentSessionId}`,
    );

    // Load checkpoints for the entries session (if different from current)
    if (entriesSessionId && entriesSessionId !== currentSessionId) {
      await loadCheckpointsForSession(ctx.cwd, entriesSessionId, false);
    }

    // Get ALL available checkpoints (from any session we know about), sorted by timestamp
    // This handles the case where we branch from a branched session
    const allCheckpoints = [...completedCheckpoints].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
    
    if (allCheckpoints.length === 0) {
      ctx.ui.notify("No checkpoints available", "warning");
      return undefined;
    }

    // Find the target entry's timestamp to match checkpoint
    // targetTurnIndex appears to be entry index in the entries array
    const targetEntry = event.entries[event.targetTurnIndex];
    const targetTimestamp = targetEntry?.timestamp
      ? new Date(targetEntry.timestamp).getTime()
      : Date.now();

    console.error(
      `[checkpoint] Target entry index: ${event.targetTurnIndex}, timestamp: ${targetTimestamp}`,
    );
    console.error(
      `[checkpoint] All checkpoints: ${allCheckpoints.map((c) => `${c.turnIndex}@${c.timestamp}`).join(", ")}`,
    );

    // Find checkpoint with timestamp closest to AND >= target entry timestamp
    // Checkpoint is created at turn_start (BEFORE processing), so we want the one
    // that was created when that message started being processed
    const checkpointsAtOrAfterTarget = allCheckpoints
      .filter((cp) => cp.timestamp >= targetTimestamp)
      .sort((a, b) => a.timestamp - b.timestamp); // Sort ascending to get closest

    console.error(
      `[checkpoint] Checkpoints at/after target: ${checkpointsAtOrAfterTarget.length}`,
    );

    if (checkpointsAtOrAfterTarget.length === 0) {
      ctx.ui.notify("No checkpoint found for this message", "warning");
      return undefined;
    }

    // Use the checkpoint closest to target (first one >= target timestamp)
    const checkpoint = checkpointsAtOrAfterTarget[0];

    const latestCheckpoint = allCheckpoints[0];
    const hasOlderCheckpoints = allCheckpoints.length > 1;

    console.error(
      `[checkpoint] Selected checkpoint: ${checkpoint.id} (timestamp: ${checkpoint.timestamp})`,
    );

    // Build options
    const options = [
      "Restore all (files + conversation)",
      "Conversation only (keep current files)",
      "Code only (restore files, keep conversation)",
    ];

    if (hasOlderCheckpoints) {
      options.push("Restore oldest checkpoint (keep conversation)");
    }

    options.push("Cancel");

    const choice = await ctx.ui.select("Restore code state?", options);
    console.error(`[checkpoint] User choice: ${choice}`);

    if (!choice || choice === "Cancel") {
      console.error(`[checkpoint] User cancelled or no choice`);
      return { skipConversationRestore: true };
    }

    if (choice.startsWith("Restore oldest")) {
      try {
        const oldestCheckpoint =
          allCheckpoints[allCheckpoints.length - 1];
        await restoreCheckpoint(ctx.cwd, oldestCheckpoint);
        ctx.ui.notify("Restored to oldest checkpoint", "info");
      } catch (error) {
        ctx.ui.notify(
          `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return { skipConversationRestore: true };
    }

    if (choice.startsWith("Code only")) {
      try {
        // Save current state before restoring (so user can go back)
        const beforeId = `${currentSessionId}-before-restore-${Date.now()}`;
        const beforeCheckpoint = await createCheckpoint(
          ctx.cwd,
          beforeId,
          event.targetTurnIndex,
          currentSessionId,
        );
        completedCheckpoints.push(beforeCheckpoint);

        await restoreCheckpoint(ctx.cwd, checkpoint);
        ctx.ui.notify("Files restored to checkpoint", "info");
      } catch (error) {
        ctx.ui.notify(
          `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return { skipConversationRestore: true };
    }

    if (choice.startsWith("Restore all")) {
      try {
        // Save current state before restoring
        const beforeId = `${currentSessionId}-before-restore-${Date.now()}`;
        const beforeCheckpoint = await createCheckpoint(
          ctx.cwd,
          beforeId,
          event.targetTurnIndex,
          currentSessionId,
        );
        completedCheckpoints.push(beforeCheckpoint);

        await restoreCheckpoint(ctx.cwd, checkpoint);
        ctx.ui.notify("Files and conversation restored", "info");
      } catch (error) {
        ctx.ui.notify(
          `File restore failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return undefined;
    }

    return undefined;
  });

  pi.on("session_switch", async (event, ctx) => {
    if (!gitAvailable) return;

    if (event.reason === "branch") {
      // Update current session ID for new checkpoints
      currentSessionId = await getSessionIdFromFile(event.newSessionFile);
    }
  });
}
