// Failure mode: a concurrent Windows spawn inherits another thread's synchronous command pipes and withholds EOF.
import assert from "node:assert/strict";
import { execFileSync, fork, spawn } from "node:child_process";
import { once } from "node:events";
import { parentPort, Worker } from "node:worker_threads";

if (parentPort || process.argv.includes("--short")) {
  const send = (message: string | { ms: number; error?: string }) =>
    parentPort ? parentPort.postMessage(message) : process.send!(message);
  const start = () => {
    send("starting");
    const at = Date.now();
    let error: string | undefined;
    try {
      execFileSync(process.execPath, ["-e", ""], { windowsHide: true, timeout: 1500 });
    } catch (failure) {
      error = String(failure);
    }
    send({ ms: Date.now() - at, error });
  };
  if (parentPort) parentPort.on("message", start);
  else process.on("message", start);
  send("ready");
} else if (import.meta.main) {
  assert.equal(process.platform, "win32", "This probe measures Windows handle inheritance");
  const threaded = process.argv[2] === "threads";
  const rounds = Number(process.argv[3] ?? 20);
  assert.ok(Number.isInteger(rounds) && rounds > 0);
  const worker = threaded
    ? new Worker(new URL(import.meta.url))
    : fork(import.meta.filename, ["--short"], { windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const send = () => (worker instanceof Worker ? worker.postMessage("go") : worker.send("go"));
  const consumers = new Set<ReturnType<typeof spawn>>();
  let release: NodeJS.Timeout | undefined;
  let blocked = false;
  let stalls = 0;
  const killConsumers = () => {
    for (const consumer of consumers) consumer.kill("SIGKILL");
  };
  worker.on("message", (message) => {
    if (message !== "starting") return;
    for (let n = 0; n < 8; n++) {
      const consumer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
        windowsHide: true,
        stdio: "ignore",
      });
      consumers.add(consumer);
      consumer.once("exit", () => consumers.delete(consumer));
    }
    release = setTimeout(() => {
      blocked = true;
      killConsumers();
    }, 2000);
  });
  try {
    await once(worker, "message");
    for (let round = 0; round < rounds; round++) {
      blocked = false;
      const done = new Promise<{ ms: number; error?: string }>((resolve) => {
        const receive = (message: any) => {
          if (typeof message !== "object") return;
          worker.off("message", receive);
          resolve(message);
        };
        worker.on("message", receive);
      });
      send();
      const result = await done;
      clearTimeout(release);
      if (blocked || result.error) stalls++;
      console.log(JSON.stringify({ round, blocked, ...result }));
      const exited = [...consumers].map((consumer) => once(consumer, "exit"));
      killConsumers();
      await Promise.all(exited);
    }
    console.log(JSON.stringify({ transport: threaded ? "threads" : "process", rounds, stalls, rate: stalls / rounds }));
    process.exitCode = stalls ? 1 : 0;
  } finally {
    clearTimeout(release);
    killConsumers();
    if (worker instanceof Worker) await worker.terminate();
    else worker.kill("SIGKILL");
  }
}
