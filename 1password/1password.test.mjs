import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import onePassword, { itemWithField, moveToVault, pickVault, readRef, statusLines, vaultSetupOf } from "./index.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function fakeOp(answers) {
  const calls = [];
  const op = async (args, extra = {}) => {
    calls.push({ args, ...extra });
    const key = args.slice(0, 2).join(" ");
    const answer = typeof answers[key] === "function" ? answers[key](args, extra) : answers[key];
    return answer || { ok: false, out: "", error: `no answer for ${key}` };
  };
  return { op, calls };
}

function registered(op) {
  const handlers = {};
  onePassword({ on: (hook, fn) => { handlers[hook] = fn; } }, op);
  return handlers;
}

test("the manifest asks for the three vault hooks and claims op://, and the module registers exactly those", () => {
  const manifest = JSON.parse(readFileSync(join(HERE, "extension.json"), "utf8"));
  assert.equal(manifest.name, "1password");
  assert.deepEqual(manifest.hooks, ["secrets.read", "secrets.store", "secrets.status"]);
  assert.equal(manifest.secretPrefix, "op://");
  assert.deepEqual(Object.keys(registered(fakeOp({}).op)).sort(), [...manifest.hooks].sort());
});

test("secrets.read runs op read and says so when op is not installed", async () => {
  const { op, calls } = fakeOp({ "read --no-newline": { ok: true, out: "the-value" } });
  assert.equal(await registered(op)["secrets.read"]({ ref: "op://vault/item/field" }), "the-value");
  assert.deepEqual(calls[0].args, ["read", "--no-newline", "op://vault/item/field"]);
  const noOp = fakeOp({ "read --no-newline": { ok: false, out: "", error: "ENOENT" } });
  await assert.rejects(readRef("op://vault/item/field", noOp.op), /could not read op:\/\/vault\/item\/field from 1Password: the op command is not installed/);
});

test("secrets.store answers the new reference, and fails with the reason", async () => {
  const { op } = fakeOp({
    "vault list": { ok: true, out: JSON.stringify([{ name: "Employee" }]) },
    "item list": { ok: true, out: "[]" },
    "item create": { ok: true, out: "{}" },
    "read --no-newline": { ok: true, out: "the-secret" }
  });
  assert.deepEqual(await registered(op)["secrets.store"]({ key: "A", value: "the-secret" }), { ref: "op://Employee/hub-env/A", where: "Employee" });
  await assert.rejects(registered(fakeOp({}).op)["secrets.store"]({ key: "A", value: "" }), /has no value/);
});

test("secrets.status turns into the lines of the credentials card", async () => {
  const ok = fakeOp({ "--version": { ok: true, out: "2.42.0" }, "account list": { ok: true, out: JSON.stringify([{ email: "person@example.com" }]) }, "vault list": { ok: true, out: JSON.stringify([{ name: "Employee" }]) } });
  assert.deepEqual(await registered(ok.op)["secrets.status"]({}), [{ ok: true, text: "connected as person@example.com, vault Employee" }]);
  assert.match(statusLines({ installed: false }).at(0).text, /install the 1Password CLI/);
  assert.match(statusLines({ installed: true, integration: false }).at(0).text, /Integrate with 1Password CLI/);
  assert.match(statusLines({ installed: true, integration: true, signedIn: false }).at(0).text, /approve the prompt/);
});

test("pickVault prefers the personal vault and falls back on the first", () => {
  assert.equal(pickVault([{ name: "Shared" }, { name: "Employee" }]), "Employee");
  assert.equal(pickVault([{ name: "Private" }]), "Private");
  assert.equal(pickVault([{ name: "Team" }]), "Team");
  assert.equal(pickVault([]), "");
});

test("itemWithField replaces the field that exists and appends a new one", () => {
  const item = { id: "x", fields: [{ label: "A", type: "CONCEALED", value: "old" }, { label: "B", type: "CONCEALED", value: "b" }] };
  assert.deepEqual(itemWithField(item, "A", "new").fields.map((f) => [f.label, f.value]), [["B", "b"], ["A", "new"]]);
  assert.deepEqual(itemWithField(item, "C", "c").fields.map((f) => f.label), ["A", "B", "C"]);
});

test("moveToVault creates the hub-env item when it is missing and reads the value back", async () => {
  const { op, calls } = fakeOp({
    "vault list": { ok: true, out: JSON.stringify([{ name: "Shared" }, { name: "Employee" }]) },
    "item list": { ok: true, out: JSON.stringify([{ id: "zzz", title: "other" }]) },
    "item create": { ok: true, out: "{}" },
    "read --no-newline": { ok: true, out: "the-secret" }
  });
  const moved = await moveToVault({ key: "POSTHOG_API_KEY", value: "the-secret", op });
  assert.deepEqual(moved, { ok: true, vault: "Employee", ref: "op://Employee/hub-env/POSTHOG_API_KEY" });
  const created = calls.find((c) => c.args[1] === "create");
  assert.match(created.template, /"label":"POSTHOG_API_KEY"/);
  assert.ok(calls.every((c) => !c.args.join(" ").includes("the-secret")), "the value never goes on the command line");
});

