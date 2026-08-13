# Repository instructions

- This is the Godot port of foundry-unity. Do not copy Unity concepts by name when Godot has a different model.
- Never guess Godot APIs. Verify them against the installed Godot 4 editor (`godot --doctool`, `--dump-extension-api`) or official Godot documentation before use.
- Treat `godot/addons/godot_vibe_os/` as the source addon. Generated copies in fixture projects are not authoritative.
- Never edit `.tscn` or `.tres` text to mutate a scene that is open in the editor. Route live scene changes through the addon and `EditorUndoRedoManager`.
- After GDScript changes, run the Godot syntax/import check and the real bridge integration test. After TypeScript/Rust changes, run the relevant build and tests.
- No feature may claim test support unless an actual project test runner was detected and executed. Godot import/script validation is not a test suite.
- Bind bridge servers only to `127.0.0.1`, validate project identity, and keep generated state under `.godot-vibe/` or `.godot/godot-vibe-os/`.
- Keep dependencies minimal and preserve the existing foundry visual language while using Godot-native terminology: nodes, scenes, resources, autoloads, signals, and the running project.
