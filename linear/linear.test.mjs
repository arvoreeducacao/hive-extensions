import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_TOKEN, askLinear, fetchIssue, fetchMine, imagesOf, issueOf, linearKey, linearToken, missionWithIssue, seatNameForIssue } from "./linear.mjs";
import { createLinearDomain, NO_TOKEN_SAID } from "./domain.mjs";
import linear from "./index.mjs";

const refuse = (status, message) => Object.assign(new Error(message), { status });

const NODE = {
  id: "uuid-1", identifier: "PED-661", title: "Consertar o indicador da fila", url: "https://linear.app/arvore/issue/PED-661/consertar",
  branchName: "joao/ped-661-consertar-o-indicador", priority: 2, priorityLabel: "High", updatedAt: "2026-09-01T10:00:00.000Z",
  description: "O indicador mostra zero.\n\n![print](https://uploads.linear.app/a/b.png)\n\n![](https://uploads.linear.app/a/b.png) e ![outro](https://uploads.linear.app/c.png)",
  state: { name: "Todo", type: "unstarted" }, assignee: { name: "João Cunha", displayName: "joao" }, team: { key: "PED" }, project: { name: "Pedidos Tech" },
  attachments: { nodes: [{ title: "thread", url: "https://slack.com/archives/C1/p1" }, { title: "", url: "" }] }
};

const fakeFetch = (answer, status = 200) => async (url, init) => {
  fakeFetch.calls.push({ url, init: JSON.parse(init.body), auth: init.headers.authorization });
  return { ok: status < 400, status, json: async () => answer };
};
fakeFetch.calls = [];

test("an issue key is read from a Linear url or from the head of the mission, never from the middle of a sentence", () => {
  assert.equal(linearKey("https://linear.app/arvore/issue/PED-661/consertar-o-indicador"), "PED-661");
  assert.equal(linearKey("ped-661 conserta o indicador"), "PED-661");
  assert.equal(linearKey("  PED-661\nmais texto"), "PED-661");
  assert.equal(linearKey("conserta o bug do PED-661"), "", "a key in passing is not the mission's subject");
  assert.equal(linearKey('Você é um engenheiro investigando o pedido "Anular leituras [14047]" (PED-946).\nUm agente já fez a triagem de PED-1.'), "PED-946", "a key closing the first line, the way the pedidos-tech missions arrive, is the subject");
  assert.equal(linearKey("investigando o pedido (ped-946)"), "PED-946");
  assert.equal(linearKey("primeira linha sem chave\n(PED-946)"), "", "a key closing a later line is not the subject");
  assert.equal(linearKey("olha o (PED-946) no meio da linha"), "", "a key in parentheses mid-line is still in passing");
  assert.equal(linearKey("olha o https://github.com/o/r/pull/7"), "");
  assert.equal(linearKey(""), "");
});

test("the token comes from the environment first, then from the hub .env, and is empty otherwise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-linear-"));
  const envFile = join(dir, ".env");
  assert.equal(linearToken({ env: {}, envFile }), "");
  await writeFile(envFile, "OTHER=1\nLINEAR_API_KEY=\"lin_api_abc\"\n");
  assert.equal(linearToken({ env: {}, envFile }), "lin_api_abc");
  assert.equal(linearToken({ env: { LINEAR_API_KEY: " lin_env " }, envFile }), "lin_env");
  await rm(dir, { recursive: true, force: true });
});

test("an issue node becomes the shape the app reads, with its images and real attachments only", () => {
  const issue = issueOf(NODE);
  assert.equal(issue.identifier, "PED-661");
  assert.equal(issue.branch, "joao/ped-661-consertar-o-indicador");
  assert.equal(issue.state, "Todo");
  assert.equal(issue.assignee, "joao");
  assert.equal(issue.team, "PED");
  assert.deepEqual(issue.images, ["https://uploads.linear.app/a/b.png", "https://uploads.linear.app/c.png"]);
  assert.deepEqual(issue.attachments, [{ title: "thread", url: "https://slack.com/archives/C1/p1" }]);
  assert.equal(issueOf(null), null);
  assert.deepEqual(imagesOf("no image"), []);
  assert.equal(seatNameForIssue(issue), "ped-661");
});

