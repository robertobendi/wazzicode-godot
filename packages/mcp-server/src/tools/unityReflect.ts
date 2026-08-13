import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall, ok, err } from "./_helpers.js";

/**
 * Anti-hallucination tools. The #1 way an LLM breaks a Unity build is by calling an API that
 * doesn't exist (wrong name, wrong signature, removed in this version). unity_reflect checks the
 * live, loaded type system of THIS project — exact Unity + package versions — so you can confirm a
 * type/member exists and read its real signature before writing code. unity_docs fetches the
 * official Unity manual/script reference for prose/usage guidance.
 */

const ReflectShape = {
  action: z.enum(["search", "get_type", "get_member"]).describe("search types by name | list a type's members | get one member's signatures."),
  query: z.string().optional().describe("search: substring to match against type names."),
  type: z.string().optional().describe("get_type/get_member: type name (simple like 'Rigidbody' or full 'UnityEngine.Rigidbody')."),
  member: z.string().optional().describe("get_member: member name on that type."),
  scope: z.enum(["unity", "project", "packages", "all"]).optional().describe("search scope (default all)."),
  exact: z.boolean().optional().describe("search: exact name match only."),
  includeInherited: z.boolean().optional().describe("get_type: include inherited members (default false → declared only)."),
  limit: z.number().int().optional().describe("Cap on results (default 50 search / 200 members)."),
};

export const unityReflect: ToolDef<typeof ReflectShape, unknown> = {
  name: "unity_reflect",
  description:
    "Introspects the live C# type system of the running Editor (every loaded assembly: this project's exact Unity + packages). action=search finds types by name; action=get_type lists a type's methods/properties/fields, base type & interfaces; action=get_member returns a member's full signatures incl. overloads. Use it to verify an API exists and read its real signature BEFORE writing C# — it is ground truth, unlike memory or docs that may lag your installed version.",
  requires: ["unity_bridge"],
  inputShape: ReflectShape,
  async run(args, ctx) {
    return bridgeCall(ctx.bridge, BRIDGE_METHODS.reflectQuery, {
      action: args.action,
      query: args.query,
      type: args.type,
      member: args.member,
      scope: args.scope ?? "all",
      exact: args.exact ?? false,
      includeInherited: args.includeInherited ?? false,
      limit: args.limit ?? 0,
    });
  },
};

interface DocsResult {
  query: string;
  found: boolean;
  url?: string;
  title?: string;
  summary?: string;
  candidates: string[];
}

const DOCS_BASE = "https://docs.unity3d.com/ScriptReference/";

function docCandidates(query: string): string[] {
  const q = query.trim().replace(/\s+/g, "");
  const urls = new Set<string>();
  urls.add(`${DOCS_BASE}${q}.html`); // Type or Type.Method
  if (q.includes(".")) {
    // Properties are published as Type-member.html; the type page is Type.html.
    urls.add(`${DOCS_BASE}${q.replace(/\.([^.]+)$/, "-$1")}.html`);
    urls.add(`${DOCS_BASE}${q.split(".")[0]}.html`);
  }
  return Array.from(urls);
}

async function fetchText(url: string, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { "user-agent": "unity-vibe-os" } });
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extract(html: string): { title?: string; summary?: string } {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s*-\s*Unity.*$/i, "").trim() : undefined;
  // Unity ScriptReference puts the prose in <div class="subsection"> blocks; fall back to the
  // first paragraph. Strip tags and collapse whitespace.
  let region = html;
  const sub = html.match(/<div class="subsection">([\s\S]*?)<\/div>/i);
  if (sub) region = sub[1];
  const para = region.match(/<p>([\s\S]*?)<\/p>/i);
  const raw = para ? para[1] : region;
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  const summary = text.length > 800 ? text.slice(0, 800) + "…" : text;
  return { title, summary: summary || undefined };
}

const DocsShape = {
  query: z.string().describe("A type or member, e.g. 'NavMeshAgent', 'Physics.Raycast', 'Transform.position'."),
  timeoutMs: z.number().int().optional().describe("Per-request fetch timeout (default 8000)."),
};

export const unityDocs: ToolDef<typeof DocsShape, DocsResult> = {
  name: "unity_docs",
  description:
    "Looks up the official Unity Scripting API documentation for a type or member and returns the page title, a prose summary, and the URL. Best-effort over the network (latest docs version); when it can't fetch, it still returns the candidate doc URLs so you can cite them. Pair with unity_reflect, which verifies the API against your installed version.",
  requires: [],
  inputShape: DocsShape,
  async run(args, ctx) {
    const query = (args.query ?? "").trim();
    const meta = { source: ctx.bridge.source } as const;
    if (!query) return err("INVALID_ARGUMENT", "unity_docs needs a non-empty 'query'.", meta);
    const candidates = docCandidates(query);
    const timeoutMs = args.timeoutMs ?? 8000;
    for (const url of candidates) {
      const res = await fetchText(url, timeoutMs);
      if (res && res.status >= 200 && res.status < 300 && /<html/i.test(res.body)) {
        const { title, summary } = extract(res.body);
        return ok<DocsResult>({ query, found: true, url, title, summary, candidates }, meta);
      }
    }
    return ok<DocsResult>(
      { query, found: false, candidates },
      meta,
      ["Could not fetch a matching Unity docs page (offline, or the symbol isn't a ScriptReference page). The candidate URLs are listed; verify the API with unity_reflect instead."]
    );
  },
};
