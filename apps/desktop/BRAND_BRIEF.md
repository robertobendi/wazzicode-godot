# Foundry for Godot — visual identity brief

Foundry belongs to the same product family as Hightower: the neutral ramp, typography, status colors, and restrained desktop chrome should feel related. Its own character is calm industrial warmth—dark metal, pale type, and a precise ember accent—with a small cyan-blue signal reserved for the live Godot editor.

## Product in one sentence

Foundry for Godot is a native desktop app where you describe a game change and an AI agent works against the project and Godot editor that are actually open.

## Product truth

The user chooses a directory containing `project.godot`. Godot Vibe OS installs at `res://addons/godot_vibe_os`, keeps project-owned state and a source-backed project brain under `.godot-vibe/`, and connects Foundry to the open editor.

The agent can inspect scenes, nodes, resources, scripts, selection, import state, and exact 2D or 3D viewport captures. It can edit and save scenes, change resources and scripts, run or stop the project, and report observed results. It is an operating surface for Godot, not a replacement for the editor or for human art direction.

Verification language must remain exact. A passing `godot_verify` result means headless import and GDScript syntax checks passed. Automated tests are `not_configured` unless a real project runner was configured and observed. Never invent a compile result, passing test count, or runtime outcome.

## Audience and character

Foundry is for solo developers and small teams who know what they want in a Godot project but would rather describe the mechanical change than click through every inspector field or hand-edit every resource.

The voice is:

- **Honest.** Report the tool result, including failures and unavailable evidence.
- **Calm.** Short sentences, no celebration copy, emoji, or theatrical AI language.
- **Warm.** Ember marks intent and action without turning the interface loud.
- **Dense, not crowded.** Chat, activity, project state, and verification remain readable together.
- **Native.** It should feel like a focused desktop tool beside Godot.

The mental model is a foundry: intent enters; careful, visible work shapes it. No magic-wand framing, mascots, controllers, pixel-art decoration, sparkles, or neural imagery.

## Visual system

Use the shared dark-first neutral ramp: background `#0a0b0d`, raised surface `#101216`, foreground `#e8eaee`, green `#7dc598`, amber `#e8c874`, and red `#e06e6e`. Light mode is a full peer built from the same roles.

Godot editor blue is the single primary accent: `#6fbeef` on dark, `#2b76a8` on light, with `#183244` (dark) / `#daeffb` (light) as the tinted fill behind selected chips. Use it for the primary action, selected mode, and an agent task in progress.

There is no secondary accent. Each engine app carries exactly one accent — ember belongs to the Unity sibling, editor blue to this app — and the blue must not become a gradient, glow, or decorative wash.

Typography is system-first—SF Pro, Inter, or Segoe UI Variable—with JetBrains Mono or SF Mono for `res://` paths, NodePaths, scripts, import output, and tool results. Use tabular numerals for cost, tokens, duration, and real measured counts.

Icons are thin-stroke and geometric. The app mark remains two vertical piers joined by a bridge in a `#11110f` rounded square — the container shared with the Unity sibling — with an editor-blue glyph (`#6fbeef`). Keep the piers distinct at 16×16; do not insert the Godot face or other engine imagery into the mark.

## Screenshots

- Use a real Godot project, open scene, and specific prompt, such as “Add a `Camera2D` under `Player` and keep it centered.”
- Show evidence that distinguishes the product: an exact `res://` scene path, scene/node activity, a relevant resource or script, and a fresh 2D or 3D editor capture.
- Show honest verification output. “Import passed; 6 scripts checked; tests `not_configured`” is acceptable only when those values are visible in the captured result. Never manufacture a green state or test count for composition.
- Prefer a composed working surface over a hero chat bubble. The activity trail and live-editor context are part of the product.

## Words

Use sentence case and Godot's vocabulary: open scene, add node, edit resource, attach script, refresh filesystem, import, save scene, run project, stop project. Use `res://` paths and exact NodePaths when useful. Use git's words for checkpoint and revert.

Keep labels direct: “Run project”, “Save scene”, “Inspect node”, “Import failed”. A suitable status line is “Godot is importing resources…” Never say code compiled, tests passed, or behavior worked without matching evidence.

Tagline territory:

- *Describe the change. See it in Godot.*
- *Your open scene, on the other end of a sentence.*
- *An agent that can see the scene.*

Success is a screenshot that reads immediately as Foundry—quiet, exact, ember-led—and also makes the live connection to Godot unmistakable through one restrained cyan-blue signal.
