import { randomUUID } from "node:crypto";

export const SYNC_URL = "https://api.todoist.com/api/v1/sync";
const READ_GAP_MS = 3000;

const formOf = (fields) => new URLSearchParams(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])));

const command = (type, args, tempId = "") => ({ type, uuid: randomUUID(), args, ...(tempId ? { temp_id: tempId } : {}) });

export function createTodoist(hive, { fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  let queue = Promise.resolve();
  let readAt = 0;
  const inLine = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  const links = () => hive.storage.get("links") || {};
  const link = (hiveId, todoistId) => hive.storage.set("links", { ...links(), [hiveId]: todoistId });
  const unlink = (hiveId) => { const next = { ...links() }; delete next[hiveId]; hive.storage.set("links", next); };
  const hiveIdOf = (todoistId) => Object.entries(links()).find(([, id]) => id === todoistId)?.[0] || "";

  async function call(token, fields) {
    const answer = await fetchImpl(SYNC_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: formOf(fields)
    });
    if (!answer.ok) throw new Error(`todoist answered ${answer.status}`);
    return answer.json();
  }

  async function run(token, commands) {
    if (!commands.length) return {};
    const said = await call(token, { commands });
    for (const [uuid, status] of Object.entries(said.sync_status || {})) {
      if (status !== "ok") hive.log(`todoist refused ${uuid}: ${JSON.stringify(status).slice(0, 200)}`);
    }
    return said.temp_id_mapping || {};
  }

  async function projectOf(settings) {
    const name = String(settings.project || "Hive").trim() || "Hive";
    const held = hive.storage.get("project");
    if (held?.name === name && held.id) return held.id;
    const said = await call(settings.token, { sync_token: "*", resource_types: ["projects"] });
    const found = (said.projects || []).find((one) => one.name === name && !one.is_deleted && !one.is_archived);
    let id = found?.id || "";
    if (!id) {
      const temp = randomUUID();
      id = (await run(settings.token, [command("project_add", { name }, temp)]))[temp] || "";
    }
    if (!id) throw new Error(`could not find or create the ${name} project`);
    hive.storage.set("project", { id, name });
    hive.storage.set("links", {});
    hive.storage.remove("syncToken");
    return id;
  }

  async function pull(settings, projectId, tasks) {
    const said = await call(settings.token, { sync_token: hive.storage.get("syncToken") || "*", resource_types: ["items"] });
    const mine = new Map(tasks.list().map((one) => [one.id, one]));
    const redo = [];
    for (const item of said.items || []) {
      const hiveId = hiveIdOf(item.id);
      const here = item.project_id === projectId && !item.is_deleted;
      if (!here) {
        if (hiveId) { tasks.remove(hiveId); unlink(hiveId); }
        continue;
      }
      if (hiveId) {
        const held = mine.get(hiveId);
        if (!held) { if (!item.checked) redo.push(command("item_delete", { id: item.id })); unlink(hiveId); continue; }
        const change = {};
        if (item.content && item.content !== held.text) change.text = item.content;
        if (!!item.checked !== !!held.done) change.done = !!item.checked;
        if (Object.keys(change).length) tasks.edit(hiveId, change);
        continue;
      }
      if (item.checked || !item.content) continue;
      const made = tasks.add({ text: item.content });
      if (made?.task) link(made.task.id, item.id);
    }
    if (said.sync_token) hive.storage.set("syncToken", said.sync_token);
    await run(settings.token, redo);
  }

  async function pushUnlinked(settings, projectId, tasks) {
    const held = links();
    const waiting = tasks.list().filter((one) => !one.done && !held[one.id]);
    if (!waiting.length) return;
    const temps = waiting.map((one) => ({ id: one.id, temp: randomUUID() }));
    const mapping = await run(settings.token, waiting.map((one, at) => command("item_add", { content: one.text, project_id: projectId }, temps[at].temp)));
    for (const { id, temp } of temps) if (mapping[temp]) link(id, mapping[temp]);
  }

  async function read({ tasks, settings }) {
    if (now() - readAt < READ_GAP_MS) return;
    readAt = now();
    await inLine(async () => {
      try {
        const projectId = await projectOf(settings);
        await pull(settings, projectId, tasks);
        await pushUnlinked(settings, projectId, tasks);
      } catch (wrong) { hive.log(`could not sync with todoist: ${String(wrong?.message || wrong)}`); }
    });
  }

  async function changed({ change, task, before, settings }) {
    if (!task?.id) return;
    await inLine(async () => {
      try {
        const todoistId = links()[task.id];
        if (change === "removed" || task.who !== "me") {
          if (!todoistId) return;
          await run(settings.token, [command("item_delete", { id: todoistId })]);
          unlink(task.id);
          return;
        }
        const projectId = await projectOf(settings);
        if (!todoistId) {
          if (task.done) return;
          const temp = randomUUID();
          const mapping = await run(settings.token, [command("item_add", { content: task.text, project_id: projectId }, temp)]);
          if (mapping[temp]) link(task.id, mapping[temp]);
          return;
        }
        const commands = [];
        if (!before || before.text !== task.text) commands.push(command("item_update", { id: todoistId, content: task.text }));
        if (!before || !!before.done !== !!task.done) commands.push(command(task.done ? "item_close" : "item_uncomplete", { id: todoistId }));
        await run(settings.token, commands);
      } catch (wrong) { hive.log(`could not send a task to todoist: ${String(wrong?.message || wrong)}`); }
    });
  }

  return { read, changed };
}

export default function todoist(hive) {
  const sync = createTodoist(hive);
  hive.on("tasks.read", sync.read);
  hive.on("tasks.changed", sync.changed);
}
