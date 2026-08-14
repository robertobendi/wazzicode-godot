extends Node

const DebugLogger = preload("debug_logger.gd")
const MESSAGE_PREFIX := "godot_vibe_os"
const SAMPLE_INTERVAL_MS := 250
const MAX_EVENT_BATCH := 64
const MAX_CAPTURE_WIDTH := 1280
const MAX_CAPTURE_HEIGHT := 720
const MAX_CAPTURE_BYTES := 4 * 1024 * 1024

var _logger: Logger
var _logger_registered := false
var _capture_registered := false
var _capture_in_progress := false
var _last_sample_at := 0


func _init() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not EngineDebugger.is_active():
		return
	_logger = DebugLogger.new("runtime")
	OS.add_logger(_logger)
	_logger_registered = true
	if not EngineDebugger.has_capture(MESSAGE_PREFIX):
		EngineDebugger.register_message_capture(MESSAGE_PREFIX, Callable(self, "_capture_message"))
		_capture_registered = true


func _enter_tree() -> void:
	set_process(true)
	call_deferred("_announce")


func _exit_tree() -> void:
	set_process(false)
	if _capture_registered and EngineDebugger.has_capture(MESSAGE_PREFIX):
		EngineDebugger.unregister_message_capture(MESSAGE_PREFIX)
	_capture_registered = false
	if _logger_registered:
		OS.remove_logger(_logger)
		_logger_registered = false


func _process(_delta: float) -> void:
	if not EngineDebugger.is_active():
		return
	var drained: Dictionary = _logger.drain(MAX_EVENT_BATCH)
	var events: Array = drained.events
	if not events.is_empty() or int(drained.dropped) > 0:
		var timestamp := Time.get_ticks_msec()
		for event in events:
			event["timestampMs"] = timestamp
		EngineDebugger.send_message("%s:events" % MESSAGE_PREFIX, [events, int(drained.dropped)])
	var now := Time.get_ticks_msec()
	if now - _last_sample_at >= SAMPLE_INTERVAL_MS:
		_last_sample_at = now
		EngineDebugger.send_message("%s:sample" % MESSAGE_PREFIX, [_performance_sample(now)])


func _announce() -> void:
	if not EngineDebugger.is_active():
		return
	var scene := get_tree().current_scene
	EngineDebugger.send_message("%s:hello" % MESSAGE_PREFIX, [{
		"scenePath": scene.scene_file_path if scene != null else "",
		"rootName": str(scene.name) if scene != null else "",
		"rootType": scene.get_class() if scene != null else "",
		"nodeCount": get_tree().get_node_count(),
		"pid": OS.get_process_id(),
	}])


func _capture_message(message: String, data: Array) -> bool:
	if message != "screenshot":
		return false
	var request_id := str(data[0]) if data.size() > 0 else ""
	if request_id.is_empty():
		return true
	if _capture_in_progress:
		_send_capture_error(request_id, "A runtime screenshot is already being captured.")
		return true
	var width := clampi(int(data[1]) if data.size() > 1 else MAX_CAPTURE_WIDTH, 64, MAX_CAPTURE_WIDTH)
	var height := clampi(int(data[2]) if data.size() > 2 else MAX_CAPTURE_HEIGHT, 64, MAX_CAPTURE_HEIGHT)
	_capture_in_progress = true
	_capture_frame.call_deferred(request_id, width, height)
	return true


func _capture_frame(request_id: String, width: int, height: int) -> void:
	if DisplayServer.get_name() == "headless":
		_capture_in_progress = false
		_send_capture_error(request_id, "Runtime screenshots require a display server.")
		return
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	if image == null or image.is_empty():
		_capture_in_progress = false
		_send_capture_error(request_id, "The running game viewport has no image.")
		return
	var scale := minf(1.0, minf(float(width) / image.get_width(), float(height) / image.get_height()))
	if scale < 1.0:
		image.resize(
			maxi(1, int(round(image.get_width() * scale))),
			maxi(1, int(round(image.get_height() * scale))),
			Image.INTERPOLATE_LANCZOS
		)
	var png := image.save_png_to_buffer()
	if png.is_empty() or png.size() > MAX_CAPTURE_BYTES:
		_capture_in_progress = false
		_send_capture_error(request_id, "The runtime screenshot exceeded the safe debugger message limit.")
		return
	_capture_in_progress = false
	if EngineDebugger.is_active():
		EngineDebugger.send_message("%s:screenshot" % MESSAGE_PREFIX, [{
			"id": request_id,
			"mimeType": "image/png",
			"pngBase64": Marshalls.raw_to_base64(png),
			"width": image.get_width(),
			"height": image.get_height(),
			"bytes": png.size(),
			"capturedAtMs": Time.get_ticks_msec(),
		}])


func _send_capture_error(request_id: String, message: String) -> void:
	if EngineDebugger.is_active():
		EngineDebugger.send_message("%s:screenshot_error" % MESSAGE_PREFIX, [request_id, message])


func _performance_sample(timestamp: int) -> Dictionary:
	return {
		"timestampMs": timestamp,
		"fps": _monitor(Performance.TIME_FPS),
		"processMs": _monitor(Performance.TIME_PROCESS, 1000.0),
		"physicsMs": _monitor(Performance.TIME_PHYSICS_PROCESS, 1000.0),
		"memoryBytes": _monitor(Performance.MEMORY_STATIC),
		"objectCount": _monitor(Performance.OBJECT_COUNT),
		"nodeCount": _monitor(Performance.OBJECT_NODE_COUNT),
		"orphanNodeCount": _monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"drawCalls": _monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
	}


func _monitor(monitor: Performance.Monitor, scale: float = 1.0) -> Variant:
	var value := Performance.get_monitor(monitor) * scale
	return value if is_finite(value) else null
