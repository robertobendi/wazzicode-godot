@tool
extends EditorPlugin

const BridgeServer = preload("bridge_server.gd")

var _bridge: Node


func _enter_tree() -> void:
	_bridge = BridgeServer.new(get_editor_interface())
	add_child(_bridge)
	_bridge.start()


func _exit_tree() -> void:
	if _bridge != null:
		_bridge.stop()
		_bridge.queue_free()
		_bridge = null
