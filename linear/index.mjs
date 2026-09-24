import { join } from "node:path";
import { createLinearDomain } from "./domain.mjs";

export default function linear(hive) {
  let settings = {};
  const domain = createLinearDomain({
    env: process.env,
    envFile: hive.paths.hub ? join(hive.paths.hub, ".env") : "",
    log: hive.log,
    settingsOf: () => settings
  });
  hive.on("seat.opening", async (asked) => {
    settings = asked.settings || settings;
    return domain.opening(asked);
  });
  hive.on("routes", (on) => domain.register((method, path, fn) => on(method, path, async (asked) => {
    settings = asked.settings || settings;
    return fn(asked);
  }), hive.refuse));
}
