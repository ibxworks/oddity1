import { registerProcessGuards } from "../lib/process-guards.js";

process.env.ODDITY_PROCESS_ROLE = "worker";
registerProcessGuards({ role: "worker", exitOnFatal: true });
const { default: app } = await import("../api/index.js");

const port = Number(process.env.PORT ?? 3001);

app.listen(port, () => {
  console.log(`[Oddity 1] Backend worker listening on :${port} (pid ${process.pid})`);
});
