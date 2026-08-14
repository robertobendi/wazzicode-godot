extends SceneTree

const DebuggerBridge = preload("res://addons/godot_vibe_os/debugger_bridge.gd")


func _initialize() -> void:
	var debugger = DebuggerBridge.new()
	for cursor in range(1, 241):
		debugger._append_sample(_sample(cursor))
	var baseline: Dictionary = debugger.snapshot({"maxEvents": 1, "maxSamples": 1})
	debugger._append_sample(_sample(241))
	var latest: Dictionary = debugger.snapshot({
		"sinceSampleCursor": baseline.sampleCursor,
		"maxEvents": 1,
		"maxSamples": 1,
	})
	if int(latest.droppedSamples) != 0:
		_fail("Evicting evidence older than the caller baseline must not count as a dropped sample.")
		return
	if int(latest.missedSamples) != 0 or latest.samples.size() != 1 or int(latest.samples[0].cursor) != 241:
		_fail("A caller at the baseline cursor must receive the new sample without a gap.")
		return
	var lagged: Dictionary = debugger.snapshot({"sinceSampleCursor": 0, "maxEvents": 1, "maxSamples": 1})
	if int(lagged.missedSamples) != 1:
		_fail("Cursor-relative gap accounting must report the evicted sample to a lagged caller.")
		return
	quit(0)


func _sample(cursor: int) -> Dictionary:
	return {
		"timestampMs": cursor * 250,
		"fps": 60.0,
		"processMs": 8.0,
		"physicsMs": 2.0,
		"memoryBytes": 1024.0,
		"objectCount": 10.0,
		"nodeCount": 5.0,
		"orphanNodeCount": 0.0,
		"drawCalls": 4.0,
	}


func _fail(message: String) -> void:
	push_error(message)
	quit(1)
