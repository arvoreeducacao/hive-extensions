# hive-extensions

Extensions for the [hive](https://github.com/arvoreeducacao/dev-workspaces) that
anyone can install. None of them ships inside the app: each is a folder you copy
into your hub or your machine and turn on in the extensions panel.

| Extension | What it does |
|---|---|
| [`linear`](linear/) | a mission that leads with an issue key, or a Linear url, opens the seat with the issue: description, branch, title, errand and name; the palette lists the issues assigned to you |

## Installing one

```
git clone https://github.com/arvoreeducacao/hive-extensions
cp -r hive-extensions/linear ~/.hive/extensions/linear        # this machine only
cp -r hive-extensions/linear <your hub>/extensions/linear    # everyone who opens that hub
```

Then open the extensions panel in the hive (palette: "extensions") and turn it
on. A hub or personal extension starts off; turning it on records the module as
it is, and a module that changes on disk afterwards asks to be turned on again.

## Writing one

An extension is a folder with `extension.json` and `index.mjs`. The contract —
manifest, settings, hooks, storage, what holds — is the hive's own
[`app/extensions/README.md`](https://github.com/arvoreeducacao/dev-workspaces/blob/main/app/extensions/README.md).

The rules of this repository:

- **Self-contained.** An extension imports nothing outside its own folder and
  installs no package. That is what lets it be copied anywhere.
- **Tested next to its code.** `<name>/<name>.test.mjs`, run with `node --test`,
  no framework. CI runs every test in the repository.
- **English in the code**, like the hive: identifiers, manifests, tests, commits.
- **No comments in the code.** Names carry the meaning; reasons go in the commit
  message.
- **One extension per pull request**, with the tests that would have caught the
  bug.

## Running the tests

```
node --test */*.test.mjs
```

## License

[Apache-2.0](LICENSE), the same as the hive.
