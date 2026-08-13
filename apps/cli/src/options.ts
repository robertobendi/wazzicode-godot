export interface GlobalOptions {
  project: string;
  mock: boolean;
  json: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = "help";
  if (argv.length > 0 && !argv[0].startsWith("-")) {
    command = argv[0];
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.substring(2, eq)] = a.substring(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.substring(2)] = next;
          i++;
        } else {
          flags[a.substring(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

export function asGlobal(parsed: ParsedArgs): GlobalOptions {
  return {
    project: typeof parsed.flags.project === "string" ? parsed.flags.project : process.env.UVIBE_PROJECT ?? process.cwd(),
    mock: parsed.flags.mock === true || parsed.flags.mock === "true" || process.env.UVIBE_MOCK === "1",
    json: parsed.flags.json === true || parsed.flags.json === "true",
  };
}
