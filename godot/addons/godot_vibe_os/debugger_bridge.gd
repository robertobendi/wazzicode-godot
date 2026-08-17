@tool
extends EditorDebuggerPlugin

const DebugLogger = preload("debug_logger.gd")
const MESSAGE_PREFIX := "godot_vibe_os"
const MAX_EVENTS := 500
const MAX_SAMPLES := 240
const MAX_DRAINED_EDITOR_EVENTS := 512
const CAPTURE_WIDTH := 1280
const CAPTURE_HEIGHT := 720
const MAX_SEQUENCE_FRAMES := 16
const MIN_SEQUENCE_FRAMES := 2
const MIN_SEQUENCE_INTERVAL_MS := 100
const MAX_SEQUENCE_INTERVAL_MS := 2000
const MIN_SEQUENCE_WIDTH := 160
const MAX_SEQUENCE_PAGE := 4

var _editor_logger: Logger = DebugLogger.new("editor")
var _logger_registered := false
var _session_id := -1
var _run_id := ""
var _started_at := 0
var _stopped_at = null
var _runtime_connected := false
var _breaked := false
var _runtime: Dictionary = {}
var _events: Array[Dictionary] = []
var _samples: Array[Dictionary] = []
var _event_cursor := 0
var _sample_cursor := 0
var _dropped_events := 0
var _dropped_samples := 0
var _screenshot_id := ""
var _screenshot = null
var _capture_pending := false
var _capture_error = null
var _frames_id := ""
var _frames_state := "complete"
var _frames: Array[Dictionary] = []
var _frames_requested := {"frames": 8, "intervalMs": 400, "width": 480, "format": "jpg", "quality": 70}
var _frames_dropped := 0
var _frames_error = null


func start() -> void:
	if _logger_registered:
		return
	OS.add_logger(_editor_logger)
	_logger_registered = true


func stop() -> void:
	if _logger_registered:
		OS.remove_logger(_editor_logger)
		_logger_registered = false


func _has_capture(capture: String) -> bool:
	return capture == MESSAGE_PREFIX


func _setup_session(session_id: int) -> void:
	var session := get_session(session_id)
	session.started.connect(Callable(self, "_session_started").bind(session_id))
	session.stopped.connect(Callable(self, "_session_stopped").bind(session_id))
	session.breaked.connect(Callable(self, "_session_breaked").bind(session_id))
	session.continued.connect(Callable(self, "_session_continued").bind(session_id))


func _capture(message: String, data: Array, session_id: int) -> bool:
	if not message.begins_with(MESSAGE_PREFIX + ":"):
		return false
	if _session_id != session_id:
		_begin_session(session_id)
	match message:
		"godot_vibe_os:hello":
			var payload := _dictionary_at(data, 0)
			_runtime_connected = true
			_runtime = {
				"scenePath": str(payload.get("scenePath", "")),
				"rootName": str(payload.get("rootName", "")),
				"rootType": str(payload.get("rootType", "")),
				"nodeCount": maxi(0, int(payload.get("nodeCount", 0))),
				"pid": maxi(0, int(payload.get("pid", 0))),
			}
		"godot_vibe_os:events":
			var received: Array = data[0] if data.size() > 0 and typeof(data[0]) == TYPE_ARRAY else []
			for event in received:
				if typeof(event) == TYPE_DICTIONARY:
					_append_event(event)
			if data.size() > 1:
				_dropped_events += maxi(0, int(data[1]))
		"godot_vibe_os:sample":
			var sample := _dictionary_at(data, 0)
			if not sample.is_empty():
				_append_sample(sample)
		"godot_vibe_os:screenshot":
			_accept_screenshot(_dictionary_at(data, 0))
		"godot_vibe_os:screenshot_error":
			var request_id := str(data[0]) if data.size() > 0 else ""
			if request_id == _screenshot_id:
				_capture_pending = false
				_capture_error = str(data[1]) if data.size() > 1 else "Runtime screenshot failed."
		"godot_vibe_os:frame":
			_accept_frame(_dictionary_at(data, 0))
		"godot_vibe_os:frames_done":
			var done_id := str(data[0]) if data.size() > 0 else ""
			if done_id == _frames_id and _frames_state == "pending":
				var summary := _dictionary_at(data, 1)
				_frames_dropped += maxi(0, int(summary.get("dropped", 0)))
				_frames_state = "complete"
		"godot_vibe_os:frames_error":
			var frames_error_id := str(data[0]) if data.size() > 0 else ""
			if frames_error_id == _frames_id:
				_frames_state = "error"
				_frames_error = _json_safe_text(str(data[1]) if data.size() > 1 else "Runtime frame capture failed.", 500)
		_:
			return false
	return true


