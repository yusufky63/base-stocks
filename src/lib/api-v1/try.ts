import type { V1Endpoint, V1Param } from "./catalog";

/**
 * The request an endpoint's "Try it" sends and its curl line shows, from the values typed in. Pure,
 * so the developers page, llms-full.txt and the tests all build exactly the same request.
 */

export interface V1Request {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** The values an endpoint's form starts with: read out of its example path, query and body. */
export function exampleValues(e: V1Endpoint): Record<string, string> {
  const values: Record<string, string> = {};
  const [examplePath, query = ""] = e.example.split("?");
  const template = e.path.split("/");
  const actual = (examplePath ?? "").split("/");
  template.forEach((segment, i) => {
    const m = /^\{(\w+)\}$/.exec(segment);
    if (m && actual[i]) values[m[1]!] = decodeURIComponent(actual[i]!);
  });
  for (const [k, v] of new URLSearchParams(query)) values[k] = v;
  for (const [k, v] of Object.entries(e.body ?? {})) values[k] = String(v);
  return values;
}

function jsonValue(p: V1Param, raw: string): unknown {
  if (p.type === "integer") return Number(raw);
  if (p.type === "boolean") return raw === "true";
  return raw;
}

/** Empty values are left out; path parameters are filled in; body values take the type the route expects. */
export function buildRequest(e: V1Endpoint, values: Record<string, string>, base = ""): V1Request {
  let path = e.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const p of e.params ?? []) {
    const raw = values[p.name]?.trim() ?? "";
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(raw));
    else if (raw === "") continue;
    else if (p.in === "query") query.set(p.name, raw);
    else body[p.name] = jsonValue(p, raw);
  }
  const search = query.toString();
  const url = `${base}${path}${search ? `?${search}` : ""}`;
  if (e.method === "GET") return { method: "GET", url, headers: {} };
  return { method: "POST", url, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function exampleRequest(e: V1Endpoint, base = ""): V1Request {
  return buildRequest(e, exampleValues(e), base);
}

/** One curl line, quoted for a POSIX shell. */
export function curlOf(req: V1Request): string {
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  if (req.method === "GET") return `curl -s ${q(req.url)}`;
  const headers = Object.entries(req.headers)
    .map(([k, v]) => ` \\\n  -H ${q(`${k}: ${v}`)}`)
    .join("");
  return `curl -s -X POST ${q(req.url)}${headers}${req.body ? ` \\\n  -d ${q(req.body)}` : ""}`;
}
