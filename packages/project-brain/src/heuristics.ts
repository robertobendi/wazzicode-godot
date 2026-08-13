import { promises as fs } from "node:fs";
import path from "node:path";

export interface ScriptHeuristics {
  managers: string[];
  singletons: string[];
  scriptableObjectTypes: string[];
  monoBehaviours: number;
  totalScripts: number;
  hasObjectPooling: boolean;
  hasSaveSystem: boolean;
  hasAudioManager: boolean;
}

const MANAGER_PATTERNS = [/Manager$/i, /Controller$/i, /Director$/i, /System$/i, /Service$/i];
const SINGLETON_PATTERNS = [/Singleton</i, /\.Instance\b/, /static\s+\w+\s+_?instance\b/i];
const POOL_PATTERNS = [/ObjectPool/i, /Pool<\w+>/i, /\bIPool\b/];
const SAVE_PATTERNS = [/SaveSystem|SaveManager|SaveGame|PlayerPrefs|Persistence/i];
const AUDIO_PATTERNS = [/AudioManager|SoundManager|MusicManager|AudioMixer/i];

export async function analyzeScripts(projectPath: string, scripts: string[]): Promise<ScriptHeuristics> {
  const out: ScriptHeuristics = {
    managers: [],
    singletons: [],
    scriptableObjectTypes: [],
    monoBehaviours: 0,
    totalScripts: scripts.length,
    hasObjectPooling: false,
    hasSaveSystem: false,
    hasAudioManager: false,
  };

  // The scanner applies and reports the project-wide cap. Never take a second,
  // silent sample here: totalScripts and every derived count cover the same set.
  for (const rel of scripts) {
    const abs = path.join(projectPath, rel);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (/:\s*MonoBehaviour\b/.test(text)) out.monoBehaviours++;
    if (/:\s*ScriptableObject\b/.test(text)) {
      const m = /class\s+(\w+)\s*:\s*ScriptableObject\b/.exec(text);
      if (m) out.scriptableObjectTypes.push(m[1]);
    }
    const className = path.basename(rel, ".cs");
    if (MANAGER_PATTERNS.some((re) => re.test(className))) out.managers.push(rel);
    if (SINGLETON_PATTERNS.some((re) => re.test(text))) out.singletons.push(rel);
    if (!out.hasObjectPooling && POOL_PATTERNS.some((re) => re.test(text))) out.hasObjectPooling = true;
    if (!out.hasSaveSystem && SAVE_PATTERNS.some((re) => re.test(text))) out.hasSaveSystem = true;
    if (!out.hasAudioManager && AUDIO_PATTERNS.some((re) => re.test(text))) out.hasAudioManager = true;
  }

  out.managers = unique(out.managers).sort();
  out.singletons = unique(out.singletons).sort();
  out.scriptableObjectTypes = unique(out.scriptableObjectTypes).sort();
  return out;
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
