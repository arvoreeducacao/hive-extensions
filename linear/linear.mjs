import { existsSync, readFileSync } from "node:fs";

export const LINEAR_API = "https://api.linear.app/graphql";
export const NO_TOKEN = "no LINEAR_API_KEY — put it in the hub .env";
const ISSUE_URL = /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d{1,6})(?:\/[^\s)]*)?/i;
const ISSUE_LEAD = /^\s*([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/i;
const ISSUE_TAIL = /^([^\n]*?)[ \t]*\(([A-Z][A-Z0-9]{1,9}-\d{1,6})\)[ \t]*\.?[ \t]*(?=\n|$)/i;
const IMAGE_MD = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const DESCRIPTION_MAX = 6000;

export function linearToken({ env = process.env, envFile = "" } = {}) {
  const fromEnv = String(env.LINEAR_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (!envFile || !existsSync(envFile)) return "";
  try {
    const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.trim().startsWith("LINEAR_API_KEY="));
    return line ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

export function linearKey(text) {
  const said = String(text || "");
  const url = ISSUE_URL.exec(said);
  if (url) return url[1].toUpperCase();
  const lead = ISSUE_LEAD.exec(said);
  if (lead) return lead[1].toUpperCase();
  const tail = ISSUE_TAIL.exec(said);
  return tail ? tail[2].toUpperCase() : "";
}

export function imagesOf(markdown) {
  return [...new Set([...String(markdown || "").matchAll(IMAGE_MD)].map((m) => m[1]))];
}

export function issueOf(node) {
  if (!node) return null;
  return {
    id: node.id || "",
    identifier: node.identifier || "",
    title: node.title || "",
    description: String(node.description || "").slice(0, DESCRIPTION_MAX),
    url: node.url || "",
    branch: node.branchName || "",
    state: node.state?.name || "",
    stateType: node.state?.type || "",
    assignee: node.assignee?.displayName || node.assignee?.name || "",
    priority: Number(node.priority) || 0,
    priorityLabel: node.priorityLabel || "",
    team: node.team?.key || "",
    project: node.project?.name || "",
    updatedAt: node.updatedAt || "",
    images: imagesOf(node.description),
    attachments: (node.attachments?.nodes || []).map((one) => ({ title: one.title || "", url: one.url || "" })).filter((one) => one.url)
  };
}

const ISSUE_FIELDS = "id identifier title description url branchName priority priorityLabel updatedAt state { name type } assignee { name displayName } team { key } project { name } attachments { nodes { title url } }";

export async function askLinear(query, variables, { token, fetchImpl = fetch, timeout = 15000 } = {}) {
  if (!token) return { error: NO_TOKEN };
  let res;
  try {
    res = await fetchImpl(LINEAR_API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (wrong) {
    return { error: `Linear did not answer — ${String(wrong?.message || wrong)}` };
  }
  if (res.status === 401 || res.status === 403) return { error: "Linear refused the key — check LINEAR_API_KEY in the hub .env" };
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) return { error: `Linear answered ${res.status}` };
  if (body.errors?.length) return { error: body.errors.map((e) => e.message).join("; ") };
  return { data: body.data };
}

export async function fetchIssue(identifier, opts) {
  const key = String(identifier || "").toUpperCase();
  if (!key) return { error: "which issue?" };
  const said = await askLinear(`query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: key }, opts);
  if (said.error) return said;
  const issue = issueOf(said.data?.issue);
  return issue ? { issue } : { error: `no issue ${key} in this Linear` };
}

export async function fetchMine(opts) {
  const said = await askLinear(
    `query Mine { viewer { name assignedIssues(first: 40, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } } }`,
    {}, opts
  );
  if (said.error) return said;
  const nodes = said.data?.viewer?.assignedIssues?.nodes || [];
  return { me: said.data?.viewer?.name || "", issues: nodes.map(issueOf) };
}

export function missionWithIssue(prompt, issue) {
  if (!issue) return String(prompt || "");
  const rest = String(prompt || "").replace(ISSUE_URL, "").replace(ISSUE_LEAD, "").replace(ISSUE_TAIL, "$1").trim();
  const head = [
    `[hive] Linear ${issue.identifier} — ${issue.title}`,
    issue.url,
    issue.branch ? `branch: ${issue.branch}` : "",
    [issue.state ? `state: ${issue.state}` : "", issue.assignee ? `assignee: ${issue.assignee}` : "", issue.project ? `project: ${issue.project}` : ""].filter(Boolean).join(" · ")
  ].filter(Boolean).join("\n");
  const body = issue.description ? `\n\n${issue.description.trim()}` : "";
  const images = issue.images.length ? `\n\nimages in the issue (open them — a mock-up or a screenshot of the bug is usually there):\n${issue.images.map((u) => `- ${u}`).join("\n")}` : "";
  const files = issue.attachments.length ? `\n\nattachments:\n${issue.attachments.map((a) => `- ${a.title ? `${a.title}: ` : ""}${a.url}`).join("\n")}` : "";
  const ask = rest ? `\n\n${rest}` : "\n\nDo what the issue asks. Open a PR on the branch above when done, and put the issue link in its description.";
  return `${head}${body}${images}${files}${ask}`;
}

export function seatNameForIssue(issue) {
  return String(issue?.identifier || "").toLowerCase();
}
