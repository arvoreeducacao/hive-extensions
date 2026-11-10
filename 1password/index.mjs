import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VAULT_ITEM = "hub-env";
const PERSONAL_VAULTS = ["Employee", "Private", "Personal"];
const OP_TIMEOUT_MS = 130000;
const NO_OP = "the op command is not installed; install the 1Password CLI (sudo apt install 1password-cli, brew install 1password-cli)";

export function pickVault(vaults) {
  const names = (vaults || []).map((vault) => vault?.name).filter(Boolean);
  return PERSONAL_VAULTS.find((name) => names.includes(name)) || names[0] || "";
}

export function itemWithField(item, key, value) {
  const fields = (item.fields || []).filter((field) => field.label !== key);
  return { ...item, fields: [...fields, { label: key, type: "CONCEALED", value }] };
}

export const vaultRefOf = (vault, key) => `op://${vault}/${VAULT_ITEM}/${key}`;

function lastLine(text) {
  return String(text || "").trim().split("\n").filter(Boolean).pop() || "";
}

export function runOp(args, { template } = {}) {
  if (template === undefined) {
    return new Promise((done) => {
      const child = execFile("op", args, { timeout: OP_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
        done(error ? { ok: false, out: "", error: error.code === "ENOENT" ? "ENOENT" : lastLine(stderr || error.message) } : { ok: true, out: stdout, error: "" });
      });
      child.stdin.end();
    });
  }
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-op-"));
    const fifo = join(dir, "item.json");
    try {
      await new Promise((done, fail) => execFile("mkfifo", ["-m", "600", fifo], (error) => (error ? fail(error) : done())));
      const answer = new Promise((done) => {
        const child = spawn("op", [...args, `--template=${fifo}`], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill(), OP_TIMEOUT_MS);
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err += chunk; });
        child.on("error", (error) => { clearTimeout(timer); done({ ok: false, out: "", error: error.code === "ENOENT" ? "ENOENT" : error.message }); });
        child.on("close", (code) => { clearTimeout(timer); done(code === 0 ? { ok: true, out, error: "" } : { ok: false, out: "", error: lastLine(err) }); });
      });
      const writer = createWriteStream(fifo);
      writer.on("error", () => {});
      writer.end(template);
      return await answer;
    } catch (error) {
      return { ok: false, out: "", error: error.message };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
}

const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const said = (error) => (error === "ENOENT" ? NO_OP : error);

export async function readRef(ref, op = runOp) {
  const read = await op(["read", "--no-newline", ref]);
  if (read.ok) return read.out;
  throw new Error(`could not read ${ref} from 1Password: ${said(read.error)}`);
}

async function hubItemOf(vault, op) {
  const listed = await op(["item", "list", "--vault", vault, "--format", "json"]);
  if (!listed.ok) return { error: said(listed.error) };
  const named = (parsed(listed.out) || []).filter((one) => one?.title === VAULT_ITEM);
  if (named.length > 1) return { error: `the ${vault} vault has ${named.length} items named ${VAULT_ITEM}: keep one and archive the others` };
  if (!named.length) return { item: null };
  const current = await op(["item", "get", named[0].id, "--vault", vault, "--format", "json"]);
  const item = current.ok ? parsed(current.out) : null;
  return item ? { item } : { error: current.error || `1Password did not return the ${VAULT_ITEM} item` };
}

export async function moveToVault({ key, value, op = runOp }) {
  if (!value) return { error: `${key} has no value in the .env to move` };
  if (value.startsWith("op://")) return { error: `${key} is already in 1Password` };
  const listed = await op(["vault", "list", "--format", "json"]);
  if (!listed.ok) return { error: said(listed.error) };
  const vault = pickVault(parsed(listed.out));
  if (!vault) return { error: "1Password shows no vault" };
  const found = await hubItemOf(vault, op);
  if (found.error) return found;
  const { item } = found;
  const saved = item
    ? await op(["item", "edit", item.id, "--vault", vault, "--format", "json"], { template: JSON.stringify(itemWithField(item, key, value)) })
    : await op(["item", "create", "--vault", vault, "--format", "json"], { template: JSON.stringify(itemWithField({ title: VAULT_ITEM, category: "API_CREDENTIAL", fields: [] }, key, value)) });
  if (!saved.ok) return { error: said(saved.error) };
  const ref = vaultRefOf(vault, key);
  const back = await op(["read", "--no-newline", ref]);
  if (!back.ok || back.out !== value) return { error: "1Password saved the value, but reading it back did not match" };
  return { ok: true, vault, ref };
}

export async function vaultSetupOf({ op = runOp } = {}) {
  const version = await op(["--version"]);
  if (!version.ok) return { installed: false, signedIn: false, vault: "", account: "" };
  const accounts = await op(["account", "list", "--format", "json"]);
  const account = (parsed(accounts.out) || [])[0]?.email || "";
  if (!account) return { installed: true, signedIn: false, vault: "", account: "", integration: false };
  const listed = await op(["vault", "list", "--format", "json"]);
  return { installed: true, integration: true, signedIn: listed.ok, account, vault: listed.ok ? pickVault(parsed(listed.out)) : "" };
}

export function statusLines(setup) {
  if (!setup.installed) return [{ ok: false, text: NO_OP }];
  if (!setup.integration) return [{ ok: false, text: "in the 1Password app, turn on Settings, Developer, Integrate with 1Password CLI" }];
  if (!setup.signedIn) return [{ ok: false, text: "approve the prompt in the 1Password app, then check again" }];
  return [{ ok: true, text: `connected as ${setup.account}, vault ${setup.vault}` }];
}

export default function onePassword(hive, op = runOp) {
  hive.on("secrets.read", ({ ref }) => readRef(ref, op));
  hive.on("secrets.store", async ({ key, value }) => {
    const moved = await moveToVault({ key, value, op });
    if (!moved.ok) throw new Error(moved.error);
    return { ref: moved.ref, where: moved.vault };
  });
  hive.on("secrets.status", async () => statusLines(await vaultSetupOf({ op })));
}
