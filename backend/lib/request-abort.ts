import type { Request, Response } from "express";

export function createRequestAbortSignal(req: Request, res: Response): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  req.on("aborted", abort);
  req.on("close", abort);
  res.on("close", abort);

  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("aborted", abort);
      req.off("close", abort);
      res.off("close", abort);
    },
  };
}
