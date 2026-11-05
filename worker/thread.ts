// Windows process preparation blocks; keep it on its own event loop in the same lifetime as `up`.
import { workerData } from "node:worker_threads";
import type { Config } from "../host/config.ts";
import { hubClient } from "../protocol/client.ts";
import { createWorker } from "./worker.ts";

const { url, key, name, capacity, unreachable } = workerData as NonNullable<Config["worker"]> & { url: string };
const worker = createWorker({
  hub: hubClient(url, key),
  name,
  capacity,
  unreachable,
  log: (line) => console.log(`${new Date().toISOString()} [worker] ${line}`),
});
await worker.run(new AbortController().signal);
