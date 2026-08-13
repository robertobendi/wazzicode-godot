@tool
extends Node

const BridgeRouter = preload("bridge_router.gd")
const HOST := "127.0.0.1"
const DEFAULT_PORT := 38588
const PORT_ATTEMPTS := 32
const PROTOCOL_VERSION := "1.0"
const MAX_REQUEST_BYTES := 4 * 1024 * 1024
const CLIENT_TIMEOUT_MS := 20_000
const TOKEN_BYTES := 24
const UNIX_PLATFORMS := ["iOS", "Linux", "FreeBSD", "NetBSD", "OpenBSD", "BSD", "macOS"]

var _editor: EditorInterface
var _router: RefCounted
var _server := TCPServer.new()
var _clients: Array[Dictionary] = []
var _started_ticks := 0
var _port := 0
var _discovery_path := ""
var _token := ""


func _init(editor: EditorInterface) -> void:
	_editor = editor
	_router = BridgeRouter.new(editor, Callable(self, "uptime_ms"))


func start() -> void:
	if _server.is_listening():
		return
	var preferred := DEFAULT_PORT
	var configured := OS.get_environment("GODOT_VIBE_OS_PORT")
	if configured.is_valid_int():
		var parsed := configured.to_int()
		if parsed > 0 and parsed < 65536:
			preferred = parsed
	for candidate in range(preferred, min(preferred + PORT_ATTEMPTS, 65536)):
		if _server.listen(candidate, HOST) == OK:
			_port = _server.get_local_port()
			break
	if _port == 0:
		push_error("[GodotVibeOS] Could not bind a localhost bridge port.")
		return
	var token_bytes := Crypto.new().generate_random_bytes(TOKEN_BYTES)
	if token_bytes.size() != TOKEN_BYTES:
		_server.stop()
		_port = 0
		push_error("[GodotVibeOS] Could not generate a secure bridge token.")
		return
	_token = Marshalls.raw_to_base64(token_bytes)
	_started_ticks = Time.get_ticks_msec()
	set_process(true)
	if not _write_discovery():
		set_process(false)
		_server.stop()
		_port = 0
		_token = ""
		return
	print("[GodotVibeOS] Bridge listening on http://%s:%d" % [HOST, _port])


func stop() -> void:
	set_process(false)
	for client in _clients:
		var peer: StreamPeerTCP = client["peer"]
		peer.disconnect_from_host()
	_clients.clear()
	if _server.is_listening():
		_server.stop()
	_port = 0
	_delete_discovery()
	_token = ""


func uptime_ms() -> int:
	if _started_ticks == 0:
		return 0
	return Time.get_ticks_msec() - _started_ticks


func _process(_delta: float) -> void:
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer != null:
			peer.set_no_delay(true)
			_clients.append({
				"peer": peer,
				"buffer": PackedByteArray(),
				"accepted_at": Time.get_ticks_msec(),
			})
	for index in range(_clients.size() - 1, -1, -1):
		if _service_client(_clients[index]):
			_clients.remove_at(index)


func _service_client(client: Dictionary) -> bool:
	var peer: StreamPeerTCP = client["peer"]
	peer.poll()
	var status := peer.get_status()
	if status == StreamPeerSocket.STATUS_ERROR or status == StreamPeerSocket.STATUS_NONE:
		return true
	var available := peer.get_available_bytes()
	if available > 0:
		var read_result := peer.get_data(available)
		if read_result[0] != OK:
			return true
		var buffer: PackedByteArray = client["buffer"]
		buffer.append_array(read_result[1])
		client["buffer"] = buffer
		if buffer.size() > MAX_REQUEST_BYTES:
			_send_json(peer, 413, {"error": "request_too_large"})
			return true
		var request := _parse_http_request(buffer)
		if request.get("complete", false):
			_handle_http(peer, request)
			return true
	if Time.get_ticks_msec() - int(client["accepted_at"]) > CLIENT_TIMEOUT_MS:
		_send_json(peer, 408, {"error": "request_timeout"})
		return true
	return false


