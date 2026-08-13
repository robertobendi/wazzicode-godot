import { promises as fs } from "node:fs";
import path from "node:path";

export interface ActionLogEntry {
  timestamp: number;
  tool: string;
  args?: Record<string, unknown>;
  result: "ok" | "error" | "blocked";
  errorCode?: string;
  snapshotId?: string;
  notes?: string;
}

export async function appendAction(projectPath: string, entry: ActionLogEntry): Promise<void> {
  const file = path.join(projectPath, ".unity-vibe", "action_log.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function readActions(projectPath: string, limit = 100): Promise<ActionLogEntry[]> {
  const file = path.join(projectPath, ".unity-vibe", "action_log.jsonl");
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    return tail.map((l) => JSON.parse(l) as ActionLogEntry);
  } catch {
    return [];
  }
}
