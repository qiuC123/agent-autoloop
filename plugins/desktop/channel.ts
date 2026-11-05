// The channel a new install starts with: a notification on this computer that there's something to look at. It can't take
// an answer; `agent-autoloop status` shows the card and `agent-autoloop answer` answers it.
//   "channels": { "desktop": { "key": "…" } } in config.json
//   "channels": { "desktop": { "name": "桌面通知" } } in rules.json
import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { command } from "../../host/command.ts";

const WORDS = "运行 agent-autoloop status 查看";
const TITLE = "Agent 问你一个问题";
const APPLESCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];

/**
 * Card text is data: `--` protects Unix arguments; base64 arguments keep Windows text out of PowerShell syntax.
 */
export function notifyCommand(title: string, platform: string = process.platform, fyi = false): [string, string[]] {
  if (title.includes("\0")) throw new TypeError("通知标题不能包含空字符");
  const body = `${title}\n${WORDS}`;
  const heading = fyi ? "Agent 告诉你一件事" : TITLE;
  if (platform === "darwin")
    return ["osascript", [...APPLESCRIPT.flatMap((line) => ["-e", line]), "--", heading, body]];
  if (platform === "win32")
    return [
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dirname, "notify.ps1"),
        Buffer.from(heading).toString("base64"),
        Buffer.from(body).toString("base64"),
      ],
    ];
  return ["notify-send", ["--", heading, body]];
}

function hasDesktop() {
  if (process.platform === "win32") return process.env.SESSIONNAME !== "Services";
  if (process.platform === "darwin") {
    return spawnSync("launchctl", ["print", `gui/${process.getuid!()}`], { stdio: "ignore" }).status === 0;
  }
  return process.platform === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Not the sync call the other channels get away with: this runs in the hub's own process, and may wait on a dialog. */
function show(card: Card) {
  const [program, args] = notifyCommand(card.title, process.platform, card.fyi);
  const [executable, ...argv] = command(program, args);
  return new Promise<void>((resolve, reject) => {
    execFile(executable, argv, { timeout: 30_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

export default async function desktop({ hub, log, signal }: ChannelContext) {
  const available = hasDesktop();
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`连不上中台：${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // A notification is gone once shown: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    if (!available) {
      await hub.delivered(card.id, card.version, `skipped-${card.id}`);
      continue;
    }
    try {
      await show(card);
      await hub.delivered(card.id, card.version, `shown-${card.id}`);
    } catch (error) {
      log(`卡片 ${card.id} 的桌面通知没发出：${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
