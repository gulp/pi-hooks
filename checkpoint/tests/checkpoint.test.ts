/**
 * Tests for checkpoint hook git operations
 *
 * Run with: npm test
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises";
import { readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  git,
  getRepoRoot,
  createCheckpoint,
  restoreCheckpoint,
} from "../checkpoint-core.js";

// ============================================================================
// Test utilities
// ============================================================================

const listFiles = (cwd: string) =>
  readdirSync(cwd).filter((f) => !f.startsWith("."));

const getIndexFiles = async (cwd: string) =>
  (await git("ls-files", cwd)).split("\n").filter(Boolean);

// ============================================================================
// Test runner
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertArrayEquals(
  actual: string[],
  expected: string[],
  message: string
) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  assert(
    sortedActual.length === sortedExpected.length &&
      sortedActual.every((v, i) => v === sortedExpected[i]),
    `${message}\nExpected: [${sortedExpected.join(", ")}]\nActual: [${sortedActual.join(", ")}]`
  );
}

/** Create test repo, run test, cleanup */
async function withTestRepo(
  fn: (dir: string, root: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-test-"));
  try {
    await git("init", dir);
    await git("config user.email test@test.com", dir);
    await git("config user.name Test", dir);

    // Create initial commit
    await writeFile(join(dir, "initial.txt"), "initial content");
    await git("add .", dir);
    await git("commit -m 'initial'", dir);

    const root = await getRepoRoot(dir);
    await fn(dir, root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// Tests
// ============================================================================

test("restore: empty worktree checkpoint removes all files", () =>
  withTestRepo(async (dir, root) => {
    // Create checkpoint with empty worktree (delete all files)
    await rm(join(dir, "initial.txt"));
    const cp = await createCheckpoint(root, "empty-test", 0, "session-1");

    // Mess up state - add files back
    await writeFile(join(dir, "initial.txt"), "back");
    await writeFile(join(dir, "extra.txt"), "extra");
    await git("add .", dir);

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify empty
    assertArrayEquals(listFiles(dir), [], "Working tree should be empty");
  }));

test("restore: staged file is restored correctly", () =>
  withTestRepo(async (dir, root) => {
    // Stage a new file (but don't commit)
    await writeFile(join(dir, "staged.txt"), "staged content");
    await git("add staged.txt", dir);

    const cp = await createCheckpoint(root, "staged-test", 0, "session-1");

    // Mess up - remove the file
    await rm(join(dir, "staged.txt"));
    await git("reset HEAD", dir);

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify file is back and staged
    assert(listFiles(dir).includes("staged.txt"), "staged.txt should exist");
    assert(
      (await getIndexFiles(dir)).includes("staged.txt"),
      "staged.txt should be in index"
    );
    assert(
      (await readFile(join(dir, "staged.txt"), "utf-8")) === "staged content",
      "Content should match"
    );
  }));

test("restore: unstaged delete is preserved", () =>
  withTestRepo(async (dir, root) => {
    // Delete initial.txt but don't stage the deletion
    await rm(join(dir, "initial.txt"));

    // Add a new untracked file
    await writeFile(join(dir, "new.txt"), "new content");

    const cp = await createCheckpoint(root, "delete-test", 0, "session-1");

    // Mess up - restore initial.txt
    await git("checkout -- initial.txt", dir);
    await rm(join(dir, "new.txt"));

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify: initial.txt should NOT exist, new.txt should exist
    const files = listFiles(dir);
    assert(!files.includes("initial.txt"), "initial.txt should NOT exist");
    assert(files.includes("new.txt"), "new.txt should exist");

    // Index should still have initial.txt (it was staged before deletion)
    assert(
      (await getIndexFiles(dir)).includes("initial.txt"),
      "initial.txt should be in index"
    );
  }));

test("restore: untracked files are restored", () =>
  withTestRepo(async (dir, root) => {
    // Add untracked files
    await writeFile(join(dir, "untracked1.txt"), "content1");
    await writeFile(join(dir, "untracked2.txt"), "content2");

    const cp = await createCheckpoint(root, "untracked-test", 0, "session-1");

    // Mess up - remove them
    await rm(join(dir, "untracked1.txt"));
    await rm(join(dir, "untracked2.txt"));

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify files are back
    const files = listFiles(dir);
    assert(files.includes("untracked1.txt"), "untracked1.txt should exist");
    assert(files.includes("untracked2.txt"), "untracked2.txt should exist");
  }));

test("restore: extra untracked files are removed", () =>
  withTestRepo(async (dir, root) => {
    const cp = await createCheckpoint(root, "extra-test", 0, "session-1");

    // Add extra files after checkpoint
    await writeFile(join(dir, "extra1.txt"), "extra1");
    await writeFile(join(dir, "extra2.txt"), "extra2");

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify extra files are gone
    const files = listFiles(dir);
    assert(!files.includes("extra1.txt"), "extra1.txt should NOT exist");
    assert(!files.includes("extra2.txt"), "extra2.txt should NOT exist");
    assert(files.includes("initial.txt"), "initial.txt should exist");
  }));

test("restore: modified untracked file content is restored", () =>
  withTestRepo(async (dir, root) => {
    // Add untracked file with specific content
    await writeFile(join(dir, "untracked.txt"), "original content");

    const cp = await createCheckpoint(root, "untracked-modify-test", 0, "session-1");

    // Modify the untracked file
    await writeFile(join(dir, "untracked.txt"), "modified content");

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify original content is back
    assert(
      (await readFile(join(dir, "untracked.txt"), "utf-8")) === "original content",
      "Untracked file content should be restored to original"
    );
  }));

test("restore: modified file content is restored", () =>
  withTestRepo(async (dir, root) => {
    // Modify file
    await writeFile(join(dir, "initial.txt"), "modified content");

    const cp = await createCheckpoint(root, "modify-test", 0, "session-1");

    // Change it again
    await writeFile(join(dir, "initial.txt"), "changed again");

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify content
    assert(
      (await readFile(join(dir, "initial.txt"), "utf-8")) === "modified content",
      "Content should be restored"
    );
  }));

test("restore: subdirectories are handled correctly", () =>
  withTestRepo(async (dir, root) => {
    // Create subdirectory with files
    await mkdir(join(dir, "subdir"));
    await writeFile(join(dir, "subdir", "file.txt"), "subdir content");

    const cp = await createCheckpoint(root, "subdir-test", 0, "session-1");

    // Remove subdir
    await rm(join(dir, "subdir"), { recursive: true });

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify subdir is back
    assert(
      (await readFile(join(dir, "subdir", "file.txt"), "utf-8")) ===
        "subdir content",
      "Subdir file should be restored"
    );
  }));

test("restore: file in HEAD but not in worktree is removed", () =>
  withTestRepo(async (dir, root) => {
    // This was the bug: initial.txt is in HEAD commit,
    // but we delete it (unstaged) before checkpoint.
    // After restore, it should NOT be in working tree.
    await rm(join(dir, "initial.txt"));

    const cp = await createCheckpoint(
      root,
      "head-not-worktree-test",
      0,
      "session-1"
    );

    // Mess up - restore the file
    await git("checkout -- initial.txt", dir);
    assert(listFiles(dir).includes("initial.txt"), "Setup: initial.txt should exist");

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify: initial.txt should NOT exist (was deleted at checkpoint time)
    assert(
      !listFiles(dir).includes("initial.txt"),
      "initial.txt should NOT exist after restore"
    );
  }));

test("restore: complex state with mixed staged/unstaged/untracked", () =>
  withTestRepo(async (dir, root) => {
    // Complex state:
    // - initial.txt: modified and staged
    // - staged_new.txt: new file, staged
    // - unstaged_new.txt: new file, not staged
    // - to_delete.txt: will be deleted (unstaged)

    await writeFile(join(dir, "to_delete.txt"), "will delete");
    await git("add to_delete.txt", dir);
    await git("commit -m 'add to_delete'", dir);

    await writeFile(join(dir, "initial.txt"), "modified");
    await git("add initial.txt", dir);

    await writeFile(join(dir, "staged_new.txt"), "staged new");
    await git("add staged_new.txt", dir);

    await writeFile(join(dir, "unstaged_new.txt"), "unstaged new");

    await rm(join(dir, "to_delete.txt"));

    const cp = await createCheckpoint(root, "complex-test", 0, "session-1");

    // Mess everything up
    await git("reset --hard HEAD", dir);
    await writeFile(join(dir, "random.txt"), "random");

    // Restore
    await restoreCheckpoint(root, cp);

    // Verify working tree
    const files = listFiles(dir);
    assert(files.includes("initial.txt"), "initial.txt should exist");
    assert(files.includes("staged_new.txt"), "staged_new.txt should exist");
    assert(files.includes("unstaged_new.txt"), "unstaged_new.txt should exist");
    assert(!files.includes("to_delete.txt"), "to_delete.txt should NOT exist");
    assert(!files.includes("random.txt"), "random.txt should NOT exist");

    assert(
      (await readFile(join(dir, "initial.txt"), "utf-8")) === "modified",
      "initial.txt should have modified content"
    );

    // Verify index
    const indexFiles = await getIndexFiles(dir);
    assert(indexFiles.includes("initial.txt"), "initial.txt should be in index");
    assert(indexFiles.includes("staged_new.txt"), "staged_new.txt should be in index");
    assert(
      indexFiles.includes("to_delete.txt"),
      "to_delete.txt should be in index (staged before delete)"
    );
  }));

// ============================================================================
// Run tests
// ============================================================================

async function run() {
  console.log("Running checkpoint tests...\n");

  const results: TestResult[] = [];

  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      console.log("✓");
      results.push({ name, passed: true });
    } catch (error) {
      console.log("✗");
      results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log("");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  if (failed > 0) {
    console.log("Failures:\n");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ${r.name}:`);
      console.log(`    ${r.error}\n`);
    }
  }

  console.log(`${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
