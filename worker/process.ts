// Windows synchronous preparation needs both a separate event loop and a separate process handle table.
import type { Config } from "../host/config.ts";
import { hubClient } from "../protocol/client.ts";
import { createWorker } from "./worker.ts";

type Options = NonNullable<Config["worker"]> & { url: string };
process.once("disconnect", () => process.exit(0));
const options = new Promise<Options>((resolve) => process.once("message", resolve));
process.send!("booted");
const { url, key, name, capacity, unreachable } = await options;
let ready = false;
const worker = createWorker({
  hub: hubClient(url, key),
  name,
  capacity,
  unreachable,
  log: (line) => console.log(`${new Date().toISOString()} [worker] ${line}`),
  progress: () => {
    process.send!(ready ? "heartbeat" : "ready");
    ready = true;
  },
});
await worker.run(new AbortController().signal);
