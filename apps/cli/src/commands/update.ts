import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { PRODUCT_VERSION } from "@gvibe/core";
import type { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";
import { refreshAgentBlocks } from "./init.js";
import { runInstallAddon } from "./installAddon.js";

/**
 * `gvibe update` — bring a project's Godot Vibe OS install back in line with this build.
 *
 * Three things rot independently once a project is set up, and all three change behaviour
 * silently: the copied editor addon (it speaks a protocol version with the MCP server), the
 * marker-delimited block in AGENTS.md / CLAUDE.md (the agent's standing brief — a project set up
 * months ago still follows months-old rules), and `.mcp.json` (its absolute paths stop resolving
 * the moment the checkout moves, and the agent simply has no tools with no error to explain it).
 *
 * Studio runs this whenever a project is opened; it is also safe to run by hand.
 */

const ADDON_RELATIVE = path.join("addons", "godot_vibe_os");

export interface UpdateReport {
  project: string;
  addon: {
    detected: boolean;
    from?: string;
    to?: string;
    action: "updated" | "current" | "not-installed" | "failed";
    detail?: string;
  };
  instructions: { action: "created" | "updated" | "appended" | "current" | "failed"; detail?: string };
  mcpConfig: { action: "current" | "stale" | "absent" };
}

export async function runUpdate(options: GlobalOptions, parsed: ParsedArgs): Promise<CommandResult> {
  const dryRun = parsed.flags["dry-run"] === true || parsed.flags["dry-run"] === "true";
  const project = path.resolve(options.project);
  const report: UpdateReport = {
    project,
    addon: { detected: false, action: "not-installed" },
    instructions: { action: "current" },
    mcpConfig: { action: "absent" },
  };

  // --- editor addon -------------------------------------------------------
  const installedVersion = await readAddonVersion(path.join(project, ADDON_RELATIVE));
  report.addon.detected = installedVersion !== null;
  if (installedVersion !== null) report.addon.from = installedVersion;
  if (installedVersion !== null && installedVersion !== PRODUCT_VERSION) {
    if (dryRun) {
      report.addon.action = "updated";
      report.addon.to = PRODUCT_VERSION;
    } else {
      // The installer is idempotent (recursive copy + project.godot reconciliation), so
      // re-running it *is* the update — no separate upgrade path to keep in sync.
      const installed = await runInstallAddon({ ...options, json: true }, { ...parsed, flags: {} });
      if (installed.exitCode === 0) {
        report.addon.action = "updated";
        report.addon.to = (await readAddonVersion(path.join(project, ADDON_RELATIVE))) ?? PRODUCT_VERSION;
      } else {
        report.addon.action = "failed";
        report.addon.detail = (installed.stderr ?? "").trim() || `exit ${installed.exitCode}`;
      }
    }
  } else if (installedVersion !== null) {
    report.addon.action = "current";
  }

  // --- agent instructions -------------------------------------------------
  try {
    if (dryRun) {
      const claude = await fs.readFile(path.join(project, "CLAUDE.md"), "utf8").catch(() => null);
      report.instructions.action =
        claude === null ? "created" : claude.includes("godot_query_project_brain") ? "current" : "updated";
    } else {
      const refreshed = await refreshAgentBlocks(project);
      // "current" only when every file was already what we would have written.
      report.instructions.action =
        refreshed.find((entry) => entry.action !== "current")?.action ?? "current";
    }
  } catch (error) {
    report.instructions.action = "failed";
    report.instructions.detail = error instanceof Error ? error.message : String(error);
  }

  // --- agent connection ---------------------------------------------------
  report.mcpConfig.action = await inspectMcpConfig(path.join(project, ".mcp.json"));

  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify({ serverVersion: PRODUCT_VERSION, dryRun, projects: [report] }, null, 2) + "\n" };
  }
  const changed =
    report.addon.action === "updated" ||
    (report.instructions.action !== "current" && report.instructions.action !== "failed");
  const lines = [
    `Godot Vibe OS ${PRODUCT_VERSION} — ${dryRun ? "checking" : "updating"} ${project}`,
    "",
    `  addon:        ${describeAddon(report)}`,
    `  instructions: ${report.instructions.action}${report.instructions.detail ? ` — ${report.instructions.detail}` : ""}`,
    `  .mcp.json:    ${report.mcpConfig.action}${report.mcpConfig.action === "stale" ? " — run `gvibe mcp-config --write`" : ""}`,
    "",
    changed
      ? dryRun
        ? "Re-run without --dry-run to apply."
        : "Updated. Reload the project in Godot so the editor picks up the addon."
      : "Already up to date.",
  ];
  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

function describeAddon(report: UpdateReport): string {
  switch (report.addon.action) {
    case "updated":
      return `${report.addon.from ?? "?"} → ${report.addon.to ?? PRODUCT_VERSION}`;
    case "current":
      return `${report.addon.from} (current)`;
    case "not-installed":
      return "not installed — run `gvibe install-addon`";
    default:
      return `failed${report.addon.detail ? ` — ${report.addon.detail}` : ""}`;
  }
}

/** `version="0.1.0"` out of the addon's plugin.cfg, or null when it isn't installed. */
export async function readAddonVersion(addonDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(addonDir, "plugin.cfg"), "utf8");
    return /^\s*version\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Does the project's `.mcp.json` still point at a server that exists? It pins absolute paths so
 * the user needs nothing on PATH, which rots the moment the checkout moves.
 */
export async function inspectMcpConfig(file: string): Promise<"current" | "stale" | "absent"> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return "absent";
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
    const entry = parsed.mcpServers?.["godot-vibe-os"];
    if (!entry) return "absent";
    const command = typeof entry.command === "string" ? entry.command : "";
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
    const absolute = [command, ...args].filter((value) => value.includes("/") || value.includes("\\"));
    return absolute.every((value) => existsSync(value)) ? "current" : "stale";
  } catch {
    // Someone else's malformed file — not ours to judge or rewrite.
    return "absent";
  }
}