func snapshot(params: Dictionary) -> Dictionary:
	_drain_editor_logs()
	if bool(params.get("requestScreenshot", false)):
		_request_screenshot()
	var since_event := maxi(0, int(params.get("sinceEventCursor", 0)))
	var since_sample := maxi(0, int(params.get("sinceSampleCursor", 0)))
	var max_events := clampi(int(params.get("maxEvents", 100)), 1, 200)
	var max_samples := clampi(int(params.get("maxSamples", 120)), 1, 120)
	var first_event := int(_events[0].cursor) if not _events.is_empty() else _event_cursor + 1
	var first_sample := int(_samples[0].cursor) if not _samples.is_empty() else _sample_cursor + 1
	var selected_events: Array[Dictionary] = []
	for event in _events:
		if int(event.cursor) > since_event:
			selected_events.append(event)
			if selected_events.size() >= max_events:
				break
	var selected_samples: Array[Dictionary] = []
	for sample in _samples:
		if int(sample.cursor) > since_sample:
			selected_samples.append(sample)
			if selected_samples.size() >= max_samples:
				break
	var session := get_session(_session_id) if _session_id >= 0 else null
	if session != null and session.is_active():
		_breaked = session.is_breaked()
	return {
		"runId": _run_id,
		"sessionId": _session_id if _session_id >= 0 else null,
		"runtimeConnected": _runtime_connected,
		"breaked": _breaked,
		"startedAtMs": _started_at,
		"stoppedAtMs": _stopped_at,
		"eventCursor": _event_cursor,
		"sampleCursor": _sample_cursor,
		"firstEventCursor": first_event,
		"firstSampleCursor": first_sample,
		"missedEvents": maxi(0, first_event - since_event - 1),
		"missedSamples": maxi(0, first_sample - since_sample - 1),
		"events": selected_events,
		"samples": selected_samples,
		"droppedEvents": _dropped_events,
		"droppedSamples": _dropped_samples,
		"runtime": _runtime if not _runtime.is_empty() else null,
		"screenshotId": _screenshot_id,
		"screenshot": _screenshot if bool(params.get("includeScreenshot", false)) else null,
		"capturePending": _capture_pending,
		"captureError": _capture_error,
	}


func capture_frames(params: Dictionary) -> Dictionary:
	var capture_id := str(params.get("captureId", ""))
	if capture_id.is_empty():
		return _begin_frame_capture(params)
	if capture_id != _frames_id or _frames_id.is_empty():
		return _frame_capture_page(params, capture_id, "error", "That frame capture sequence is no longer active.")
	return _frame_capture_page(params, _frames_id, _frames_state, _frames_error)


func _begin_frame_capture(params: Dictionary) -> Dictionary:
	_frames_requested = {
		"frames": clampi(int(params.get("frames", 8)), MIN_SEQUENCE_FRAMES, MAX_SEQUENCE_FRAMES),
		"intervalMs": clampi(int(params.get("intervalMs", 400)), MIN_SEQUENCE_INTERVAL_MS, MAX_SEQUENCE_INTERVAL_MS),
		"width": clampi(int(params.get("width", 480)), MIN_SEQUENCE_WIDTH, CAPTURE_WIDTH),
		"format": "png" if str(params.get("format", "jpg")) == "png" else "jpg",
		"quality": clampi(int(params.get("quality", 70)), 1, 100),
	}
	_frames = []
	_frames_dropped = 0
	_frames_error = null
	var session := get_session(_session_id) if _session_id >= 0 else null
	if not _runtime_connected or session == null or not session.is_active():
		_frames_id = ""
		_frames_state = "not_running"
		return _frame_capture_page({}, "", "not_running", "The runtime probe is not connected.")
	_frames_id = "%s-frames-%d" % [_run_id if not _run_id.is_empty() else "no-run", Time.get_ticks_usec()]
	_frames_state = "pending"
	session.send_message("%s:capture_frames" % MESSAGE_PREFIX, [
		_frames_id,
		int(_frames_requested.frames),
		int(_frames_requested.intervalMs),
		int(_frames_requested.width),
		str(_frames_requested.format),
		int(_frames_requested.quality),
	])
	return _frame_capture_page(params, _frames_id, _frames_state, _frames_error)


