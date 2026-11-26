import { loadConnectConfig } from "./config.ts";
import { startConnectServer } from "./server.ts";

const config = loadConnectConfig();
const instance = await startConnectServer(config);

console.log(
  `[lunacode-connect] listening on http://${config.host}:${instance.port} (publicOrigin=${config.publicOrigin})`,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[lunacode-connect] shutting down on ${signal}`);
  await instance.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
