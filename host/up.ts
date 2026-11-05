// Everything this machine does: the hub, the worker and its channels, whichever config.json says. They
// speak the same protocol to each other here as they would across the world. A stop leaves agents running: they're
// detached, and the worker finds them again when it's back.
import { existsSync, mkdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { loadChannel } from "./channels.ts";
import { readConfig, type ChannelConfig } from "./config.ts";
import { HOME } from "./home.ts";
import { privateDirectory } from "./private.ts";
import { runningUp } from "./service.ts";
import { listenForControl } from "./windows-control.ts";
import { commitOf } from "./version.ts";
import { hubClient } from "../protocol/client.ts";
import { createWorker } from "../worker/worker.ts";

const log = (who: string) => (line: string) => console.log(`${new Date().toISOString()} [${who}] ${line}`);

/** Only one of these per install: a second would take work beside the first. */
function lock() {
  const running = runningUp();
  if (running !== null) throw new Error(`已经在跑了（进程 ${running}）`);
  const file = path.join(HOME, "up.pid");
  writeFileSync(file, String(process.pid));
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}

/** secrets.env: what an adapter needs to check a webhook, kept out of rules.json. */
function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** A channel that stops for any reason is started again. */
async function keepChannelRunning(
  id: string,
  { use, key, ...options }: ChannelConfig,
  url: string,
  signal: AbortSignal,
) {
  const say = log(id);
  while (!signal.aborted) {
    try {
      const start = await loadChannel(use ?? id);
      await start({ hub: hubClient(url, key), options, log: say, signal });
    } catch (error) {
      say(`stopped: ${error}; starting again in 30 seconds`);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}

export async function up() {
  const config = readConfig();
  privateDirectory(HOME);
  const stop = new AbortController();
  const jobs: Promise<unknown>[] = [];
  let close = () => {};
  let unlock = () => {};
  const finish = () => {
    stop.abort();
    close();
    unlock();
    process.exit(0);
  };
  unlock = process.platform === "win32" ? await listenForControl(HOME, finish) : lock();
  if (config.hub) {
    loadSecrets();
    const [host, port] = config.hub.listen.split(":");
    process.env.AGENT_AUTOLOOP_PUBLIC_URL = config.hub.publicUrl ?? `http://${config.hub.listen}`;
    const { serve } = await import("./http.ts");
    const say = log("hub");
    const server = serve(Number(port), host, { commit: await commitOf() });
    server.on("listening", () => say(`listening on ${config.hub!.listen}`));
    server.on("error", (error) => {
      say(`can't listen: ${error}`);
      process.exit(1);
    });
    close = () => {
      server.close();
      server.closeAllConnections();
    };
  }
  if (config.worker) {
    if (process.platform === "win32") {
      // Separate handle tables prevent channel children inheriting synchronous worker command pipes.
      // Non-detached children belong to libuv's Windows Job and die with up, even during a native call.
      const worker = fork(new URL("../worker/process.ts", import.meta.url), {
        windowsHide: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      jobs.push(
        new Promise<void>((_resolve, reject) => {
          let ready = false;
          let timer: NodeJS.Timeout;
          const arm = (ms: number) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              try {
                writeSync(
                  2,
                  `${new Date().toISOString()} [worker] 接单进程${ready ? "心跳" : "启动"}超时，退出等待服务重启\n`,
                );
              } finally {
                process.kill(process.pid, "SIGKILL");
              }
            }, ms);
          };
          arm(30_000);
          worker.on("message", (message) => {
            if (message === "booted") {
              worker.send({ url: config.url, ...config.worker }, (error) => {
                if (error) failed(error);
              });
            } else if (message === "ready" && !ready) {
              ready = true;
              arm(120_000);
            } else if (message === "heartbeat" && ready) {
              arm(120_000);
            }
          });
          const failed = (error: Error) => {
            clearTimeout(timer);
            reject(error);
          };
          worker.once("error", failed);
          worker.once("exit", (code, signal) => failed(new Error(`接单进程退出了（${code ?? signal}）`)));
        }),
      );
    } else {
      const { key, name, capacity, unreachable } = config.worker;
      const worker = createWorker({ hub: hubClient(config.url, key), name, capacity, unreachable, log: log("worker") });
      jobs.push(worker.run(stop.signal));
    }
  }
  for (const [id, channel] of Object.entries(config.channels ?? {})) {
    jobs.push(keepChannelRunning(id, channel, config.url, stop.signal));
  }
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  await Promise.all(jobs);
}