func _parse_http_request(buffer: PackedByteArray) -> Dictionary:
	var header_end := _find_header_end(buffer)
	if header_end < 0:
		return {"complete": false}
	var header_text := buffer.slice(0, header_end).get_string_from_utf8()
	var lines := header_text.split("\r\n")
	if lines.is_empty():
		return {"complete": true, "malformed": true}
	var request_line := lines[0].split(" ")
	if request_line.size() < 2:
		return {"complete": true, "malformed": true}
	var content_length := 0
	var headers := {}
	for line_index in range(1, lines.size()):
		var separator := lines[line_index].find(":")
		if separator < 0:
			continue
		var header_name := lines[line_index].substr(0, separator).strip_edges().to_lower()
		var header_value := lines[line_index].substr(separator + 1).strip_edges()
		headers[header_name] = header_value
		if header_name == "content-length":
			var raw_length := header_value
			if not raw_length.is_valid_int():
				return {"complete": true, "malformed": true}
			content_length = raw_length.to_int()
	var body_start := header_end + 4
	if content_length < 0 or body_start + content_length > MAX_REQUEST_BYTES:
		return {"complete": true, "malformed": true}
	if buffer.size() < body_start + content_length:
		return {"complete": false}
	return {
		"complete": true,
		"method": request_line[0],
		"path": request_line[1],
		"headers": headers,
		"body": buffer.slice(body_start, body_start + content_length).get_string_from_utf8(),
	}


func _find_header_end(buffer: PackedByteArray) -> int:
	for index in range(max(0, buffer.size() - MAX_REQUEST_BYTES), buffer.size() - 3):
		if buffer[index] == 13 and buffer[index + 1] == 10 and buffer[index + 2] == 13 and buffer[index + 3] == 10:
			return index
	return -1


func _handle_http(peer: StreamPeerTCP, request: Dictionary) -> void:
	if request.get("malformed", false):
		_send_json(peer, 400, {"error": "malformed_http_request"})
		return
	var method: String = request["method"]
	var path: String = request["path"]
	var headers: Dictionary = request["headers"]
	if _token.is_empty() or headers.get("x-godot-vibe-token", "") != _token:
		_send_json(peer, 401, {"error": "unauthorized"})
		return
	if method == "GET" and path == "/health":
		_send_json(peer, 200, _router.health())
		return
	if method != "POST" or path != "/rpc":
		_send_json(peer, 404, {"error": "not_found"})
		return
	var parsed = JSON.parse_string(request["body"])
	if typeof(parsed) != TYPE_DICTIONARY:
		_send_json(peer, 400, _error_envelope("", "INVALID_REQUEST", "Request body must be a JSON object.", 0))
		return
	var request_id = parsed.get("id", "")
	if typeof(request_id) != TYPE_STRING:
		request_id = ""
	var rpc_method = parsed.get("method", "")
	if typeof(rpc_method) != TYPE_STRING or rpc_method.is_empty():
		_send_json(peer, 400, _error_envelope(request_id, "INVALID_REQUEST", "A method string is required.", 0))
		return
	var version = parsed.get("version", "")
	if version != PROTOCOL_VERSION:
		_send_json(peer, 400, _error_envelope(request_id, "PROTOCOL_VERSION_MISMATCH", "Bridge protocol version '%s' is required." % PROTOCOL_VERSION, 0))
		return
	var params = parsed.get("params", {})
	if typeof(params) != TYPE_DICTIONARY:
		_send_json(peer, 400, _error_envelope(request_id, "INVALID_REQUEST", "params must be an object.", 0))
		return
	var started := Time.get_ticks_msec()
	var dispatched: Dictionary = _router.dispatch(rpc_method, params)
	var duration := Time.get_ticks_msec() - started
	if dispatched.get("ok", false):
		_send_json(peer, 200, {
			"id": request_id,
			"ok": true,
			"result": dispatched.get("result"),
			"error": null,
			"meta": _response_meta(duration),
		})
	else:
		var error: Dictionary = dispatched.get("error", {})
		var status_code := 404 if error.get("code") == "METHOD_NOT_FOUND" else 400
		_send_json(peer, status_code, {
			"id": request_id,
			"ok": false,
			"result": null,
			"error": error,
			"meta": _response_meta(duration),
		})


func _error_envelope(request_id: String, code: String, message: String, duration: int) -> Dictionary:
	return {
		"id": request_id,
		"ok": false,
		"result": null,
		"error": {"code": code, "message": message},
		"meta": _response_meta(duration),
	}


func _response_meta(duration: int) -> Dictionary:
	return {
		"godotVersion": Engine.get_version_info().get("string", ""),
		"projectPath": ProjectSettings.globalize_path("res://").trim_suffix("/"),
		"durationMs": duration,
	}


func _send_json(peer: StreamPeerTCP, status: int, payload: Dictionary) -> void:
	var body := JSON.stringify(payload).to_utf8_buffer()
	var reason := "OK"
	match status:
		400: reason = "Bad Request"
		401: reason = "Unauthorized"
		404: reason = "Not Found"
		408: reason = "Request Timeout"
		413: reason = "Content Too Large"
	var header := ("HTTP/1.1 %d %s\r\n" % [status, reason]
		+ "Content-Type: application/json; charset=utf-8\r\n"
		+ "Content-Length: %d\r\n" % body.size()
		+ "Connection: close\r\n\r\n").to_utf8_buffer()
	header.append_array(body)
	peer.put_data(header)
	peer.disconnect_from_host()


