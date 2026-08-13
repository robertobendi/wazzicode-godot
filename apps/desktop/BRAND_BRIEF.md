# foundry-unity — Visual Identity Brief

Companion to [Hightower's brief](https://github.com/Labyrica/hightower/blob/main/BRAND_BRIEF.md). Same suite, same system: identical neutral ramp, status hues, type stacks and chrome. Foundry differs in exactly one dimension — the accent is ember orange where Hightower is achromatic. If you are choosing between "make it its own thing" and "make it obviously a sibling", choose sibling.

---

## In one sentence

**foundry-unity is a native desktop app that lets you build a Unity game by describing what you want.** Mac and Windows. You talk, an AI agent works inside your open Unity Editor.

## What the app does

You point it at a Unity project. It pairs with your Claude or ChatGPT plan, connects to the Unity Editor you already have open, and gives you a chat window that can actually *do* things: create and edit C# scripts, move objects, wire prefabs, paint tilemaps, enter play mode, read the console, run tests.

The agent is not guessing from files on disk. It queries the live Editor — the real scene graph, the real compile status, the real loaded assemblies — so it works against your Unity version and your packages, not from memory.

Two modes. **Chat** is turn by turn: you ask, it works, you look. **Auto** takes a goal and keeps going, checkpointing as it works so any turn can be reverted. Either way every change is verified by compiling and running tests before it claims to be done.

## Who it's for

Someone who has a Unity project open right now and would rather describe the change than hunt for the inspector field. Specifically:

- Solo devs, small studios, hobbyists shipping real games.
- Comfortable in Unity, not necessarily comfortable in C#. Or fluent in both and simply tired of the click-through.
- Already uses Claude Code, Cursor, or Copilot for the code half of the job, and wants that reach to extend into the Editor.
- Cares about craft. Notices when a tool is guessing.

Overlaps heavily with Hightower's audience — the same person, a different half of the day.

## What it competes with

- **Copy-pasting from a chat window into MonoBehaviour files.** The actual incumbent. We're trying to be the thing that closes that loop.
- **Unity Muse / in-Editor assistants** — scoped to suggestions inside Unity's own UI. We're a desktop app that drives the Editor.
- **A coding agent in a terminal** — can write the script, can't see the scene, can't tell you whether it compiled or whether the object moved.

We are not trying to replace the Editor. Layout, art direction, and taste stay with the human; foundry does the mechanical work and reports honestly on whether it worked.

## The mental model

**A foundry.** You bring the intent, it does the hot, repetitive, precise work. The name is the metaphor: molten material shaped to a mould, not a magic wand. Nothing here is conjured — it is worked.

The feelings to optimize for: **honest craft, verified work, no theatre.**

## The feeling

Same person as Hightower — a senior engineer who communicates in short sentences and doesn't show off — except this one is standing at your desk while the project is open, and tells you plainly when a build failed.

Adjective list:
- **Honest.** "Done" means compiled and tested. Failures are reported with the error, not softened.
- **Calm.** No emoji. No exclamation points. No celebrations for a passing build.
- **Warm.** The one place foundry differs from Hightower in feel: the ember accent. Used sparingly — a running task, a selected mode, a primary action.
- **Dense, not crowded.** Chat is the surface, but status, cost, Unity state and activity are always visible without a click.
- **Native.** A real desktop app. Not a website in a window.

What it is **not**:
- Not a chatbot persona. No name, no personality, no "Happy to help!"
- Not magical. We show the tools it called and what they returned.
- Not gamedev-cute. No pixel art, no controllers, no joysticks in the iconography.

## Visual direction

**Palette**: dark-first, shared with Hightower token for token. Background `#0a0b0d`, raised surface `#101216`, foreground `#e8eaee`, status green `#7dc598` / amber `#e8c874` / red `#e06e6e`. Light mode is a full peer, not an afterthought — it flips the same tokens.

The **accent is ember orange**: `#f0915c` on dark, `#b8431f` on light, with a warm brown tint (`#3c2619`) as the fill behind selected chips. This is the only hue that separates the two apps. Do not introduce a second accent.

**Typography**: system-first, identical stack to Hightower — SF Pro / Inter / Segoe UI Variable, with JetBrains Mono or SF Mono for code, paths, and console output. Tabular numerals for costs, token counts, and timings.

**Iconography**: thin-stroke, geometric, lucide-style. One hand, one set. Shared with Hightower wherever the two apps show the same concept.

## Logo / app icon

The mark is already fixed and should be treated as a system with Hightower's:

- Same container: a `#11110f` rounded square, 22% radius, at every size.
- Same construction: two vertical piers joined by a bridge, drawn as flat rounded bars.
- Different ink: foundry's glyph is peach `#fed7aa`; Hightower's is lavender.

Read at 16×16 first — the piers must stay separable at that size. Do not add gradients, glow, Unity's cube, or anything AI-themed (sparkles, orbs, neural fluff).

## Screenshots / marketing surface

- Show a real Unity project name and a real prompt — "make the enemy respawn after 3 seconds", not "do the thing".
- Show the agent's tool calls in the activity panel. The transparency *is* the product.
- Show a verified result: the green Unity dot, a passing test count. Never a screenshot of the app mid-claim.
- Title-bar overlay is on, no chrome stripe. The window is the canvas.

## Words

- Sentence case, never title case.
- Short. "Run tests", not "Execute the project's test suite".
- Use Unity's words: scene, prefab, component, play mode, inspector. Use git's words: revert, checkpoint. No marketing translations.
- Dry is fine. Never cute. "Unity is recompiling — hang on…" is the right register.

Tagline candidates (starting points, argue with them):
- *Describe it. Unity builds it.*
- *Your Editor, on the other end of a sentence.*
- *The agent that can see your scene.*

## What success looks like

Someone posts a screenshot of foundry next to Hightower in their dock and it's obvious they're from the same shop — without either one looking like a re-skin of the other.