func _frame_capture_page(params: Dictionary, capture_id: String, state: String, error) -> Dictionary:
	var since := maxi(0, int(params.get("sinceIndex", 0)))
	var max_frames := clampi(int(params.get("maxFrames", MAX_SEQUENCE_PAGE)), 1, MAX_SEQUENCE_PAGE)
	var selected: Array[Dictionary] = []
	var cursor := 0
	if capture_id == _frames_id and not _frames_id.is_empty():
		for frame in _frames:
			cursor = maxi(cursor, int(frame.index))
			if int(frame.index) > since and selected.size() < max_frames:
				selected.append(frame)
	return {
		"captureId": capture_id,
		"state": state,
		"runId": _run_id,
		"requested": _frames_requested.duplicate(),
		"capturedCount": _frames.size() if capture_id == _frames_id and not _frames_id.is_empty() else 0,
		"frameCursor": cursor,
		"frames": selected,
		"droppedFrames": _frames_dropped,
		"error": error,
	}


func _accept_frame(payload: Dictionary) -> void:
	if _frames_id.is_empty() or str(payload.get("id", "")) != _frames_id or _frames_state != "pending":
		return
	if _frames.size() >= MAX_SEQUENCE_FRAMES:
		_frames_dropped += 1
		return
	var index := int(payload.get("index", 0))
	var base64 := str(payload.get("base64", ""))
	var width := int(payload.get("width", 0))
	var height := int(payload.get("height", 0))
	var bytes := int(payload.get("bytes", 0))
	var frame_hash := str(payload.get("hash", ""))
	var mime := str(payload.get("mimeType", ""))
	if (
		index <= 0
		or base64.is_empty()
		or width <= 0
		or height <= 0
		or bytes <= 0
		or frame_hash.length() != 16
		or not frame_hash.is_valid_hex_number()
		or (mime != "image/jpeg" and mime != "image/png")
	):
		_frames_dropped += 1
		return
	_frames.append({
		"index": index,
		"tMs": maxi(0, int(payload.get("tMs", 0))),
		"deltaMs": maxi(0, int(payload.get("deltaMs", 0))),
		"frameTimeMs": maxf(0.0, _finite_or_zero(payload.get("frameTimeMs"))),
		"captureCostMs": maxf(0.0, _finite_or_zero(payload.get("captureCostMs"))),
		"mimeType": mime,
		"base64": base64,
		"width": width,
		"height": height,
		"bytes": bytes,
		"hash": frame_hash.to_lower(),
	})


func is_run_active(run_id: String) -> bool:
	if run_id.is_empty() or run_id != _run_id or _stopped_at != null:
		return false
	var session := get_session(_session_id) if _session_id >= 0 else null
	return session != null and session.is_active()


func _session_started(session_id: int) -> void:
	_begin_session(session_id)


func _session_stopped(session_id: int) -> void:
	if session_id != _session_id:
		return
	_drain_editor_logs()
	_stopped_at = Time.get_ticks_msec()
	_runtime_connected = false
	_breaked = false
	if _capture_pending:
		_capture_pending = false
		_capture_error = "The game stopped before the runtime screenshot completed."
	if _frames_state == "pending":
		_frames_state = "error"
		_frames_error = "The game stopped before the frame sequence completed."


func _session_breaked(_can_debug: bool, session_id: int) -> void:
	if session_id == _session_id:
		_breaked = true


func _session_continued(session_id: int) -> void:
	if session_id == _session_id:
		_breaked = false


func _begin_session(session_id: int) -> void:
	_drain_editor_logs()
	_session_id = session_id
	_started_at = Time.get_ticks_msec()
	_stopped_at = null
	_run_id = "%d-%d-%d" % [OS.get_process_id(), session_id, Time.get_ticks_usec()]
	_runtime_connected = false
	_breaked = false
	_runtime = {}
	_screenshot_id = ""
	_screenshot = null
	_capture_pending = false
	_capture_error = null
	_frames_id = ""
	_frames_state = "complete"
	_frames = []
	_frames_dropped = 0
	_frames_error = null


