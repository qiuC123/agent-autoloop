// A private capability identifies this install's live process without trusting a recycled PID.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import { writePrivateFile } from "./private.ts";

type Target = "up" | "service";
const endpoint = (home: string, target: Target) =>
  `\\\\.\\pipe\\agent-autoloop-${createHash("sha256").update(realpathSync(home).toLowerCase()).digest("hex")}${target === "up" ? "" : "-service"}`;

export function controlUp(home: string, operation: "status" | "stop", target: Target = "up") {
  try {
    const result = spawnSync(process.execPath, [import.meta.filename, home, operation, target], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    const pid = Number(result.stdout);
    return result.status === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function requestControl(
  home: string,
  operation: "status" | "stop",
  target: Target = "up",
  expectedPid?: number,
) {
  try {
    const identity = JSON.parse(readFileSync(path.join(home, `${target}.pid`), "utf8"));
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.token !== "string") return null;
    if (expectedPid !== undefined && identity.pid !== expectedPid) return null;
    return await new Promise<number | null>((resolve) => {
      const socket = connect(endpoint(home, target));
      let reply = "";
      const timer = setTimeout(() => socket.destroy(), 2_000);
      socket.on("connect", () => socket.write(JSON.stringify({ operation, token: identity.token }) + "\n"));
      socket.on("data", (data) => {
        reply += data;
        if (reply.length > 64) socket.destroy();
      });
      socket.on("error", () => {});
      socket.on("end", () => resolve(Number(reply) === identity.pid ? identity.pid : null));
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  } catch {
    return null;
  }
}

export async function listenForControl(home: string, stop: () => void, target: Target = "up") {
  const token = randomBytes(32).toString("base64url");
  const file = path.join(home, `${target}.pid`);
  const server = createServer((socket) => {
    socket.setTimeout(1_000, () => socket.destroy());
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", (data) => {
      buffer += data;
      if (buffer.length > 512) return socket.destroy();
      if (!buffer.includes("\n")) return;
      try {
        const request = JSON.parse(buffer.trim());
        if (request.token !== token || !["status", "stop"].includes(request.operation)) return socket.destroy();
        socket.end(String(process.pid), () => {
          if (request.operation === "stop") stop();
        });
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`已经在跑了或控制口打不开：${error.message}`)));
    server.listen(endpoint(home, target), resolve);
  });
  writePrivateFile(file, JSON.stringify({ pid: process.pid, token }));
  return () => {
    server.close();
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file);
  };
}

if (import.meta.main) {
  const [, , home, operation, target = "up"] = process.argv;
  if (!["status", "stop"].includes(operation) || !["up", "service"].includes(target)) process.exitCode = 1;
  else {
    const pid = await requestControl(home, operation as "status" | "stop", target as Target);
    if (pid === null) process.exitCode = 1;
    else process.stdout.write(String(pid));
  }
}
