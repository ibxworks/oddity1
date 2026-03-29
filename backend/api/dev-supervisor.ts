import { ChildProcess, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerProcessGuards } from "../lib/process-guards.js";

registerProcessGuards({ role: "supervisor", exitOnFatal: false });

const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 5000;
const STABLE_UPTIME_MS = 30000;
const POLL_INTERVAL_MS = 750;
const WATCH_TARGETS = [
  "api",
  "lib",
  "config",
  "package.json",
  "tsconfig.json",
];

let child: ChildProcess | null = null;
let restartCount = 0;
let shuttingDown = false;
let lastStartAt = 0;
let restartingForCodeChange = false;
let pollTimer: NodeJS.Timeout | null = null;
let lastSnapshot = "";

function getRestartDelay(restarts: number): number {
  const expDelay = RESTART_BASE_DELAY_MS * 2 ** Math.max(0, restarts - 1);
  return Math.min(expDelay, RESTART_MAX_DELAY_MS);
}

function startWorker(): void {
  lastStartAt = Date.now();
  child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "api/server.ts"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );

  child.on("exit", (code, signal) => {
    const workerUptime = Date.now() - lastStartAt;
    if (workerUptime >= STABLE_UPTIME_MS) {
      restartCount = 0;
    }

    child = null;

    if (shuttingDown) return;

    if (restartingForCodeChange) {
      restartingForCodeChange = false;
      restartCount = 0;
      startWorker();
      return;
    }

    restartCount += 1;
    const delayMs = getRestartDelay(restartCount);
    console.warn(
      `[Oddity 1][supervisor] Worker exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Restarting in ${delayMs}ms...`,
    );

    setTimeout(() => {
      if (!shuttingDown) startWorker();
    }, delayMs);
  });
}

function collectSnapshotEntries(targetPath: string, relativePath = targetPath): string[] {
  try {
    const stats = statSync(targetPath);

    if (stats.isDirectory()) {
      const entries = readdirSync(targetPath, { withFileTypes: true });
      return entries.flatMap((entry) =>
        collectSnapshotEntries(
          join(targetPath, entry.name),
          `${relativePath}/${entry.name}`,
        ),
      );
    }

    return [`${relativePath}:${stats.size}:${stats.mtimeMs}`];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${relativePath}:missing:${message}`];
  }
}

function buildSnapshot(): string {
  return WATCH_TARGETS.flatMap((target) =>
    collectSnapshotEntries(resolve(process.cwd(), target), target),
  )
    .sort()
    .join("|");
}

function scheduleCodeRestart(reason: string): void {
  if (shuttingDown || restartingForCodeChange) return;
  restartingForCodeChange = true;
  console.log(`[Oddity 1][supervisor] Reloading worker after change in ${reason}`);

  if (child && !child.killed) {
    child.kill("SIGTERM");
    return;
  }

  restartingForCodeChange = false;
  startWorker();
}

function startPolling(): void {
  lastSnapshot = buildSnapshot();
  pollTimer = setInterval(() => {
    if (shuttingDown) return;

    const nextSnapshot = buildSnapshot();
    if (nextSnapshot === lastSnapshot) return;

    lastSnapshot = nextSnapshot;
    scheduleCodeRestart("backend sources");
  }, POLL_INTERVAL_MS);
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Oddity 1][supervisor] Received ${signal}, shutting down...`);

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (child && !child.killed) {
    child.kill(signal);
  }

  setTimeout(() => process.exit(0), 100);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startPolling();
startWorker();
