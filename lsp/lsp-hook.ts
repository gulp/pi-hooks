/**
 * LSP Hook for pi-coding-agent
 * Provides diagnostics feedback after file writes/edits.
 */

import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type { Diagnostic } from "vscode-languageserver-types";

// ============================================================================
// Config & Types
// ============================================================================

const DIAG_TIMEOUT = 3000,
  INIT_TIMEOUT = 30000,
  MAX_OPEN = 50;
const DEBUG = process.env.PI_LSP_DEBUG === "1";
const debug = (...a: unknown[]) => DEBUG && console.error("[LSP]", ...a);

interface ServerConfig {
  id: string;
  ext: string[];
  markers: string[];
  cmd: (root: string) => { bin: string; args: string[] } | undefined;
  skip?: (file: string, cwd: string) => boolean;
}

interface Client {
  conn: MessageConnection;
  proc: ChildProcessWithoutNullStreams;
  diags: Map<string, Diagnostic[]>;
  files: Map<string, { ver: number; ts: number }>;
  waiters: Map<string, Array<() => void>>;
}

const LANG: Record<string, string> = {
  ".dart": "dart",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
};

// ============================================================================
// Utilities
// ============================================================================

const HOME = process.env.HOME || "";
const PATHS = [
  ...(process.env.PATH?.split(path.delimiter) || []),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${HOME}/.pub-cache/bin`,
  `${HOME}/fvm/default/bin`,
  `${HOME}/go/bin`,
  `${HOME}/.cargo/bin`,
];

function which(cmd: string): string | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const p of PATHS) {
    const f = path.join(p, cmd + ext);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
}

function findUp(
  start: string,
  targets: string[],
  stop: string,
): string | undefined {
  for (
    let d = path.resolve(start);
    d.length >= stop.length;
    d = path.dirname(d)
  ) {
    for (const t of targets)
      if (fs.existsSync(path.join(d, t))) return path.join(d, t);
    if (d === path.dirname(d)) break;
  }
}

function findRoot(file: string, cwd: string, markers: string[]): string {
  const f = findUp(path.dirname(file), markers, cwd);
  return f ? path.dirname(f) : cwd;
}

function timeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}

const fmtDiag = (d: Diagnostic) =>
  `${["", "ERROR", "WARN", "INFO", "HINT"][d.severity || 1]} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;

// ============================================================================
// Server Configs
// ============================================================================

const simple =
  (bin: string, args: string[] = ["--stdio"]) =>
  () => {
    const b = which(bin);
    return b ? { bin: b, args } : undefined;
  };

const SERVERS: ServerConfig[] = [
  {
    id: "dart",
    ext: [".dart"],
    markers: ["pubspec.yaml", "analysis_options.yaml"],
    cmd: (root) => {
      let dart = which("dart");
      const pubspec = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspec)) {
        const c = fs.readFileSync(pubspec, "utf-8");
        if (c.includes("flutter:") || c.includes("sdk: flutter")) {
          const fl = which("flutter");
          if (fl) {
            const dir = path.dirname(fs.realpathSync(fl));
            for (const p of [
              "cache/dart-sdk/bin/dart",
              "../cache/dart-sdk/bin/dart",
            ]) {
              const x = path.join(dir, p);
              if (fs.existsSync(x)) {
                dart = x;
                break;
              }
            }
          }
        }
      }
      return dart
        ? { bin: dart, args: ["language-server", "--protocol=lsp"] }
        : undefined;
    },
  },
  {
    id: "ts",
    ext: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    markers: ["package.json", "tsconfig.json", "jsconfig.json"],
    skip: (f, cwd) =>
      !!findUp(path.dirname(f), ["deno.json", "deno.jsonc"], cwd),
    cmd: (root) => {
      const local = path.join(
        root,
        "node_modules/.bin/typescript-language-server",
      );
      const bin = fs.existsSync(local)
        ? local
        : which("typescript-language-server");
      return bin ? { bin, args: ["--stdio"] } : undefined;
    },
  },
  {
    id: "vue",
    ext: [".vue"],
    markers: ["package.json"],
    cmd: simple("vue-language-server"),
  },
  {
    id: "svelte",
    ext: [".svelte"],
    markers: ["package.json"],
    cmd: simple("svelteserver"),
  },
  {
    id: "pyright",
    ext: [".py", ".pyi"],
    markers: ["pyproject.toml", "setup.py", "requirements.txt"],
    cmd: simple("pyright-langserver"),
  },
  {
    id: "gopls",
    ext: [".go"],
    markers: ["go.work", "go.mod"],
    cmd: simple("gopls", []),
  },
  {
    id: "rust",
    ext: [".rs"],
    markers: ["Cargo.toml"],
    cmd: simple("rust-analyzer", []),
  },
];

