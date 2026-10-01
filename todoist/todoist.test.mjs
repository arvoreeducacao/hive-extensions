import { test } from "node:test";
import assert from "node:assert/strict";
import todoist, { createTodoist } from "./index.mjs";

function fakeStorage() {
  let held = {};
  return {
    get: (key) => (held[key] === undefined ? undefined : structuredClone(held[key])),
    set: (key, value) => { held = { ...held, [key]: structuredClone(value) }; },
    remove: (key) => { const next = { ...held }; delete next[key]; held = next; },
    all: () => structuredClone(held),
    clear: () => { held = {}; }
  };
}

function fakeTodoist() {
  const state = { projects: [], items: [], seen: [], version: 0 };
  let next = 100;
  const touch = (item) => { state.version += 1; item.v = state.version; };
  const fetchImpl = async (url, { headers, body }) => {
    assert.equal(url, "https://api.todoist.com/api/v1/sync");
    assert.equal(headers.authorization, "Bearer tok");
    const form = Object.fromEntries(body.entries());
    state.seen.push(form);
    if (form.commands) {
      const temp_id_mapping = {};
      const sync_status = {};
      for (const one of JSON.parse(form.commands)) {
        const id = String(next += 1);
        if (one.type === "project_add") { state.projects.push({ id, name: one.args.name }); temp_id_mapping[one.temp_id] = id; }
        if (one.type === "item_add") { const item = { id, content: one.args.content, project_id: one.args.project_id, checked: false }; touch(item); state.items.push(item); temp_id_mapping[one.temp_id] = id; }
        const item = state.items.find((it) => it.id === one.args.id);
        if (one.type === "item_update") { item.content = one.args.content; touch(item); }
        if (one.type === "item_close") { item.checked = true; touch(item); }
        if (one.type === "item_uncomplete") { item.checked = false; touch(item); }
        if (one.type === "item_delete") { item.is_deleted = true; touch(item); }
        sync_status[one.uuid] = "ok";
      }
      return { ok: true, json: async () => ({ temp_id_mapping, sync_status }) };
    }
    const kinds = JSON.parse(form.resource_types);
    const since = form.sync_token;
    const answer = { sync_token: String(state.version) };
    if (kinds.includes("projects")) answer.projects = state.projects;
    if (kinds.includes("items")) answer.items = state.items.filter((one) => (since === "*" ? !one.checked && !one.is_deleted : one.v > Number(since))).map(({ v, ...item }) => ({ ...item }));
    return { ok: true, json: async () => answer };
  };
  const addFromTodoist = (content, project_id) => { const item = { id: String(next += 1), content, project_id, checked: false }; touch(item); state.items.push(item); return item; };
  const edit = (id, change) => { const item = state.items.find((one) => one.id === id); Object.assign(item, change); touch(item); };
  return { state, fetchImpl, addFromTodoist, edit };
}

function fakeHive() {
  let list = [];
  let n = 0;
  const tasks = {
    list: () => list.map((one) => ({ ...one })),
    add: ({ text, done = false }) => { const task = { id: `t-${String(n += 1).padStart(10, "0")}`, text, done, who: "me" }; list = [...list, task]; return { task }; },
    edit: (id, change) => { list = list.map((one) => (one.id === id ? { ...one, ...change } : one)); return { task: list.find((one) => one.id === id) }; },
    remove: (id) => { list = list.filter((one) => one.id !== id); return { ok: true }; }
  };
  return { tasks, texts: () => list.map((one) => `${one.text}${one.done ? " ✓" : ""}`).sort() };
}

function harness() {
  const remote = fakeTodoist();
  const here = fakeHive();
  const logs = [];
  let clock = 1_000_000;
  const hive = { storage: fakeStorage(), log: (line) => logs.push(line) };
  const sync = createTodoist(hive, { fetchImpl: remote.fetchImpl, now: () => (clock += 10_000) });
  const settings = { token: "tok", project: "Hive" };
  const write = async (change, task, before = null) => sync.changed({ change, task, before, settings });
  const add = async (text) => { const { task } = here.tasks.add({ text }); await write("added", task); return task; };
  const open = () => sync.read({ tasks: here.tasks, settings });
  return { remote, here, hive, logs, sync, settings, write, add, open };
}

