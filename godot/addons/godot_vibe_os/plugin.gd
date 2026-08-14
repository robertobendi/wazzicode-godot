@tool
extends EditorPlugin

const BridgeServer = preload("bridge_server.gd")
const DebuggerBridge = preload("debugger_bridge.gd")
const RUNTIME_PROBE_SETTING := "autoload/FoundryRuntimeProbe"
const RUNTIME_PROBE_PATH := "res://addons/godot_vibe_os/runtime_probe.gd"

var _bridge: Node
var _debugger


func _enter_tree() -> void:
	_debugger = DebuggerBridge.new()
	_debugger.start()
	add_debugger_plugin(_debugger)
	if not _runtime_probe_configured():
		push_warning("[GodotVibeOS] Runtime debugging is unavailable. Re-run gvibe install-addon to configure FoundryRuntimeProbe.")
	_bridge = BridgeServer.new(get_editor_interface(), _debugger)
	add_child(_bridge)
	_bridge.start()


func _exit_tree() -> void:
	if _bridge != null:
		_bridge.stop()
		_bridge.queue_free()
		_bridge = null
	if _debugger != null:
		remove_debugger_plugin(_debugger)
		_debugger.stop()
		_debugger = null


func _runtime_probe_configured() -> bool:
	if not ProjectSettings.has_setting(RUNTIME_PROBE_SETTING):
		return false
	return str(ProjectSettings.get_setting(RUNTIME_PROBE_SETTING, "")).trim_prefix("*") == RUNTIME_PROBE_PATH