// Extension -> config lookup
const EXT_CFG = new Map<string, ServerConfig>();
for (const s of SERVERS) for (const e of s.ext) EXT_CFG.set(e, s);

// ============================================================================
// LSP Manager
// ============================================================================

class LSPManager {
  private clients = new Map<string, Client>();
  private pending = new Map<string, Promise<Client | undefined>>();
  private broken = new Set<string>();

  constructor(private cwd: string) {}

  private async create(
    cfg: ServerConfig,
    root: string,
  ): Promise<Client | undefined> {
    const key = `${cfg.id}:${root}`;
    try {
      const c = cfg.cmd(root);
      if (!c) {
        this.broken.add(key);
        return;
      }

      debug(`Spawn ${cfg.id}: ${c.bin}`);
      const proc = spawn(c.bin, c.args, {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const conn = createMessageConnection(
        new StreamMessageReader(proc.stdout!),
        new StreamMessageWriter(proc.stdin!),
      );

      const client: Client = {
        conn,
        proc,
        diags: new Map(),
        files: new Map(),
        waiters: new Map(),
      };

      conn.onNotification(
        "textDocument/publishDiagnostics",
        (p: { uri: string; diagnostics: Diagnostic[] }) => {
          const f = decodeURIComponent(new URL(p.uri).pathname);
          client.diags.set(f, p.diagnostics);
          client.waiters.get(f)?.forEach((r) => r());
          client.waiters.delete(f);
        },
      );

      conn.onRequest("workspace/configuration", () => [{}]);
      conn.onRequest("window/workDoneProgress/create", () => null);
      conn.onRequest("client/registerCapability", () => {});
      conn.onRequest("client/unregisterCapability", () => {});
      conn.onRequest("workspace/workspaceFolders", () => [
        { name: "ws", uri: `file://${root}` },
      ]);

      proc.on("exit", () => this.clients.delete(key));
      proc.on("error", () => {
        this.clients.delete(key);
        this.broken.add(key);
      });

      conn.listen();

      const ws = [{ name: "ws", uri: `file://${root}` }];
      await timeout(
        conn.sendRequest("initialize", {
          rootUri: `file://${root}`,
          processId: process.pid,
          workspaceFolders: ws,
          capabilities: {
            window: { workDoneProgress: true },
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: {
                didOpen: true,
                didChange: true,
                didClose: true,
              },
              publishDiagnostics: { versionSupport: true },
            },
          },
        }),
        INIT_TIMEOUT,
        `${cfg.id} init timeout`,
      );

      conn.sendNotification("initialized", {});
      debug(`${cfg.id} ready at ${root}`);
      return client;
    } catch (e) {
      debug(`Create ${cfg.id} failed:`, e);
      this.broken.add(key);
    }
  }

  private async getClient(file: string): Promise<Client | undefined> {
    const cfg = EXT_CFG.get(path.extname(file));
    if (!cfg) return;

    const abs = path.isAbsolute(file) ? file : path.resolve(this.cwd, file);
    if (cfg.skip?.(abs, this.cwd)) return;

    const root = findRoot(abs, this.cwd, cfg.markers);
    const key = `${cfg.id}:${root}`;

    if (this.broken.has(key)) return;
    if (this.clients.has(key)) return this.clients.get(key);

    if (!this.pending.has(key)) {
      const p = this.create(cfg, root);
      this.pending.set(key, p);
      p.finally(() => this.pending.delete(key));
    }

    const client = await this.pending.get(key);
    if (client) this.clients.set(key, client);
    return client;
  }

  private prune(c: Client) {
    if (c.files.size <= MAX_OPEN) return;
    const sorted = Array.from(c.files.entries()).sort(
      (a, b) => a[1].ts - b[1].ts,
    );
    for (const [f] of sorted.slice(0, sorted.length - MAX_OPEN)) {
      try {
        c.conn.sendNotification("textDocument/didClose", {
          textDocument: { uri: `file://${f}` },
        });
      } catch {}
      c.files.delete(f);
      c.diags.delete(f);
    }
  }

  async getDiagnostics(file: string, ms: number): Promise<Diagnostic[]> {
    const abs = path.isAbsolute(file) ? file : path.resolve(this.cwd, file);
    const client = await this.getClient(abs);
    if (!client) return [];

    let content: string;
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch {
      return [];
    }

    const uri = `file://${abs}`,
      lang = LANG[path.extname(file)] || "plaintext",
      now = Date.now();
    client.diags.delete(abs);

    // Set up waiter BEFORE notification (avoid race)
    const wait = new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      const w = client.waiters.get(abs) || [];
      w.push(() => {
        clearTimeout(t);
        res();
      });
      client.waiters.set(abs, w);
    });

