import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import { ChangeSignal, EventBus } from "../src/core/events.ts";
import { ModelCatalog } from "../src/core/model-catalog.ts";
import { SerialQueue } from "../src/core/serial-queue.ts";

describe("EventBus", () => {
  it("stamps events, delivers them in order and stops after unsubscribe", () => {
    const bus = new EventBus<{ type: "tick"; n: number }>();
    const seen: number[] = [];
    const stop = bus.subscribe((event) => {
      expect(Date.parse(event.at)).not.toBeNaN();
      seen.push(event.n);
    });
    bus.emit({ type: "tick", n: 1 });
    bus.emit({ type: "tick", n: 2 });
    stop();
    bus.emit({ type: "tick", n: 3 });
    expect(seen).toEqual([1, 2]);
  });

  it("reports a throwing listener to the logger it was given", () => {
    const warnings: string[] = [];
    const bus = new EventBus<{ type: "tick" }>({ warn: (message) => warnings.push(message) });
    bus.subscribe(() => {
      throw new Error("ui bug");
    });
    bus.emit({ type: "tick" });
    expect(warnings).toEqual(["orca-pod: an event listener threw: ui bug"]);
  });

  it("keeps delivering when a listener throws", () => {
    const bus = new EventBus<{ type: "tick" }>();
    let delivered = 0;
    bus.subscribe(() => {
      throw new Error("ui bug");
    });
    bus.subscribe(() => {
      delivered += 1;
    });
    expect(() => bus.emit({ type: "tick" })).not.toThrow();
    expect(delivered).toBe(1);
  });
});

describe("ChangeSignal", () => {
  it("notifies every subscriber, survives a throwing one and can be cleared", () => {
    const signal = new ChangeSignal();
    let calls = 0;
    signal.subscribe(() => {
      throw new Error("ui bug");
    });
    const stop = signal.subscribe(() => {
      calls += 1;
    });
    signal.notify();
    expect(calls).toBe(1);
    stop();
    signal.notify();
    expect(calls).toBe(1);
    signal.subscribe(() => {
      calls += 10;
    });
    signal.clear();
    signal.notify();
    expect(calls).toBe(1);
  });

  it("reports a throwing subscriber to the logger it was given", () => {
    const warnings: string[] = [];
    const signal = new ChangeSignal({ warn: (message) => warnings.push(message) });
    let reached = false;
    signal.subscribe(() => {
      throw new Error("ui bug");
    });
    signal.subscribe(() => {
      reached = true;
    });
    expect(() => signal.notify()).not.toThrow();
    expect(reached).toBe(true);
    expect(warnings).toEqual(["orca-pod: a change listener threw: ui bug"]);
  });

  it("lets a listener unsubscribe itself while being notified", () => {
    const signal = new ChangeSignal();
    const seen: string[] = [];
    const stop = signal.subscribe(() => {
      seen.push("once");
      stop();
    });
    signal.subscribe(() => seen.push("always"));
    signal.notify();
    signal.notify();
    expect(seen).toEqual(["once", "always", "always"]);
  });
});

describe("SerialQueue", () => {
  it("runs operations one at a time, in order", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const slow = queue.run(async () => {
      log.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push("a:end");
      return "a";
    });
    const fast = queue.run(async () => {
      log.push("b");
      return "b";
    });
    expect(await Promise.all([slow, fast])).toEqual(["a", "b"]);
    expect(log).toEqual(["a:start", "a:end", "b"]);
  });

  it("reports a failure to its caller without blocking the next operation", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("drain waits for everything queued, failed or not", async () => {
    const queue = new SerialQueue();
    let done = false;
    void queue
      .run(async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    void queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      done = true;
    });
    await queue.drain();
    expect(done).toBe(true);
  });
});

describe("ModelCatalog", () => {
  const offer = (id: string) => ({ provider: "p", id, name: id });
  const model = (id: string, reasoningEffort?: string) => ({
    provider: "p",
    model: id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
  });

  it("starts from the pins in config", () => {
    const catalog = new ModelCatalog({ models: [offer("a")], default_model: model("a", "high") });
    expect(catalog.offers()).toEqual([offer("a")]);
    expect(catalog.defaults()).toEqual({ model: model("a", "high"), reasoningEffort: "high" });
  });

  it("takes the host's list, drops a repeated route and signals the change", () => {
    const catalog = new ModelCatalog();
    let changes = 0;
    catalog.changes.subscribe(() => {
      changes += 1;
    });
    catalog.update([offer("a"), offer("b"), offer("a")], model("b"), ReasoningEffortId("low"));
    expect(catalog.offers().map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(catalog.defaults()).toEqual({ model: model("b", "low"), reasoningEffort: "low" });
    expect(changes).toBe(1);
  });

  it("lets a pinned default win over what the host reports", () => {
    const catalog = new ModelCatalog({
      default_model: model("pinned"),
      default_reasoning_effort: ReasoningEffortId("max"),
    });
    catalog.update([offer("x")], model("reported", "low"));
    expect(catalog.defaults()).toEqual({ model: model("pinned", "max"), reasoningEffort: "max" });
  });

  it("hands out copies of its offers", () => {
    const catalog = new ModelCatalog({ models: [offer("a")] });
    catalog.offers().pop();
    expect(catalog.offers()).toHaveLength(1);
  });
});
