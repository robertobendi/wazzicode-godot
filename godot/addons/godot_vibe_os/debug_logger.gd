extends Logger

const MAX_PENDING := 1000
const MAX_MESSAGE_CHARS := 8000

var _source := ""
var _mutex := Mutex.new()
var _pending: Array[Dictionary] = []
var _dropped := 0


func _init(source: String) -> void:
	_source = source


func _log_message(message: String, error: bool) -> void:
	_enqueue({
		"source": _source,
		"severity": "error" if error else "info",
		"kind": "message",
		"message": message.left(MAX_MESSAGE_CHARS),
		"file": "",
		"line": 0,
		"function": "",
	})


func _log_error(
	function: String,
	file: String,
	line: int,
	code: String,
	rationale: String,
	_editor_notify: bool,
	error_type: int,
	_script_backtraces: Array[ScriptBacktrace]
) -> void:
	var severity := "warning" if error_type == ERROR_TYPE_WARNING else "error"
	var kind := "engine"
	if error_type == ERROR_TYPE_SCRIPT:
		kind = "script"
	elif error_type == ERROR_TYPE_SHADER:
		kind = "shader"
	var message := rationale if not rationale.is_empty() else code
	_enqueue({
		"source": _source,
		"severity": severity,
		"kind": kind,
		"message": message.left(MAX_MESSAGE_CHARS),
		"file": file.left(2000),
		"line": maxi(0, line),
		"function": function.left(1000),
	})


func drain(max_items: int = 256) -> Dictionary:
	_mutex.lock()
	var take := mini(maxi(max_items, 0), _pending.size())
	var events: Array[Dictionary] = []
	if take > 0:
		events.assign(_pending.slice(0, take))
		_pending = _pending.slice(take)
	var dropped := _dropped
	_dropped = 0
	_mutex.unlock()
	return {"events": events, "dropped": dropped}


func _enqueue(event: Dictionary) -> void:
	_mutex.lock()
	if _pending.size() >= MAX_PENDING:
		_pending.pop_front()
		_dropped += 1
	_pending.append(event)
	_mutex.unlock()