test("opening the tasks creates the Hive project, brings its open tasks in and sends the hive's own out", async () => {
  const h = harness();
  h.here.tasks.add({ text: "escrito antes de conectar" });
  await h.open();
  const projectId = h.remote.state.projects.find((one) => one.name === "Hive").id;
  h.remote.addFromTodoist("comprar café", projectId);
  h.remote.addFromTodoist("outro projeto", "999");
  await h.open();
  assert.deepEqual(h.here.texts(), ["comprar café", "escrito antes de conectar"]);
  const inProject = h.remote.state.items.filter((one) => one.project_id === projectId && !one.is_deleted).map((one) => one.content).sort();
  assert.deepEqual(inProject, ["comprar café", "escrito antes de conectar"]);
});

test("a task written, edited, closed, reopened and removed in the hive does the same in Todoist", async () => {
  const h = harness();
  const task = await h.add("revisar PR");
  const item = () => h.remote.state.items[0];
  assert.equal(item().content, "revisar PR");
  await h.write("edited", { ...task, text: "revisar PR #12" }, task);
  assert.equal(item().content, "revisar PR #12");
  await h.write("edited", { ...task, text: "revisar PR #12", done: true }, { ...task, text: "revisar PR #12" });
  assert.equal(item().checked, true);
  await h.write("edited", { ...task, text: "revisar PR #12", done: false }, { ...task, text: "revisar PR #12", done: true });
  assert.equal(item().checked, false);
  await h.write("removed", task);
  assert.equal(item().is_deleted, true);
});

test("what changes in Todoist reaches the hive when the tasks are opened, and never echoes back", async () => {
  const h = harness();
  await h.add("ligar pra escola");
  const item = h.remote.state.items[0];
  h.remote.edit(item.id, { content: "ligar pra escola amanhã" });
  await h.open();
  assert.deepEqual(h.here.texts(), ["ligar pra escola amanhã"]);
  h.remote.edit(item.id, { checked: true });
  await h.open();
  assert.deepEqual(h.here.texts(), ["ligar pra escola amanhã ✓"]);
  const writes = h.remote.state.seen.filter((one) => one.commands).length;
  h.remote.edit(item.id, { is_deleted: true });
  await h.open();
  assert.deepEqual(h.here.texts(), []);
  assert.equal(h.remote.state.seen.filter((one) => one.commands).length, writes);
});

test("a task moved out of the Hive project leaves the hive, and a task shared with others leaves Todoist", async () => {
  const h = harness();
  const kept = await h.add("fica");
  await h.add("sai");
  h.remote.edit(h.remote.state.items.find((one) => one.content === "sai").id, { project_id: "999" });
  await h.open();
  assert.deepEqual(h.here.texts(), ["fica"]);
  await h.write("edited", { ...kept, who: "people", people: ["art"] }, kept);
  assert.equal(h.remote.state.items.find((one) => one.content === "fica").is_deleted, true);
  assert.equal(h.hive.storage.get("links")[kept.id], undefined);
});

test("two opens in a row ask Todoist once", async () => {
  const remote = fakeTodoist();
  const here = fakeHive();
  const sync = createTodoist({ storage: fakeStorage(), log: () => {} }, { fetchImpl: remote.fetchImpl, now: () => 5_000 });
  await sync.read({ tasks: here.tasks, settings: { token: "tok", project: "Hive" } });
  const asked = remote.state.seen.length;
  await sync.read({ tasks: here.tasks, settings: { token: "tok", project: "Hive" } });
  assert.equal(remote.state.seen.length, asked);
});

test("a Todoist that refuses the token leaves a line in the log and throws nothing", async () => {
  const logs = [];
  const sync = createTodoist({ storage: fakeStorage(), log: (line) => logs.push(line) }, { fetchImpl: async () => ({ ok: false, status: 401 }) });
  await sync.read({ tasks: fakeHive().tasks, settings: { token: "bad", project: "Hive" } });
  await sync.changed({ change: "added", task: { id: "t-0000000001", text: "x", who: "me" }, settings: { token: "bad", project: "Hive" } });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /401/);
});

test("the module registers exactly the two hooks its manifest declares", async () => {
  const hooks = [];
  todoist({ storage: fakeStorage(), log: () => {}, on: (hook, fn) => { assert.equal(typeof fn, "function"); hooks.push(hook); } });
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("./extension.json", import.meta.url), "utf8"));
  assert.deepEqual(hooks.sort(), [...manifest.hooks].sort());
});

test("the logo the manifest names is a square svg next to it", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("./extension.json", import.meta.url), "utf8"));
  const svg = await readFile(new URL(`./${manifest.logo}`, import.meta.url), "utf8");
  assert.match(svg, /^<svg [^>]*viewBox="0 0 24 24"/);
});
