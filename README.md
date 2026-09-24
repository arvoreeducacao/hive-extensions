# hive-extensions

Extensions for the [hive](https://github.com/arvoreeducacao/dev-workspaces) that
anyone can install. None of them ships inside the app: each is a folder you copy
into your hub or your machine and turn on in the extensions panel.

| Extension | What it does |
|---|---|
| [`linear`](linear/) | a mission that leads with an issue key, or a Linear url, opens the seat with the issue: description, branch, title, errand and name; the palette lists the issues assigned to you |
| [`example`](example/) | the shape of an extension, one of everything: copy it and rename it to start a new one |

## Installing one

```
git clone https://github.com/arvoreeducacao/hive-extensions
cp -r hive-extensions/linear ~/.hive/extensions/linear        # this machine only
cp -r hive-extensions/linear <your hub>/extensions/linear    # everyone who opens that hub
```

Then open the extensions panel in the hive (palette: "extensions") and turn it
on. A hub or personal extension starts off; turning it on records the module as
it is, and a module that changes on disk afterwards asks to be turned on again.
A `password` setting is typed in the panel and never reaches the config file.

## The shape of an extension

One folder, named like the extension, with these files:

```
linear/
  extension.json     the manifest: what it is, which hooks it asks for, which settings it exposes
  index.mjs          the module: a default export that receives the hive and registers handlers
  linear.test.mjs    its tests, node --test, no framework
  *.mjs              anything else it needs — nothing outside the folder
```

### `extension.json`

```json
{
  "name": "linear",
  "title": "Linear",
  "icon": "i-list",
  "version": "1.0.0",
  "description": "one line, what it does",
  "hooks": ["seat.opening", "routes"],
  "settings": {
    "token":   { "type": "password", "label": "API key", "description": "from linear.app settings", "placeholder": "lin_api_…" },
    "prefix":  { "type": "string",   "default": "p.t.", "label": "prefix" },
    "loud":    { "type": "boolean",  "default": false },
    "team":    { "type": "dropdown", "default": "PED", "data": [{ "title": "Pedidos", "value": "PED" }, { "title": "Experiência", "value": "EXP" }] },
    "max":     { "type": "number",   "default": 3, "required": true }
  }
}
```

| Field | Rule |
|---|---|
| `name` | the folder's name: lowercase words joined by hyphens, at most 40 characters |
| `title`, `icon` | what the panel shows; `icon` is the id of one of the app's symbols (`i-plug`, `i-list`, `i-hash`…). Both optional |
| `version` | a short string like `1.0.0` |
| `hooks` | at least one of `seat.title`, `seat.opening`, `routes`. A hook the app does not know keeps the extension from loading; a hook registered but not declared here is ignored |
| `settings` | types `string`, `number`, `boolean`, `password`, `dropdown` (with `data`). Each can carry `label`, `description`, `placeholder`, `required`, `default` (never on a `password`). The panel builds the form from this. A `required` setting still empty keeps the extension from running, and the panel says so |

Values live in `~/.hive/config.jsonc` under `extensions.<name>.settings`; a
`password` lives in `~/.hive/extension-secrets.json`, mode 0600.

### `index.mjs`

```js
export default function linear(hive) {
  hive.on("seat.title", ({ name, where, title, mission, status, errand, settings }) => title);
  hive.on("seat.opening", async ({ body, prompt, settings }) => ({ body, prompt, name: "" }));
  hive.on("routes", (on) => {
    on("GET", "/api/ext/linear/mine", async ({ method, url, body, settings, storage }) => ({ ok: true }));
  });
}
```

The `hive` it receives:

| | |
|---|---|
| `hive.name` | the extension's name |
| `hive.on(hook, fn)` | registers a handler; one per hook |
| `hive.storage` | `get`, `set`, `remove`, `all`, `clear`: small JSON private to this extension, kept in `~/.hive/extension-state/<name>.json`, at most 256 KB |
| `hive.paths` | `dir` (the extension's folder), `support` (a folder of its own for anything bigger), `hub` (the hub the app runs on, where its `.env` is) |
| `hive.refuse(status, message)` | an error a route throws to answer with that status |
| `hive.log(line)` | a line in the app's log, prefixed with the extension's name |

### The hooks

**`seat.title`** — `({ name, where, title, mission, status, errand, settings }) => string`.
Synchronous, every time the app lists seats. What it returns is the label the
rail, the seat list and the palette show; nothing is written, so turning the
extension off restores the clean title. Cached per seat until the title, the
errand or the first line of the mission changes. Return the title unchanged
when there is nothing to do.

**`seat.opening`** — `async ({ body, prompt, settings }) => { body?, prompt?, name? } | undefined`.
Before a seat is born. `body` carries `name`, `branch`, `title`, `errand` and
whatever the request had; what you return is merged in, and `name` suggests the
seat's name. 1500 ms per extension; past that the seat opens without it.
Return `undefined` when there is nothing to do.

**`routes`** — `(on) => { on(method, path, handler) }`.
Once, when the module loads. Every path lives under `/api/ext/<name>/`; a path
outside it, a method other than `GET`, `POST` or `null` (any), or a path
registered twice is reported and not registered. The handler
`async ({ method, url, body, settings, storage }) => value` answers JSON with
200; `undefined` answers `{ ok: true }`; `throw hive.refuse(404, "…")` answers
that status. Any other exception answers 500, is listed as a problem, and the
route keeps serving. While the extension is off, its routes answer 404.

Extensions run in order: built-in, hub, personal, alphabetical within each. The
second receives what the first returned.

### What holds

- An exception in `seat.title` or `seat.opening` is reported and that hook is
  skipped until the extension is turned on again. It never takes the app down.
- A module is imported once per app run; a change on disk shows as stale and
  asks for the app to be reopened.
- Everything runs in the app's process, on the desktop. The pod runs no
  extensions.

The authoritative contract is the hive's own
[`app/extensions/README.md`](https://github.com/arvoreeducacao/dev-workspaces/blob/main/app/extensions/README.md);
when the two disagree, that one wins and this one has a bug.

## Writing one

Start from [`example/`](example/): copy the folder, rename it, delete the hooks
and settings you do not need. Then the rules of this repository:

- **Self-contained.** An extension imports nothing outside its own folder and
  installs no package. CI checks it. That is what lets it be copied anywhere.
- **Tested next to its code.** `<name>/<name>.test.mjs`, run with `node --test`,
  no framework: the module is called with a fake `hive` and each hook is
  exercised. CI runs every test in the repository.
- **English in the code**, like the hive: identifiers, manifests, tests, commits.
- **No comments in the code.** Names carry the meaning; reasons go in the commit
  message.
- **One extension per pull request**, with the tests that would have caught the
  bug. A new extension also adds its row to the table at the top of this file.

## Running the tests

```
node --test */*.test.mjs
```

## License

[Apache-2.0](LICENSE), the same as the hive.