test("asking Linear carries the key as authorization and turns refusals and graphql errors into one line", async () => {
  fakeFetch.calls = [];
  assert.deepEqual(await askLinear("{ x }", {}, { token: "" }), { error: NO_TOKEN });
  const ok = await askLinear("{ x }", { a: 1 }, { token: "lin_1", fetchImpl: fakeFetch({ data: { x: 1 } }) });
  assert.deepEqual(ok, { data: { x: 1 } });
  assert.equal(fakeFetch.calls[0].auth, "lin_1");
  assert.deepEqual(fakeFetch.calls[0].init.variables, { a: 1 });
  assert.match((await askLinear("{ x }", {}, { token: "lin_1", fetchImpl: fakeFetch({}, 401) })).error, /refused the key/);
  assert.match((await askLinear("{ x }", {}, { token: "lin_1", fetchImpl: fakeFetch({ errors: [{ message: "Entity not found" }] }) })).error, /Entity not found/);
  assert.match((await askLinear("{ x }", {}, { token: "lin_1", fetchImpl: async () => { throw new Error("ECONNRESET"); } })).error, /did not answer — ECONNRESET/);
});

test("one issue and the ones assigned to me come back in shape", async () => {
  const one = await fetchIssue("ped-661", { token: "t", fetchImpl: fakeFetch({ data: { issue: NODE } }) });
  assert.equal(one.issue.identifier, "PED-661");
  assert.match((await fetchIssue("ped-1", { token: "t", fetchImpl: fakeFetch({ data: { issue: null } }) })).error, /no issue PED-1/);
  const mine = await fetchMine({ token: "t", fetchImpl: fakeFetch({ data: { viewer: { name: "João", assignedIssues: { nodes: [NODE, { ...NODE, identifier: "PED-2" }] } } } }) });
  assert.equal(mine.me, "João");
  assert.deepEqual(mine.issues.map((i) => i.identifier), ["PED-661", "PED-2"]);
});

test("the mission opens with the issue, its link, branch and images, and keeps what the person added", () => {
  const issue = issueOf(NODE);
  const text = missionWithIssue("PED-661 e roda os testes depois", issue);
  const lines = text.split("\n");
  assert.equal(lines[0], "[hive] Linear PED-661 — Consertar o indicador da fila");
  assert.equal(lines[1], issue.url);
  assert.equal(lines[2], "branch: joao/ped-661-consertar-o-indicador");
  assert.equal(lines[3], "state: Todo · assignee: joao · project: Pedidos Tech");
  assert.match(text, /O indicador mostra zero\./);
  assert.match(text, /images in the issue[\s\S]*- https:\/\/uploads\.linear\.app\/c\.png/);
  assert.match(text, /attachments:\n- thread: https:\/\/slack\.com/);
  assert.ok(text.endsWith("e roda os testes depois"), "what the person typed after the key closes the mission");
  assert.doesNotMatch(text, /PED-661 e roda/, "the bare key is not repeated as a line of its own");

  const bare = missionWithIssue("https://linear.app/arvore/issue/PED-661/x", issue);
  assert.match(bare, /Do what the issue asks\. Open a PR on the branch above/);
  assert.equal(missionWithIssue("plain", null), "plain");
});

test("the domain enriches a spawn only when the mission leads with an issue and a key is at hand", async () => {
  const quiet = createLinearDomain({ env: {}, envFile: "/nowhere/.env" });
  assert.equal(quiet.hasToken(), false);
  assert.deepEqual(await quiet.enrich({ name: "" }, "PED-661 x"), { prompt: "PED-661 x", body: { name: "" }, issue: null });

  const logs = [];
  const loud = createLinearDomain({ env: { LINEAR_API_KEY: "t" }, fetchImpl: fakeFetch({ data: { issue: NODE } }), log: (l) => logs.push(l) });
  const plain = await loud.enrich({ name: "x" }, "fix the login");
  assert.equal(plain.issue, null);
  const rich = await loud.enrich({ name: "", branch: "", title: "", errand: "" }, "PED-661");
  assert.equal(rich.issue.identifier, "PED-661");
  assert.equal(rich.body.branch, "joao/ped-661-consertar-o-indicador");
  assert.equal(rich.body.title, "PED-661 · Consertar o indicador da fila");
  assert.equal(rich.body.errand, "PED-661 Consertar o indicador da fila");
  assert.equal(rich.name, "ped-661");
  assert.match(rich.prompt, /^\[hive\] Linear PED-661/);

  const kept = await loud.enrich({ branch: "mine", title: "my title", errand: "my errand" }, "PED-661");
  assert.deepEqual([kept.body.branch, kept.body.title, kept.body.errand], ["mine", "my title", "my errand"], "what the person set wins");

  const broken = createLinearDomain({ env: { LINEAR_API_KEY: "t" }, fetchImpl: fakeFetch({ data: { issue: null } }), log: (l) => logs.push(l) });
  const gone = await broken.enrich({}, "PED-9");
  assert.equal(gone.issue, null);
  assert.equal(gone.prompt, "PED-9", "an issue Linear does not know leaves the mission as written");
  assert.match(logs.join("\n"), /linear PED-9: no issue PED-9/);
});

