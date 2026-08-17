extends Node

const DebugLogger = preload("debug_logger.gd")
const MESSAGE_PREFIX := "godot_vibe_os"
const SAMPLE_INTERVAL_MS := 250
const MAX_EVENT_BATCH := 64
const MAX_CAPTURE_WIDTH := 1280
const MAX_CAPTURE_HEIGHT := 720
const MAX_CAPTURE_BYTES := 4 * 1024 * 1024
const MIN_SEQUENCE_FRAMES := 2
const MAX_SEQUENCE_FRAMES := 16
const MIN_SEQUENCE_INTERVAL_MS := 100
const MAX_SEQUENCE_INTERVAL_MS := 2000
const MIN_SEQUENCE_WIDTH := 160
const HASH_SIZE := 8

var _logger: Logger
var _logger_registered := false
var _capture_registered := false
var _capture_in_progress := false
var _sequence_in_progress := false
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
	match message:
		"screenshot":
			return _begin_screenshot(data)
		"capture_frames":
			return _begin_frame_sequence(data)
	return false


func _begin_screenshot(data: Array) -> bool:
	var request_id := str(data[0]) if data.size() > 0 else ""
	if request_id.is_empty():
		return true
	if _capture_in_progress or _sequence_in_progress:
		_send_capture_error(request_id, "A runtime screenshot is already being captured.")
		return true
	var width := clampi(int(data[1]) if data.size() > 1 else MAX_CAPTURE_WIDTH, 64, MAX_CAPTURE_WIDTH)
	var height := clampi(int(data[2]) if data.size() > 2 else MAX_CAPTURE_HEIGHT, 64, MAX_CAPTURE_HEIGHT)
	_capture_in_progress = true
	_capture_frame.call_deferred(request_id, width, height)
	return true


func _begin_frame_sequence(data: Array) -> bool:
	var request_id := str(data[0]) if data.size() > 0 else ""
	if request_id.is_empty():
		return true
	if _capture_in_progress or _sequence_in_progress:
		_send_frames_error(request_id, "A runtime capture is already in progress.")
		return true
	var frames := clampi(int(data[1]) if data.size() > 1 else 8, MIN_SEQUENCE_FRAMES, MAX_SEQUENCE_FRAMES)
	var interval_ms := clampi(int(data[2]) if data.size() > 2 else 400, MIN_SEQUENCE_INTERVAL_MS, MAX_SEQUENCE_INTERVAL_MS)
	var width := clampi(int(data[3]) if data.size() > 3 else 480, MIN_SEQUENCE_WIDTH, MAX_CAPTURE_WIDTH)
	var format := "png" if data.size() > 4 and str(data[4]) == "png" else "jpg"
	var quality := clampi(int(data[5]) if data.size() > 5 else 70, 1, 100)
	_sequence_in_progress = true
	_capture_frame_sequence.call_deferred(request_id, frames, interval_ms, width, format, quality)
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


## Captures a paced sequence of viewport frames. Each frame costs a forced GPU flush inside
## get_image(), so the measured cost travels with the frame instead of being hidden.
func _capture_frame_sequence(request_id: String, frames: int, interval_ms: int, width: int, format: String, quality: int) -> void:
	if DisplayServer.get_name() == "headless":
		_sequence_in_progress = false
		_send_frames_error(request_id, "Runtime frame capture requires a display server.")
		return
	var captured := 0
	var dropped := 0
	var sequence_started := 0
	var previous_captured_at := 0
	var previous_attempt_at := 0
	for _attempt in range(frames):
		if not EngineDebugger.is_active() or not is_inside_tree():
			_sequence_in_progress = false
			return
		if previous_attempt_at > 0:
			var wait_ms := interval_ms - (Time.get_ticks_msec() - previous_attempt_at)
			if wait_ms > 0:
				await get_tree().create_timer(float(wait_ms) / 1000.0, true, false, true).timeout
		await RenderingServer.frame_post_draw
		previous_attempt_at = Time.get_ticks_msec()
		var capture_started_usec := Time.get_ticks_usec()
		var image := get_viewport().get_texture().get_image()
		if image == null or image.is_empty():
			dropped += 1
			continue
		var scale := minf(1.0, float(width) / float(image.get_width()))
		if scale < 1.0:
			image.resize(
				maxi(1, int(round(image.get_width() * scale))),
				maxi(1, int(round(image.get_height() * scale))),
				Image.INTERPOLATE_BILINEAR
			)
		var encoded := image.save_png_to_buffer() if format == "png" else image.save_jpg_to_buffer(float(quality) / 100.0)
		var encoded_width := image.get_width()
		var encoded_height := image.get_height()
		var frame_hash := _average_hash(image)
		var capture_cost_ms := float(Time.get_ticks_usec() - capture_started_usec) / 1000.0
		if encoded.is_empty() or encoded.size() > MAX_CAPTURE_BYTES:
			dropped += 1
			continue
		var captured_at := Time.get_ticks_msec()
		if captured == 0:
			sequence_started = captured_at
		captured += 1
		EngineDebugger.send_message("%s:frame" % MESSAGE_PREFIX, [{
			"id": request_id,
			"index": captured,
			"tMs": maxi(0, captured_at - sequence_started),
			"deltaMs": 0 if previous_captured_at == 0 else maxi(0, captured_at - previous_captured_at),
			"frameTimeMs": _process_time_ms(),
			"captureCostMs": capture_cost_ms,
			"mimeType": "image/png" if format == "png" else "image/jpeg",
			"base64": Marshalls.raw_to_base64(encoded),
			"width": encoded_width,
			"height": encoded_height,
			"bytes": encoded.size(),
			"hash": frame_hash,
		}])
		previous_captured_at = captured_at
	_sequence_in_progress = false
	if EngineDebugger.is_active():
		EngineDebugger.send_message("%s:frames_done" % MESSAGE_PREFIX, [request_id, {
			"captured": captured,
			"dropped": dropped,
		}])


func _send_frames_error(request_id: String, message: String) -> void:
	if EngineDebugger.is_active():
		EngineDebugger.send_message("%s:frames_error" % MESSAGE_PREFIX, [request_id, message])


## 8x8 grayscale average hash as 16 hex characters. Destructive: the caller must already
## hold the encoded bytes for this image.
func _average_hash(image: Image) -> String:
	image.resize(HASH_SIZE, HASH_SIZE, Image.INTERPOLATE_BILINEAR)
	image.convert(Image.FORMAT_L8)
	var pixels := image.get_data()
	if pixels.size() < HASH_SIZE * HASH_SIZE:
		return "0000000000000000"
	var total := 0
	for offset in range(HASH_SIZE * HASH_SIZE):
		total += int(pixels[offset])
	var average := total / (HASH_SIZE * HASH_SIZE)
	var hex := ""
	var nibble := 0
	for offset in range(HASH_SIZE * HASH_SIZE):
		nibble = (nibble << 1) | (1 if int(pixels[offset]) > average else 0)
		if offset % 4 == 3:
			hex += "%x" % nibble
			nibble = 0
	return hex


func _process_time_ms() -> float:
	var value := Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
	return value if is_finite(value) and value > 0.0 else 0.0


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
