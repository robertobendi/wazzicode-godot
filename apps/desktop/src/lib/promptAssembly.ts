// Turn a user message + staged attachments into the prompt sent to Claude.
//
// The user's own text is kept verbatim; attachment instructions are appended
// under a divider so the agent knows exactly how to use each staged file. Kind
// classification is owned by Rust (commands/resources.rs) — we only map the
// resulting `kind` to an instruction here, so there's no duplicate ext list.

import type { Attachment, ResourceKind } from "@/types/chat";

const DIVIDER = "--- Attached resources ---";

/** The per-attachment instruction line, keyed off its Rust-assigned kind. */
export function instructionFor(kind: ResourceKind, path: string): string {
  switch (kind) {
    case "image":
      return `Look at the image at "${path}" (use your Read tool to view it).`;
    case "model":
    case "audio":
      return `Import the asset at "${path}" into the project with unity_import_asset, then use it appropriately for this request.`;
    case "text":
      return `Read "${path}" for extra context.`;
    default:
      return `There is a file at "${path}" relevant to this request.`;
  }
}

/**
 * Build the final prompt. With no attachments this is a verbatim passthrough of
 * `text`; otherwise the user's text is followed by a divider and one
 * instruction line per attachment.
 */
export function assemblePrompt(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((a) => instructionFor(a.kind, a.path));
  const section = [DIVIDER, ...lines].join("\n");
  return text ? `${text}\n\n${section}` : section;
}
