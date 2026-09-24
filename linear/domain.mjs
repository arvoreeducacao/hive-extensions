import { fetchIssue, fetchMine, linearKey, linearToken, missionWithIssue, seatNameForIssue } from "./linear.mjs";

const MINE_FRESH = 60000;

export const NO_TOKEN_SAID = "no Linear token — set it in the linear extension, or put LINEAR_API_KEY in the hub .env";

export function createLinearDomain({ env = process.env, envFile = "", fetchImpl = fetch, now = Date.now, log = () => {}, settingsOf = () => ({}) } = {}) {
  let mine = { at: 0, said: null };

  const token = () => String(settingsOf()?.token || "").trim() || linearToken({ env, envFile });

  async function issue(identifier) {
    return fetchIssue(identifier, { token: token(), fetchImpl });
  }

  async function assigned(force = false) {
    if (!force && mine.said && now() - mine.at < MINE_FRESH) return mine.said;
    const said = await fetchMine({ token: token(), fetchImpl });
    if (!said.error) mine = { at: now(), said };
    return said;
  }

  async function enrich(body, prompt) {
    const key = linearKey(prompt);
    if (!key || !token()) return { prompt, body, issue: null };
    const said = await issue(key);
    if (said.error) { log(`linear ${key}: ${said.error}`); return { prompt, body, issue: null }; }
    const next = { ...body };
    if (!String(next.branch || "").trim() && said.issue.branch) next.branch = said.issue.branch;
    if (!String(next.title || "").trim()) next.title = `${said.issue.identifier} · ${said.issue.title}`.slice(0, 60);
    if (!String(next.errand || "").trim()) next.errand = `${said.issue.identifier} ${said.issue.title}`.slice(0, 60);
    return { prompt: missionWithIssue(prompt, said.issue), body: next, issue: said.issue, name: seatNameForIssue(said.issue) };
  }

  async function opening({ body, prompt }) {
    const rich = await enrich(body, prompt);
    if (!rich.issue) return undefined;
    return { body: rich.body, prompt: rich.prompt, name: rich.name };
  }

  function register(on, refuse) {
    on("GET", "/api/ext/linear/mine", async ({ url }) => {
      if (!token()) throw refuse(503, NO_TOKEN_SAID);
      const said = await assigned(!!url.searchParams.get("force"));
      if (said.error) throw refuse(502, said.error);
      return { ok: true, me: said.me, issues: said.issues, at: mine.at };
    });

    on("GET", "/api/ext/linear/issue", async ({ url }) => {
      const key = linearKey(url.searchParams.get("key") || "");
      if (!key) throw refuse(400, "give an issue key like ABC-123, or its url");
      if (!token()) throw refuse(503, NO_TOKEN_SAID);
      const said = await issue(key);
      if (said.error) throw refuse(502, said.error);
      return { ok: true, issue: said.issue };
    });
  }

  return { register, issue, assigned, enrich, opening, hasToken: () => !!token() };
}
