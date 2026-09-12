// Mirrors the Rust payloads in src-tauri/src/commands/opencode.rs (serde
// camelCase). Keep the two in sync.

export interface OpenCodeCredential {
  providerId: string;
  authType: string;
  /** A masked suffix such as `••••1234`; the full key is never returned. */
  keyHint: string | null;
  /** Display name from an OpenAI-compatible provider entry we configured. */
  displayName: string | null;
  baseUrl: string | null;
}

export interface OpenCodeAuthStatus {
  /** OpenCode's auth store (`~/.local/share/opencode/auth.json`). */
  path: string;
  /** OpenCode's global config (`~/.config/opencode/opencode.json`). */
  configPath: string | null;
  /** The `model` key in the global config, if any. */
  defaultModel: string | null;
  credentials: OpenCodeCredential[];
}

export interface OpenCodeCompatibleProviderSpec {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** A provider OpenCode already knows: only a key is needed. */
export interface ProviderPreset {
  id: string;
  name: string;
  keyHint: string;
  /** Where the user gets a key. */
  home: string;
}

/**
 * Known providers. OpenCode knows their endpoints and models, so saving a key
 * is enough to make their models usable — no provider entry is written.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    keyHint: "sk-or-v1-…",
    home: "https://openrouter.ai/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    keyHint: "sk-…",
    home: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    keyHint: "sk-…",
    home: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keyHint: "sk-ant-…",
    home: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    name: "Google",
    keyHint: "AIza…",
    home: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    name: "Groq",
    keyHint: "gsk_…",
    home: "https://console.groq.com/keys",
  },
  {
    id: "xai",
    name: "xAI",
    keyHint: "xai-…",
    home: "https://console.x.ai",
  },
  {
    id: "mistral",
    name: "Mistral",
    keyHint: "…",
    home: "https://console.mistral.ai/api-keys",
  },
];
