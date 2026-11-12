import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { rows } from "../kernel/evolve.ts";
import { AuthError, Conflict } from "../kernel/errors.ts";
import { credential } from "../kernel/credentials.ts";
import { World, environment } from "./world.ts";

export function random(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
export function simulate(seed = 0x5eed, steps = 200000) {
  const rng = random(seed);
  const start = performance.now();
  const faults: Record<string, number> = {
    lost: 0,
    duplicate: 0,
    restart: 0,
    offline: 0,
    channel: 0,
    clock: 0,
    update: 0,
    staleAnswer: 0,
    fyi: 0,
    continue: 0,
    reopen: 0,
    changeKind: 0,
  };
  let world = new World();
  let completed = 0;
  const receipts: { id: number; token: string; body: object; ack: object }[] = [];
  for (let step = 0; step < steps; step++) {
    try {
      if (step && step % 128 === 0) {
        completed += world.recover();
        world.view.close();
        world = new World();
        receipts.length = 0;
      }
      world.advance(rng(30000));
      const op = rng(15);
      const live = rows(world.view, "runs").filter((r) => ["claimed", "unknown"].includes(r.state));
      if (op < 3) {
        const id = String(rng(16));
        const args = ["app", { id, type: rng(2) ? "one" : "two", subject: `#${rng(4)}` }];
        world.call("ingest", ...args);
        if (op === 0) {
          faults.duplicate++;
          assert.equal(world.call("ingest", ...args).duplicate, true);
        }
      } else if (op === 3 || op === 4) {
        const worker = rng(2) ? "w1" : "w2";
        const claim = `claim-${rng(4)}`;
        world.call(
          "heartbeat",
          worker,
          live.filter((r) => r.agent === (worker === "w1" ? "a" : "b") && rng(3) !== 0).map((r) => r.id),
        );
        world.alarm();
        const job = world.call("claimNext", worker, claim);
        if (op === 4 && job) {
          faults.lost++;
          const again = world.call("claimNext", worker, claim);
          assert.equal(again.run, job.run);
        }
      } else if (op === 5 && live.length) {
        const r = live[rng(live.length)];
        const fail = rng(4) === 0;
        const fyi = rng(4) === 0;
        if (fyi) faults.fyi++;
        const body = {
          outcome: fail ? "failed" : "done",
          ...(fyi ? { notice: [{ title: "进度", text: `处理到 ${step}`, key: "progress", fyi: true }] } : {}),
          ...(!fail && rng(4) === 0
            ? {
                ask: [{ title: "选择", text: "内容", options: ["甲", "乙"], key: "question" }],
                later: [{ key: `timer-${r.id}`, at: new Date(world.now + 60000).toISOString(), about: "复查" }],
              }
            : {}),
        };
        const token = credential(environment, "run", r.id, r.issued);
        const ack = world.call("finish", r.id, token, body);
        receipts.push({ id: r.id, token, body, ack });
      } else if (op === 6 && receipts.length) {
        faults.lost++;
        const r = receipts[rng(receipts.length)];
        const current = world.view.get("runs", r.id);
        const valid =
          current?.last_issued !== null &&
          current &&
          credential(environment, "run", r.id, current.last_issued) === r.token;
        if (valid) assert.deepEqual(world.call("finish", r.id, r.token, r.body), { ...r.ack, duplicate: true });
        else assert.throws(() => world.call("finish", r.id, r.token, r.body), AuthError);
      } else if (op === 7) {
        faults.restart++;
        world.restart();
      } else if (op === 8) {
        faults.offline++;
        world.advance(700000);
      } else if (op === 9) {
        faults.channel++;
        const card = world.call("nextCard", "chat");
        if (card) {
          if (rng(2)) world.call("failed", "chat", card.id, card.version, "模拟断线");
          else {
            world.call("delivered", "chat", card.id, card.version, `message-${card.id}`);
            if (card.state === "open")
              world.call("answer", card.id, {
                choice: 0,
                version: card.version,
                by: "owner",
                channel: "chat",
                ref: `message-${card.id}`,
              });
          }
        }
      } else if (op === 10) {
        faults.clock++;
        world.advance(-rng(120000));
      } else if (op === 12) {
        const card = rows(world.view, "cards").find((c) => c.kind === "ask" && c.state === "open");
        if (card) {
          world.call("ingest", "app", { id: `update-${step}`, type: card.rule, subject: card.lane });
          const job = world.call("claimNext", card.agent === "a" ? "w1" : "w2", `update-${step}`);
          if (job) {
            const matching =
              job.rule.name === card.rule && job.context.events.some((e: any) => e.subject === card.lane);
            world.finish(job.run, {
              outcome: "done",
              ask: [
                {
                  title: "选择",
                  text: `新内容 ${step}`,
                  options: ["甲", "乙"],
                  key: card.key.slice(`thread:${card.rule}:${card.lane}:`.length),
                },
              ],
            });
            if (matching) {
              faults.update++;
              assert.equal(world.view.get("cards", card.id)!.version, card.version + 1);
            }
          }
        }
      } else if (op === 14) {
        const candidates = rows(world.view, "cards", { rule: "one" }).filter((card) =>
          card.key.startsWith(`thread:one:${card.lane}:`),
        );
        const card = candidates[rng(candidates.length)];
        if (card) {
          world.call("ingest", "app", { id: `continue-${step}`, type: "one", subject: card.lane });
          const job = world.call("claimNext", "w1", `continue-${step}`);
          if (job) {
            const key = card.key.slice(`thread:${card.rule}:${card.lane}:`.length);
            const fyi = rng(2) === 0;
            const spec = { key, title: "进度", text: `续用 ${step}`, continue: true };
            world.finish(job.run, {
              outcome: "done",
              ...(fyi ? { notice: [{ ...spec, fyi: true }] } : { ask: [{ ...spec, options: ["甲", "乙"] }] }),
            });
            const updated = world.view.get("cards", card.id)!;
            if (updated.content_version > card.content_version) {
              faults.continue++;
              if (card.state !== "open" && updated.state === "open") faults.reopen++;
              if (card.kind !== updated.kind) faults.changeKind++;
            }
          }
        }
      } else if (op === 13) {
        const card = rows(world.view, "cards").find((c) => c.content_version > 1);
        if (card) {
          faults.staleAnswer++;
          const seq = world.view.seq;
          assert.throws(
            () => world.call("answer", card.id, { choice: 0, version: card.content_version - 1 }),
            Conflict,
          );
          assert.equal(world.view.seq, seq, "拒绝旧回答也写了日志");
        }
      } else {
        const card = rows(world.view, "cards").find((c) => c.kind === "ask");
        if (card) {
          world.call("answer", card.id, { choice: rng(2) });
          world.call("answer", card.id, { choice: rng(2) });
        } else world.alarm();
      }
    } catch (error) {
      throw new Error(`种子 ${seed}，第 ${step} 步；node sim/random.ts ${seed} ${step + 1}`, { cause: error });
    }
  }
  completed += world.recover();
  world.view.close();
  const ms = performance.now() - start;
  return { seed, steps, epoch: 128, faults, completed, ms, stepsPerSecond: Math.round((steps * 1000) / ms) };
}
if (import.meta.main)
  console.log(JSON.stringify(simulate(Number(process.argv[2] ?? 0x5eed), Number(process.argv[3] ?? 200000)), null, 2));