func _request_screenshot() -> void:
	if _capture_pending:
		return
	_screenshot_id = "%s-%d" % [_run_id if not _run_id.is_empty() else "no-run", Time.get_ticks_usec()]
	_screenshot = null
	_capture_error = null
	var session := get_session(_session_id) if _session_id >= 0 else null
	if not _runtime_connected or session == null or not session.is_active():
		_capture_pending = false
		_capture_error = "The runtime probe is not connected."
		return
	_capture_pending = true
	session.send_message("%s:screenshot" % MESSAGE_PREFIX, [_screenshot_id, CAPTURE_WIDTH, CAPTURE_HEIGHT])


func _accept_screenshot(payload: Dictionary) -> void:
	if str(payload.get("id", "")) != _screenshot_id:
		return
	var png_base64 := str(payload.get("pngBase64", ""))
	var width := int(payload.get("width", 0))
	var height := int(payload.get("height", 0))
	var bytes := int(payload.get("bytes", 0))
	if png_base64.is_empty() or width <= 0 or height <= 0 or bytes <= 0:
		_capture_pending = false
		_capture_error = "The runtime returned an invalid screenshot."
		return
	_screenshot = {
		"id": _screenshot_id,
		"mimeType": "image/png",
		"pngBase64": png_base64,
		"width": width,
		"height": height,
		"bytes": bytes,
		"capturedAtMs": maxi(0, int(payload.get("capturedAtMs", 0))),
	}
	_capture_pending = false
	_capture_error = null


func _drain_editor_logs() -> void:
	if not _logger_registered:
		return
	var drained: Dictionary = _editor_logger.drain(MAX_DRAINED_EDITOR_EVENTS)
	for event in drained.events:
		if typeof(event) == TYPE_DICTIONARY:
			event["timestampMs"] = Time.get_ticks_msec()
			_append_event(event)
	_dropped_events += maxi(0, int(drained.dropped))


func _append_event(raw: Dictionary) -> void:
	var severity := str(raw.get("severity", "info"))
	if severity not in ["info", "warning", "error"]:
		severity = "info"
	_event_cursor += 1
	_events.append({
		"cursor": _event_cursor,
		"source": "runtime" if str(raw.get("source", "")) == "runtime" else "editor",
		"severity": severity,
		"kind": _json_safe_text(str(raw.get("kind", "message")), 100),
		"message": _json_safe_text(str(raw.get("message", "")), 8000),
		"file": _json_safe_text(str(raw.get("file", "")), 2000),
		"line": maxi(0, int(raw.get("line", 0))),
		"function": _json_safe_text(str(raw.get("function", "")), 1000),
		"timestampMs": maxi(0, int(raw.get("timestampMs", Time.get_ticks_msec()))),
	})
	if _events.size() > MAX_EVENTS:
		_events.pop_front()


func _append_sample(raw: Dictionary) -> void:
	_sample_cursor += 1
	var sample := {
		"cursor": _sample_cursor,
		"timestampMs": maxi(0, int(raw.get("timestampMs", Time.get_ticks_msec()))),
		"fps": _finite_or_null(raw.get("fps")),
		"processMs": _finite_or_null(raw.get("processMs")),
		"physicsMs": _finite_or_null(raw.get("physicsMs")),
		"memoryBytes": _finite_or_null(raw.get("memoryBytes")),
		"objectCount": _finite_or_null(raw.get("objectCount")),
		"nodeCount": _finite_or_null(raw.get("nodeCount")),
		"orphanNodeCount": _finite_or_null(raw.get("orphanNodeCount")),
		"drawCalls": _finite_or_null(raw.get("drawCalls")),
	}
	_samples.append(sample)
	if _samples.size() > MAX_SAMPLES:
		_samples.pop_front()
	if not _runtime.is_empty() and sample.nodeCount != null:
		_runtime["nodeCount"] = maxi(0, int(sample.nodeCount))


func _dictionary_at(data: Array, index: int) -> Dictionary:
	return data[index] if index < data.size() and typeof(data[index]) == TYPE_DICTIONARY else {}


func _finite_or_null(value: Variant) -> Variant:
	if typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT:
		return null
	var number := float(value)
	return number if is_finite(number) else null


func _finite_or_zero(value: Variant) -> float:
	if typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT:
		return 0.0
	var number := float(value)
	return number if is_finite(number) else 0.0


func _json_safe_text(value: String, max_chars: int) -> String:
	var sanitized := value
	for code in range(1, 32):
		if code == 9 or code == 10 or code == 13:
			continue
		sanitized = sanitized.replace(String.chr(code), "")
	sanitized = sanitized.replace(String.chr(127), "")
	return sanitized.left(max_chars)
