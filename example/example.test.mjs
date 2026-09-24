import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import example, { marked, mentions } from "./index.mjs";

const refuse = (status, message) => Object.assign(new Error(message), { status });

function fakeHive() {
  const held = new Map();
  const hooks = {};
  return {
    hooks,
    hive: {
      name: "example",
      log: () => {},
      refuse,
      storage: { get: (k) => held.get(k), set: (k, v) => held.set(k, v), remove: (k) => held.delete(k), all: () => Object.fromEntries(held), clear: () => held.clear() },
      paths: { dir: "/x", support: "/x/support", hub: "/hub" },
      on: (hook, fn) => { hooks[hook] = fn; }
    }
  };
}

const settings = (over = {}) => ({ mark: "★", word: "example", loud: false, where: "title", token: "", ...over });

test("the manifest declares exactly the hooks the module registers, and one setting of each kind", () => {
  const manifest = JSON.parse(readFileSync(new URL("./extension.json", import.meta.url), "utf8"));
  const { hooks, hive } = fakeHive();
  example(hive);
  assert.deepEqual(Object.keys(hooks).sort(), [...manifest.hooks].sort());
  assert.deepEqual(Object.values(manifest.settings).map((s) => s.type).sort(), ["boolean", "dropdown", "password", "string", "string"]);
  assert.equal(manifest.name, "example");
});

test("seat.title marks the chats whose mission mentions the word, counts them in storage, and leaves the rest alone", () => {
  const { hooks, hive } = fakeHive();
  example(hive);
  const one = hooks["seat.title"]({ title: "fix the login", mission: "an example mission\nmore", settings: settings() });
  assert.equal(one, "★ fix the login");
  assert.equal(hooks["seat.title"]({ title: "★ fix the login", mission: "example again", settings: settings({ loud: true }) }), "★ fix the login (2)", "the mark is never doubled; loud appends the count");
  assert.equal(hooks["seat.title"]({ title: "unrelated", mission: "nothing here", settings: settings() }), "unrelated");
  assert.equal(hooks["seat.title"]({ title: "x", mission: "example", settings: settings({ where: "mission" }) }), "x", "the dropdown moves the work to the other hook");
  assert.equal(hive.storage.get("seen"), 2);
});

test("seat.opening fills the errand from the mission when asked to, and stays quiet otherwise", async () => {
  const { hooks, hive } = fakeHive();
  example(hive);
  assert.equal(await hooks["seat.opening"]({ body: {}, prompt: "an example mission", settings: settings() }), undefined);
  const opened = await hooks["seat.opening"]({ body: { errand: "" }, prompt: "an example mission\nsecond line", settings: settings({ where: "mission" }) });
  assert.equal(opened.body.errand, "★ an example mission");
  const kept = await hooks["seat.opening"]({ body: { errand: "mine" }, prompt: "example", settings: settings({ where: "mission" }) });
  assert.equal(kept.body.errand, "mine", "what the person set wins");
});

test("routes live under /api/ext/example/, read the storage, and refuse with a status instead of throwing", async () => {
  const { hooks, hive } = fakeHive();
  example(hive);
  const routes = [];
  hooks.routes((method, path, fn) => routes.push({ method, path, fn }));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ["GET /api/ext/example/seen", "POST /api/ext/example/reset"]);
  hive.storage.set("seen", 3);
  assert.deepEqual(await routes[0].fn({}), { seen: 3 });
  await assert.rejects(routes[1].fn({ body: {} }), (wrong) => wrong.status === 400);
  assert.deepEqual(await routes[1].fn({ body: { really: true } }), { seen: 0 });
  assert.equal(hive.storage.get("seen"), undefined);
});

test("the pure helpers", () => {
  assert.equal(mentions("Example: fix it\nnot here", "example"), true);
  assert.equal(mentions("fix it\nexample later", "example"), false, "only the first line of the mission counts");
  assert.equal(mentions("anything", ""), false);
  assert.equal(marked("t", "★", 1, false), "★ t");
  assert.equal(marked("★ t", "★", 4, true), "★ t (4)");
});
