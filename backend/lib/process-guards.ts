type ProcessRole = "app" | "worker" | "supervisor";

type ProcessGuardOptions = {
  role: ProcessRole;
  exitOnFatal: boolean;
};

const PROCESS_GUARD_KEY = Symbol.for("oddity1.processGuards");

type GuardState = {
  registeredRoles: Set<ProcessRole>;
};

function getGuardState(): GuardState {
  const globalWithState = globalThis as typeof globalThis & {
    [PROCESS_GUARD_KEY]?: GuardState;
  };

  if (!globalWithState[PROCESS_GUARD_KEY]) {
    globalWithState[PROCESS_GUARD_KEY] = {
      registeredRoles: new Set<ProcessRole>(),
    };
  }

  return globalWithState[PROCESS_GUARD_KEY]!;
}

function normalizeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: typeof error,
    message: String(error),
  };
}

function logProcessEvent(
  role: ProcessRole,
  event: string,
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    `[Oddity 1][${role}] ${event}`,
    JSON.stringify({
      pid: process.pid,
      ...extra,
      error: normalizeError(error),
    }),
  );
}

export function registerProcessGuards({
  role,
  exitOnFatal,
}: ProcessGuardOptions): void {
  const state = getGuardState();
  if (state.registeredRoles.has(role)) return;
  state.registeredRoles.add(role);

  process.on("unhandledRejection", (reason) => {
    logProcessEvent(role, "unhandledRejection", reason);

    if (exitOnFatal) {
      setImmediate(() => process.exit(1));
    }
  });

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    logProcessEvent(role, "uncaughtExceptionMonitor", error, { origin });
  });

  if (exitOnFatal) {
    process.on("uncaughtException", (error, origin) => {
      logProcessEvent(role, "uncaughtException", error, { origin });
      process.exit(1);
    });
  }
}
