// A private capability identifies this install's live process without trusting a recycled PID.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import { writePrivateFile } from "./private.ts";

const endpoint = (home: string) =>
  `\\\\.\\pipe\\agent-autoloop-${createHash("sha256").update(realpathSync(home).toLowerCase()).digest("hex")}`;

export function controlUp(home: string, operation: "status" | "stop") {
  try {
    const identity = JSON.parse(readFileSync(path.join(home, "up.pid"), "utf8"));
    if (!Number.isSafeInteger(identity.pid) || typeof identity.token !== "string") return null;
    const result = spawnSync(process.execPath, [import.meta.filename, home, operation], {
      encoding: "utf8",
      input: identity.token,
      timeout: 3_000,
      windowsHide: true,
    });
    return result.status === 0 && Number(result.stdout) === identity.pid ? (identity.pid as number) : null;
  } catch {
    return null;
  }
}

export async function listenForControl(home: string, stop: () => void) {
  const token = randomBytes(32).toString("base64url");
  const file = path.join(home, "up.pid");
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
    server.listen(endpoint(home), resolve);
  });
  writePrivateFile(file, JSON.stringify({ pid: process.pid, token }));
  return () => {
    server.close();
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file);
  };
}

if (import.meta.main) {
  const [, , home, operation] = process.argv;
  const token = readFileSync(0, "utf8");
  const socket = connect(endpoint(home));
  socket.setTimeout(2_000, () => socket.destroy(new Error("控制口没有回答")));
  socket.on("connect", () => socket.write(JSON.stringify({ operation, token }) + "\n"));
  socket.on("data", (data) => process.stdout.write(data));
  socket.on("error", () => {
    process.exitCode = 1;
  });
}