    try {
      const info = client.files.get(abs);
      if (info) {
        info.ver++;
        info.ts = now;
        await client.conn.sendNotification("textDocument/didChange", {
          textDocument: { uri, version: info.ver },
          contentChanges: [{ text: content }],
        });
      } else {
        client.files.set(abs, { ver: 0, ts: now });
        await client.conn.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId: lang, version: 0, text: content },
        });
        this.prune(client);
      }
    } catch {
      return [];
    }

    await wait;
    return client.diags.get(abs) || [];
  }

  async shutdown() {
    debug("Shutdown...");
    await Promise.all(
      Array.from(this.clients.values()).map(async (c) => {
        try {
          await Promise.race([
            c.conn.sendRequest("shutdown"),
            new Promise((r) => setTimeout(r, 1000)),
          ]);
          c.conn.sendNotification("exit");
          c.conn.end();
        } catch {}
        c.proc.kill();
      }),
    );
    this.clients.clear();
  }
}

// ============================================================================
// Hook
// ============================================================================

export default function (pi: HookAPI) {
  let mgr: LSPManager | null = null;

  pi.on("session_start", (_, ctx) => {
    mgr = new LSPManager(ctx.cwd);
  });
  pi.on("session_end", async () => {
    await mgr?.shutdown();
    mgr = null;
  });

  pi.on("tool_result", async (ev, ctx) => {
    if (!mgr || (ev.toolName !== "write" && ev.toolName !== "edit")) return;
    const file = ev.input.path as string;
    if (!file || !EXT_CFG.has(path.extname(file))) return;

    try {
      const diags = await mgr.getDiagnostics(file, DIAG_TIMEOUT);
      // Edit: errors only (mid-fix). Write: all (full picture)
      const filtered =
        ev.toolName === "edit" ? diags.filter((d) => d.severity === 1) : diags;
      if (!filtered.length) return;

      const abs = path.isAbsolute(file) ? file : path.resolve(ctx.cwd, file);
      const rel = path.relative(ctx.cwd, abs);
      const errs = filtered.filter((d) => d.severity === 1).length;

      const lines = filtered
        .slice(0, 5)
        .map(
          (d) =>
            `${d.severity === 1 ? "ERROR" : "WARN"}[${d.range.start.line + 1}] ${d.message.split("\n")[0]}`,
        );
      let msg = `📋 ${rel}\n${lines.join("\n")}`;
      if (filtered.length > 5) msg += `\n... +${filtered.length - 5} more`;

      ctx.hasUI
        ? ctx.ui.notify(msg, errs ? "error" : "warning")
        : console.error(msg);

      return {
        result:
          ev.result +
          `\nThis file has errors, please fix\n<file_diagnostics>\n${filtered.map(fmtDiag).join("\n")}\n</file_diagnostics>\n`,
      };
    } catch (e) {
      debug("Diag error:", e);
    }
  });
}