test("moveToVault edits the existing item through a template, never with the value on the command line", async () => {
  const { op, calls } = fakeOp({
    "vault list": { ok: true, out: JSON.stringify([{ name: "Employee" }]) },
    "item list": { ok: true, out: JSON.stringify([{ id: "zzz", title: "other" }, { id: "abc", title: "hub-env" }]) },
    "item get": { ok: true, out: JSON.stringify({ id: "abc", title: "hub-env", fields: [{ label: "OTHER", type: "CONCEALED", value: "x" }] }) },
    "item edit": { ok: true, out: "{}" },
    "read --no-newline": { ok: true, out: "the-secret" }
  });
  const moved = await moveToVault({ key: "SENTRY_ACCESS_TOKEN", value: "the-secret", op });
  assert.equal(moved.ok, true);
  assert.deepEqual(calls.find((c) => c.args[1] === "get").args.slice(0, 3), ["item", "get", "abc"]);
  const edited = calls.find((c) => c.args[1] === "edit");
  assert.deepEqual(edited.args.slice(0, 3), ["item", "edit", "abc"]);
  assert.deepEqual(JSON.parse(edited.template).fields.map((f) => f.label), ["OTHER", "SENTRY_ACCESS_TOKEN"]);
  assert.ok(calls.every((c) => !c.args.join(" ").includes("the-secret")));
});

test("moveToVault refuses an empty value, a value already in the vault, and a read back that does not match", async () => {
  assert.match((await moveToVault({ key: "A", value: "" })).error, /has no value/);
  assert.match((await moveToVault({ key: "A", value: "op://V/i/A" })).error, /already in 1Password/);
  const { op } = fakeOp({
    "vault list": { ok: true, out: JSON.stringify([{ name: "Employee" }]) },
    "item list": { ok: true, out: "[]" },
    "item create": { ok: true, out: "{}" },
    "read --no-newline": { ok: true, out: "different" }
  });
  assert.match((await moveToVault({ key: "A", value: "the-secret", op })).error, /did not match/);
});

test("moveToVault refuses and writes nothing when the vault already has more than one hub-env item", async () => {
  const { op, calls } = fakeOp({
    "vault list": { ok: true, out: JSON.stringify([{ name: "Employee" }]) },
    "item list": { ok: true, out: JSON.stringify([{ id: "a", title: "hub-env" }, { id: "b", title: "hub-env" }]) }
  });
  const moved = await moveToVault({ key: "A", value: "the-secret", op });
  assert.match(moved.error, /2 items named hub-env/);
  assert.ok(calls.every((c) => !["get", "create", "edit"].includes(c.args[1])));
});

test("moveToVault does not create a second hub-env item when 1Password fails to return the existing one", async () => {
  const { op, calls } = fakeOp({
    "vault list": { ok: true, out: JSON.stringify([{ name: "Employee" }]) },
    "item list": { ok: true, out: JSON.stringify([{ id: "a", title: "hub-env" }]) },
    "item get": { ok: false, out: "", error: "authorization prompt dismissed" }
  });
  assert.deepEqual(await moveToVault({ key: "A", value: "the-secret", op }), { error: "authorization prompt dismissed" });
  assert.ok(calls.every((c) => c.args[1] !== "create"));
});

test("moveToVault says so when op is not installed", async () => {
  const { op } = fakeOp({ "vault list": { ok: false, out: "", error: "ENOENT" } });
  assert.match((await moveToVault({ key: "A", value: "v", op })).error, /the op command is not installed/);
});

test("vaultSetupOf tells apart no op, no app integration, and connected", async () => {
  assert.deepEqual(await vaultSetupOf({ op: fakeOp({}).op }), { installed: false, signedIn: false, vault: "", account: "" });
  const noAccount = fakeOp({ "--version": { ok: true, out: "2.42.0" }, "account list": { ok: true, out: "[]" } });
  assert.equal((await vaultSetupOf({ op: noAccount.op })).integration, false);
  const ok = fakeOp({ "--version": { ok: true, out: "2.42.0" }, "account list": { ok: true, out: JSON.stringify([{ email: "person@example.com" }]) }, "vault list": { ok: true, out: JSON.stringify([{ name: "Employee" }]) } });
  assert.deepEqual(await vaultSetupOf({ op: ok.op }), { installed: true, integration: true, signedIn: true, account: "person@example.com", vault: "Employee" });
});