func _write_discovery() -> bool:
	var directory := ProjectSettings.globalize_path("res://.godot/godot-vibe-os")
	var discovery_path := directory.path_join("bridge.json")
	if _path_has_link(discovery_path):
		push_error("[GodotVibeOS] Bridge discovery path cannot contain symbolic links or reparse points.")
		return false
	if DirAccess.make_dir_recursive_absolute(directory) != OK:
		push_error("[GodotVibeOS] Could not create the discovery directory.")
		return false
	if _path_has_link(discovery_path):
		push_error("[GodotVibeOS] Bridge discovery path cannot contain symbolic links or reparse points.")
		return false
	var temp_path := directory.path_join(".bridge-%d-%s.tmp" % [OS.get_process_id(), _token.sha256_text().substr(0, 16)])
	if FileAccess.file_exists(temp_path) or DirAccess.dir_exists_absolute(temp_path) or _path_has_link(temp_path):
		push_error("[GodotVibeOS] Refusing an unsafe bridge discovery temporary path.")
		return false
	var file := FileAccess.open(temp_path, FileAccess.WRITE)
	if file == null:
		push_error("[GodotVibeOS] Could not write bridge discovery.")
		return false
	file.close()
	if OS.get_name() in UNIX_PLATFORMS:
		var permission_error := FileAccess.set_unix_permissions(
			temp_path,
			FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
		)
		if permission_error != OK:
			DirAccess.remove_absolute(temp_path)
			push_error("[GodotVibeOS] Could not restrict bridge discovery permissions: %s" % error_string(permission_error))
			return false
	file = FileAccess.open(temp_path, FileAccess.WRITE)
	if file == null:
		DirAccess.remove_absolute(temp_path)
		push_error("[GodotVibeOS] Could not reopen bridge discovery for writing.")
		return false
	file.store_string(JSON.stringify({
		"port": _port,
		"host": HOST,
		"projectPath": ProjectSettings.globalize_path("res://").trim_suffix("/"),
		"godotVersion": Engine.get_version_info().get("string", ""),
		"pid": OS.get_process_id(),
		"protocolVersion": PROTOCOL_VERSION,
		"startedAt": int(Time.get_unix_time_from_system() * 1000.0),
		"token": _token,
	}))
	var write_error := file.get_error()
	file.close()
	if write_error != OK:
		DirAccess.remove_absolute(temp_path)
		push_error("[GodotVibeOS] Could not finish bridge discovery: %s" % error_string(write_error))
		return false
	if _path_has_link(discovery_path):
		DirAccess.remove_absolute(temp_path)
		push_error("[GodotVibeOS] Bridge discovery path became unsafe before publication.")
		return false
	var rename_error := DirAccess.rename_absolute(temp_path, discovery_path)
	if rename_error != OK:
		DirAccess.remove_absolute(temp_path)
		push_error("[GodotVibeOS] Could not publish bridge discovery: %s" % error_string(rename_error))
		return false
	_discovery_path = discovery_path
	return true


func _delete_discovery() -> void:
	if not _discovery_path.is_empty() and FileAccess.file_exists(_discovery_path):
		if _path_has_link(_discovery_path):
			push_warning("[GodotVibeOS] Refusing to remove an unsafe bridge discovery path.")
		else:
			var file := FileAccess.open(_discovery_path, FileAccess.READ)
			var parsed = JSON.parse_string(file.get_as_text()) if file != null else null
			if file != null:
				file.close()
			if (
				typeof(parsed) == TYPE_DICTIONARY
				and parsed.get("pid", 0) == OS.get_process_id()
				and not _token.is_empty()
				and parsed.get("token", "") == _token
			):
				var error := DirAccess.remove_absolute(_discovery_path)
				if error != OK:
					push_warning("[GodotVibeOS] Could not remove bridge discovery: %s" % error_string(error))
	_discovery_path = ""


func _path_has_link(absolute: String) -> bool:
	var project_path := ProjectSettings.globalize_path("res://").trim_suffix("/").replace("\\", "/")
	var normalized := absolute.replace("\\", "/")
	if not normalized.begins_with(project_path + "/"):
		return true
	var current := project_path
	for component in normalized.trim_prefix(project_path + "/").split("/", false):
		var directory := DirAccess.open(current)
		if directory == null:
			return DirAccess.dir_exists_absolute(current)
		if directory.is_link(component):
			return true
		current = current.path_join(component)
	return false