test("the routes say plainly when there is no key, and cache the assigned list for a minute", async () => {
  const routes = new Map();
  const call = async (path, query = "") => {
    try { return { status: 200, value: await routes.get(path)({ url: new URL(`http://hive${path}${query}`) }) }; }
    catch (wrong) { return { status: wrong.status || 500, value: { error: wrong.message } }; }
  };
  const none = createLinearDomain({ env: {}, envFile: "/nowhere/.env" });
  none.register((method, path, handler) => routes.set(path, handler), refuse);
  assert.equal((await call("/api/ext/linear/mine")).status, 503);
  assert.equal((await call("/api/ext/linear/mine")).value.error, NO_TOKEN_SAID);
  assert.equal((await call("/api/ext/linear/issue", "?key=PED-1")).status, 503);
  assert.equal((await call("/api/ext/linear/issue", "?key=nope")).status, 400);

  let clock = 1000;
  fakeFetch.calls = [];
  const some = createLinearDomain({ env: { LINEAR_API_KEY: "t" }, fetchImpl: fakeFetch({ data: { viewer: { name: "J", assignedIssues: { nodes: [NODE] } }, issue: NODE } }), now: () => clock });
  some.register((method, path, handler) => routes.set(path, handler), refuse);
  const first = await call("/api/ext/linear/mine");
  assert.equal(first.value.issues.length, 1);
  await call("/api/ext/linear/mine");
  assert.equal(fakeFetch.calls.length, 1, "the second ask within a minute is served from memory");
  clock += 61000;
  await call("/api/ext/linear/mine");
  assert.equal(fakeFetch.calls.length, 2);
  await call("/api/ext/linear/mine", "?force=1");
  assert.equal(fakeFetch.calls.length, 3);
  const one = await call("/api/ext/linear/issue", "?key=https://linear.app/arvore/issue/PED-661/x");
  assert.equal(one.value.issue.identifier, "PED-661");
});

test("the token set in the extension wins over the hub .env, and seat.opening hands the core what enrich used to", async () => {
  const domain = createLinearDomain({ env: { LINEAR_API_KEY: "from-env" }, fetchImpl: fakeFetch({ data: { issue: NODE } }), settingsOf: () => ({ token: "from-settings" }) });
  fakeFetch.calls = [];
  const opened = await domain.opening({ body: { name: "", branch: "", title: "", errand: "" }, prompt: "PED-661" });
  assert.equal(fakeFetch.calls[0].auth, "from-settings");
  assert.equal(opened.name, "ped-661");
  assert.equal(opened.body.title, "PED-661 · Consertar o indicador da fila");
  assert.match(opened.prompt, /^\[hive\] Linear PED-661/);
  assert.equal(await domain.opening({ body: {}, prompt: "fix the login" }), undefined, "no issue, nothing to say");
});

test("registered in a hive, the extension asks for the two hooks it declares and hands the hive its routes", async () => {
  const hooks = {};
  const routes = [];
  linear({ paths: { hub: "/nowhere" }, log: () => {}, refuse, on: (hook, fn) => { hooks[hook] = fn; } });
  assert.deepEqual(Object.keys(hooks).sort(), ["routes", "seat.opening"]);
  hooks.routes((method, path, fn) => routes.push({ method, path, fn }));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ["GET /api/ext/linear/mine", "GET /api/ext/linear/issue"]);
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./extension.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.hooks, ["seat.opening", "routes"]);
  assert.equal(manifest.settings.token.type, "password");
  await assert.rejects(routes[0].fn({ url: new URL("http://hive/api/ext/linear/mine"), settings: {} }), (wrong) => wrong.status === 503 && wrong.message === NO_TOKEN_SAID);
  assert.equal(await hooks["seat.opening"]({ body: {}, prompt: "fix the login", settings: {} }), undefined);
});
