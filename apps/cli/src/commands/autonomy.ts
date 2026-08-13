import { loadConfig, writeConfig, UVibeConfig } from "@uvibe/safety";
import { CommandResult, GlobalOptions, ParsedArgs } from "../options.js";

/** Legacy emergency access command. Studio repairs normal access automatically. */
export async function runAutonomy(g: GlobalOptions, parsed: ParsedArgs): Promise<CommandResult> {
  const mode = (parsed.positional[0] ?? "status").toLowerCase();
  const current = await loadConfig(g.project);

  if (mode === "status") {
    return report(g, current, "Project access status");
  }

  let next: UVibeConfig;
  if (mode === "on") {
    next = {
      ...current,
      safetyMode: "autopilot",
      allowSceneWrites: true,
      allowPrefabWrites: true,
      allowScriptWrites: true,
      allowAssetWrites: true,
      allowMenuItems: true,
      allowCodeExecution: true,
      allowedMenuItems: ["*"],
      autoSnapshot: true,
    };
  } else if (mode === "off") {
    next = { ...current, safetyMode: "read_only" };
  } else {
    return {
      exitCode: 2,
      stderr: `Unknown mode '${mode}'. Use: uvibe autonomy [on|off|status].\n`,
    };
  }

  await writeConfig(g.project, next);
  return report(g, next, mode === "on" ? "Project access repaired" : "Project access locked");
}

function report(g: GlobalOptions, cfg: UVibeConfig, title: string): CommandResult {
  if (g.json) {
    return {
      exitCode: 0,
      stdout:
        JSON.stringify(
          {
            safetyMode: cfg.safetyMode,
            allowSceneWrites: cfg.allowSceneWrites,
            allowPrefabWrites: cfg.allowPrefabWrites,
            allowScriptWrites: cfg.allowScriptWrites,
            allowAssetWrites: cfg.allowAssetWrites,
            allowMenuItems: cfg.allowMenuItems,
            allowCodeExecution: cfg.allowCodeExecution,
            autoSnapshot: cfg.autoSnapshot,
          },
          null,
          2
        ) + "\n",
    };
  }
  const lines = [
    `${title}:`,
    "",
    `  safetyMode:        ${cfg.safetyMode}`,
    `  allowSceneWrites:  ${cfg.allowSceneWrites}`,
    `  allowPrefabWrites: ${cfg.allowPrefabWrites}`,
    `  allowScriptWrites: ${cfg.allowScriptWrites}`,
    `  allowAssetWrites:  ${cfg.allowAssetWrites}`,
    `  allowMenuItems:    ${cfg.allowMenuItems}`,
    `  allowCodeExecution:${cfg.allowCodeExecution}`,
    `  autoSnapshot:      ${cfg.autoSnapshot}`,
    "",
    cfg.safetyMode === "read_only"
      ? "Studio access is locked."
      : "Studio access is ready. Changes are protected by checkpoints, Unity Undo, snapshots, and the action log.",
  ];
  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}
