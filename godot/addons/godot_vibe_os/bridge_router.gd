@tool
extends RefCounted

const MAX_REFLECTION_ITEMS := 500
const MAX_PROPERTY_ITEMS := 200

var _editor: EditorInterface
var _uptime: Callable
var _debugger


func _init(editor: EditorInterface, uptime: Callable, debugger) -> void:
	_editor = editor
	_uptime = uptime
	_debugger = debugger


func health() -> Dictionary:
	var filesystem := _editor.get_resource_filesystem()
	return {
		"status": "ok",
		"godotVersion": Engine.get_version_info().get("string", ""),
		"projectPath": _project_path(),
		"uptimeMs": _uptime.call(),
		"isPlaying": _editor.is_playing_scene(),
		"filesystemScanning": filesystem.is_scanning(),
	}


func dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"system.health":
			return _ok(health())
		"system.summary":
			return _system_summary()
		"scene.getOpenScenes":
			return _get_open_scenes()
		"scene.getTree":
			return _get_scene_tree(params)
		"selection.inspect":
			return _inspect_selection(params)
		"filesystem.status":
			return _filesystem_status()
		"filesystem.scan":
			return _filesystem_scan()
		"resource.getDependencies":
			return _resource_dependencies(params)
		"reflect.query":
			return _reflect_query(params)
		"viewport.capture2D":
			return _capture_viewport(params, false)
		"viewport.capture3D":
			return _capture_viewport(params, true)
		"scene.open":
			return _open_scene(params)
		"scene.save":
			return _save_scene(params)
		"edit.setProperty":
			return _set_property(params)
		"edit.createNode":
			return _create_node(params)
		"edit.deleteNode":
			return _delete_node(params)
		"edit.reparentNode":
			return _reparent_node(params)
		"edit.instantiateScene":
			return _instantiate_scene(params)
		"play.run":
			return _play_run(params)
		"play.stop":
			return _play_stop(params)
		"play.status":
			return _play_status()
		"debug.snapshot":
			return _debug_snapshot(params)
		"debug.captureFrames":
			return _debug_capture_frames(params)
		_:
			return _fail("METHOD_NOT_FOUND", "Unknown bridge method '%s'." % method)


func _system_summary() -> Dictionary:
	var roots := _editor.get_open_scene_roots()
	var filesystem := _editor.get_resource_filesystem()
	return _ok({
		"engine": "godot",
		"godotVersion": Engine.get_version_info().get("string", ""),
		"projectName": ProjectSettings.get_setting("application/config/name", ""),
		"projectPath": _project_path(),
		"platform": OS.get_name(),
		"openSceneCount": roots.size(),
		"editedScene": _scene_path(_editor.get_edited_scene_root()),
		"isPlaying": _editor.is_playing_scene(),
		"filesystem": _filesystem_status_payload(filesystem),
	})


func _get_open_scenes() -> Dictionary:
	var paths := _editor.get_open_scenes()
	var roots := _editor.get_open_scene_roots()
	var edited := _editor.get_edited_scene_root()
	var unsaved := _editor.get_unsaved_scenes()
	var scenes: Array = []
	for index in range(max(paths.size(), roots.size())):
		var root: Node = roots[index] if index < roots.size() else null
		var path := paths[index] if index < paths.size() else _scene_path(root)
		scenes.append({
			"path": path,
			"name": str(root.name) if root != null else path.get_file().get_basename(),
			"rootType": root.get_class() if root != null else "",
			"active": root == edited,
			"unsaved": unsaved.has(path),
		})
	return _ok({
		"scenes": scenes,
		"count": scenes.size(),
		"activeScene": _scene_path(edited),
	})


func _get_scene_tree(params: Dictionary) -> Dictionary:
	var root_result := _require_scene_root()
	if not root_result.ok:
		return root_result
	var root: Node = root_result.value
	var start: Node = root
	var node_path := _string_param(params, "nodePath", "")
	if not node_path.is_empty():
		start = _resolve_node(root, node_path)
		if start == null:
			return _fail("NODE_NOT_FOUND", "No node exists at '%s'." % node_path)
	var max_depth := clampi(_int_param(params, "maxDepth", 32), 0, 128)
	var max_nodes := clampi(_int_param(params, "maxNodes", 5000), 1, 20_000)
	var include_properties := _bool_param(params, "includeProperties", false)
	var state := {"count": 0, "truncated": false}
	var tree := _node_tree(root, start, 0, max_depth, max_nodes, include_properties, state)
	return _ok({
		"scenePath": _scene_path(root),
		"root": tree,
		"nodeCount": state.count,
		"truncated": state.truncated,
	})


func _node_tree(scene_root: Node, node: Node, depth: int, max_depth: int, max_nodes: int, include_properties: bool, state: Dictionary) -> Dictionary:
	state.count += 1
	var item := _node_summary(scene_root, node)
	if include_properties:
		item["properties"] = _object_properties(node, MAX_PROPERTY_ITEMS)
	var children: Array = []
	if depth < max_depth:
		for child in node.get_children():
			if state.count >= max_nodes:
				state.truncated = true
				break
			children.append(_node_tree(scene_root, child, depth + 1, max_depth, max_nodes, include_properties, state))
	item["children"] = children
	return item


func _inspect_selection(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	var include_properties := _bool_param(params, "includeProperties", true)
	var max_properties := clampi(_int_param(params, "maxProperties", 100), 1, MAX_PROPERTY_ITEMS)
	var nodes: Array = []
	for node in _editor.get_selection().get_selected_nodes():
		var item := _node_summary(root, node)
		if include_properties:
			item["properties"] = _object_properties(node, max_properties)
		nodes.append(item)
	return _ok({"nodes": nodes, "count": nodes.size()})


func _filesystem_status() -> Dictionary:
	return _ok(_filesystem_status_payload(_editor.get_resource_filesystem()))


func _filesystem_scan() -> Dictionary:
	var filesystem := _editor.get_resource_filesystem()
	filesystem.scan()
	var result := _filesystem_status_payload(filesystem)
	result["requested"] = true
	return _ok(result)


func _filesystem_status_payload(filesystem: EditorFileSystem) -> Dictionary:
	var root := filesystem.get_filesystem()
	return {
		"scanning": filesystem.is_scanning(),
		"importing": filesystem.is_importing(),
		"progress": filesystem.get_scanning_progress(),
		"indexedFiles": _count_files(root) if root != null else 0,
	}


func _count_files(directory: EditorFileSystemDirectory) -> int:
	var count := directory.get_file_count()
	for index in range(directory.get_subdir_count()):
		count += _count_files(directory.get_subdir(index))
	return count


func _resource_dependencies(params: Dictionary) -> Dictionary:
	var path := _string_param(params, "path", "")
	if path.is_empty():
		return _fail("INVALID_ARGUMENT", "resource.getDependencies requires path.")
	if not _is_project_resource_path(path):
		return _fail("INVALID_ARGUMENT", "Resource paths must start with res://.")
	if not ResourceLoader.exists(path):
		return _fail("RESOURCE_NOT_FOUND", "Resource '%s' does not exist." % path)
	var dependencies: Array = []
	for dependency in ResourceLoader.get_dependencies(path):
		var raw := str(dependency)
		var parts := raw.split("::")
		dependencies.append({
			"path": parts[parts.size() - 1] if parts.size() > 0 else raw,
			"type": parts[parts.size() - 2] if parts.size() > 1 else "",
			"uid": parts[0] if parts.size() > 2 else "",
			"raw": raw,
		})
	return _ok({"path": path, "dependencies": dependencies, "count": dependencies.size()})


func _reflect_query(params: Dictionary) -> Dictionary:
	var class_type := _string_param(params, "className", "")
	var query := _string_param(params, "query", class_type).strip_edges()
	var limit := clampi(_int_param(params, "limit", 100), 1, MAX_REFLECTION_ITEMS)
	if not class_type.is_empty():
		if not ClassDB.class_exists(class_type):
			return _fail("CLASS_NOT_FOUND", "Godot class '%s' does not exist." % class_type)
		return _ok({
			"query": query,
			"classes": [_class_reflection(class_type, params, limit)],
			"count": 1,
		})
	if query.is_empty():
		return _fail("INVALID_ARGUMENT", "reflect.query requires className or query.")
	var matches: Array = []
	var needle := query.to_lower()
	for candidate in ClassDB.get_class_list():
		if str(candidate).to_lower().contains(needle):
			matches.append({
				"name": str(candidate),
				"parent": str(ClassDB.get_parent_class(candidate)),
				"instantiable": ClassDB.can_instantiate(candidate),
			})
			if matches.size() >= limit:
				break
	return _ok({"query": query, "classes": matches, "count": matches.size(), "truncated": matches.size() >= limit})


func _class_reflection(class_type: String, params: Dictionary, limit: int) -> Dictionary:
	var include_inherited := _bool_param(params, "includeInherited", true)
	var result := {
		"name": class_type,
		"parent": str(ClassDB.get_parent_class(class_type)),
		"instantiable": ClassDB.can_instantiate(class_type),
	}
	if _bool_param(params, "includeProperties", true):
		result["properties"] = _json_value(ClassDB.class_get_property_list(class_type, not include_inherited)).slice(0, limit)
	if _bool_param(params, "includeMethods", true):
		result["methods"] = _json_value(ClassDB.class_get_method_list(class_type, not include_inherited)).slice(0, limit)
	if _bool_param(params, "includeSignals", false):
		result["signals"] = _json_value(ClassDB.class_get_signal_list(class_type, not include_inherited)).slice(0, limit)
	return result


func _capture_viewport(params: Dictionary, capture_3d: bool) -> Dictionary:
	var kind := "3d" if capture_3d else "2d"
	var path_result := _capture_path(_string_param(params, "outputPath", ""), kind)
	if not path_result.ok:
		return path_result
	if DisplayServer.get_name() == "headless":
		return _fail("CAPTURE_UNAVAILABLE", "Editor viewport capture requires a display server.")
	var viewport: SubViewport = _editor.get_editor_viewport_3d(_int_param(params, "viewportIndex", 0)) if capture_3d else _editor.get_editor_viewport_2d()
	if viewport == null:
		return _fail("CAPTURE_UNAVAILABLE", "The editor viewport is unavailable.")
	var image := viewport.get_texture().get_image()
	if image == null or image.is_empty():
		return _fail("CAPTURE_UNAVAILABLE", "The editor viewport has no image in the current display mode.")
	var requested_width := clampi(_int_param(params, "width", 0), 0, 8192)
	var requested_height := clampi(_int_param(params, "height", 0), 0, 8192)
	if requested_width > 0 or requested_height > 0:
		if requested_width == 0:
			requested_width = maxi(1, int(round(float(image.get_width()) * requested_height / image.get_height())))
		if requested_height == 0:
			requested_height = maxi(1, int(round(float(image.get_height()) * requested_width / image.get_width())))
		image.resize(requested_width, requested_height, Image.INTERPOLATE_LANCZOS)
	var absolute: String = path_result.value
	var directory_error := DirAccess.make_dir_recursive_absolute(absolute.get_base_dir())
	if directory_error != OK:
		return _fail("FILE_WRITE_FAILED", "Could not create capture directory.", {"error": error_string(directory_error)})
	if _capture_path_has_link(absolute):
		return _fail("INVALID_ARGUMENT", "Capture outputPath cannot contain symbolic links or reparse points.")
	var save_error := image.save_png(absolute)
	if save_error != OK:
		return _fail("FILE_WRITE_FAILED", "Could not save viewport capture.", {"error": error_string(save_error)})
	var png := image.save_png_to_buffer()
	return _ok({
		"kind": kind,
		"mimeType": "image/png",
		"pngBase64": Marshalls.raw_to_base64(png),
		"path": ProjectSettings.localize_path(absolute),
		"absolutePath": absolute,
		"width": image.get_width(),
		"height": image.get_height(),
		"bytes": png.size(),
	})


func _capture_path(requested: String, kind: String) -> Dictionary:
	var absolute := ""
	if requested.is_empty():
		absolute = ProjectSettings.globalize_path("res://.godot/godot-vibe-os/captures/%s-%d.png" % [kind, Time.get_ticks_msec()])
	else:
		var relative := requested.trim_prefix("res://")
		var prefix := ".godot/godot-vibe-os/captures/"
		var filename := relative.trim_prefix(prefix)
		if not relative.begins_with(prefix) or filename.is_empty() or filename.contains("/") or filename.contains("\\") or filename.contains("..") or not filename.ends_with(".png"):
			return _fail("INVALID_ARGUMENT", "Capture outputPath must be a PNG directly under res://.godot/godot-vibe-os/captures/.")
		absolute = ProjectSettings.globalize_path("res://" + relative)
	if _capture_path_has_link(absolute):
		return _fail("INVALID_ARGUMENT", "Capture outputPath cannot contain symbolic links or reparse points.")
	return {"ok": true, "value": absolute}


func _capture_path_has_link(absolute: String) -> bool:
	var project_path := _project_path().replace("\\", "/")
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


func _open_scene(params: Dictionary) -> Dictionary:
	var path := _string_param(params, "path", "")
	if path.is_empty():
		return _fail("INVALID_ARGUMENT", "scene.open requires path.")
	if not _is_project_resource_path(path):
		return _fail("INVALID_ARGUMENT", "Scene paths must start with res://.")
	var resource := ResourceLoader.load(path)
	if resource == null or not resource is PackedScene:
		return _fail("RESOURCE_NOT_FOUND", "'%s' is not a loadable PackedScene." % path)
	var inherited := _bool_param(params, "inherited", false)
	if not inherited and FileAccess.file_exists(path + ".import"):
		return _fail("FEATURE_UNAVAILABLE", "Imported scenes cannot be opened directly for editing. Open an inherited scene instead.", {"path": path})
	var previous_root := _editor.get_edited_scene_root()
	var previous_instance_id := previous_root.get_instance_id() if previous_root != null else 0
	var expected_path := str(resource.resource_path)
	if expected_path.is_empty():
		expected_path = path
	_editor.open_scene_from_path(path, inherited)
	var opened_root := _editor.get_edited_scene_root()
	var opened := false
	if opened_root != null:
		if inherited:
			opened = opened_root.get_instance_id() != previous_instance_id and _scene_path(opened_root).is_empty()
		else:
			opened = _scene_path(opened_root) == expected_path and _editor.get_open_scenes().has(expected_path)
	if not opened:
		return _fail("FEATURE_UNAVAILABLE", "Godot did not make the requested scene active.", {
			"path": path,
			"activeScene": _scene_path(opened_root),
			"inherited": inherited,
		})
	return _ok({"path": path, "opened": true})


func _save_scene(params: Dictionary) -> Dictionary:
	var root_result := _require_scene_root()
	if not root_result.ok:
		return root_result
	var path := _string_param(params, "path", _scene_path(root_result.value))
	if path.is_empty():
		return _fail("SCENE_SAVE_FAILED", "An unsaved scene requires an explicit res:// path.")
	if not _is_project_resource_path(path):
		return _fail("INVALID_ARGUMENT", "Scene paths must start with res://.")
	_editor.mark_scene_as_unsaved()
	_editor.save_scene_as(path, _bool_param(params, "withPreview", true) and DisplayServer.get_name() != "headless")
	var saved_root := _editor.get_edited_scene_root()
	var saved := (
		saved_root != null
		and _scene_path(saved_root) == path
		and not _editor.get_unsaved_scenes().has(path)
		and FileAccess.file_exists(ProjectSettings.globalize_path(path))
	)
	if not saved:
		return _fail("SCENE_SAVE_FAILED", "Godot could not save the active scene.", {"path": path})
	return _ok({"path": path, "saved": true})


func _set_property(params: Dictionary) -> Dictionary:
	var target_result := _require_node(params, "nodePath")
	if not target_result.ok:
		return target_result
	var node: Node = target_result.value
	var property_name := _string_param(params, "property", "")
	if property_name.is_empty() or not params.has("value"):
		return _fail("INVALID_ARGUMENT", "edit.setProperty requires property and value.")
	var property_info := _find_property(node, property_name)
	if property_info.is_empty():
		return _fail("PROPERTY_NOT_FOUND", "%s has no property '%s'." % [node.get_class(), property_name])
	var decoded := _decode_value(params.value, int(property_info.type))
	if not decoded.ok:
		return decoded
	var previous = node.get(property_name)
	var undo := _editor.get_editor_undo_redo()
	undo.create_action("Godot Vibe OS: Set %s" % property_name, UndoRedo.MERGE_DISABLE, node)
	undo.add_do_property(node, property_name, decoded.value)
	undo.add_undo_property(node, property_name, previous)
	undo.commit_action()
	return _ok({
		"nodePath": _relative_path(_editor.get_edited_scene_root(), node),
		"property": property_name,
		"previous": _json_value(previous),
		"value": _json_value(node.get(property_name)),
	})


func _create_node(params: Dictionary) -> Dictionary:
	var root_result := _require_scene_root()
	if not root_result.ok:
		return root_result
	var root: Node = root_result.value
	var parent_path := _string_param(params, "parentPath", ".")
	var parent := _resolve_node(root, parent_path)
	if parent == null:
		return _fail("NODE_NOT_FOUND", "No parent exists at '%s'." % parent_path)
	var class_type := _string_param(params, "className", _string_param(params, "type", "Node"))
	if not ClassDB.class_exists(class_type) or not ClassDB.can_instantiate(class_type):
		return _fail("CLASS_NOT_FOUND", "Godot class '%s' cannot be instantiated." % class_type)
	var instance = ClassDB.instantiate(class_type)
	if not instance is Node:
		if instance != null:
			instance.free()
		return _fail("INVALID_NODE_TYPE", "Godot class '%s' is not a Node." % class_type)
	var node: Node = instance
	node.name = _string_param(params, "name", class_type)
	var properties: Variant = params.get("properties", {})
	if typeof(properties) != TYPE_DICTIONARY:
		node.free()
		return _fail("INVALID_ARGUMENT", "properties must be an object.")
	var prepared := _prepare_properties(node, properties)
	if not prepared.ok:
		node.free()
		return prepared
	var undo := _editor.get_editor_undo_redo()
	undo.create_action("Godot Vibe OS: Create %s" % class_type, UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(parent, &"add_child", node, true)
	undo.add_do_method(node, &"set_owner", root)
	for property in prepared.value:
		undo.add_do_property(node, property.name, property.value)
		undo.add_undo_property(node, property.name, node.get(property.name))
	undo.add_do_reference(node)
	undo.add_undo_method(parent, &"remove_child", node)
	undo.commit_action()
	return _ok(_node_summary(root, node))


func _delete_node(params: Dictionary) -> Dictionary:
	var target_result := _require_node(params, "nodePath")
	if not target_result.ok:
		return target_result
	var root := _editor.get_edited_scene_root()
	var node: Node = target_result.value
	if node == root:
		return _fail("INVALID_ARGUMENT", "The edited scene root cannot be deleted.")
	var parent := node.get_parent()
	if parent == null:
		return _fail("INVALID_ARGUMENT", "The node has no parent.")
	var previous_path := _relative_path(root, node)
	var previous_owner := node.owner
	var previous_index := node.get_index()
	var undo := _editor.get_editor_undo_redo()
	undo.create_action("Godot Vibe OS: Delete %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(parent, &"remove_child", node)
	undo.add_undo_method(parent, &"add_child", node, true)
	undo.add_undo_method(node, &"set_owner", previous_owner)
	undo.add_undo_method(parent, &"move_child", node, previous_index)
	undo.add_undo_reference(node)
	undo.commit_action()
	return _ok({"nodePath": previous_path, "deleted": node.get_parent() == null})


func _reparent_node(params: Dictionary) -> Dictionary:
	var target_result := _require_node(params, "nodePath")
	if not target_result.ok:
		return target_result
	var root := _editor.get_edited_scene_root()
	var node: Node = target_result.value
	if node == root:
		return _fail("INVALID_ARGUMENT", "The edited scene root cannot be reparented.")
	var new_parent_path := _string_param(params, "newParentPath", "")
	var new_parent := _resolve_node(root, new_parent_path)
	if new_parent == null:
		return _fail("NODE_NOT_FOUND", "No parent exists at '%s'." % new_parent_path)
	if new_parent == node or node.is_ancestor_of(new_parent):
		return _fail("INVALID_ARGUMENT", "A node cannot be parented below itself.")
	var old_parent := node.get_parent()
	var old_owner := node.owner
	var old_index := node.get_index()
	var keep_transform := _bool_param(params, "keepGlobalTransform", true)
	var undo := _editor.get_editor_undo_redo()
	undo.create_action("Godot Vibe OS: Reparent %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(node, &"reparent", new_parent, keep_transform)
	undo.add_do_method(node, &"set_owner", root)
	undo.add_undo_method(node, &"reparent", old_parent, keep_transform)
	undo.add_undo_method(node, &"set_owner", old_owner)
	undo.add_undo_method(old_parent, &"move_child", node, old_index)
	undo.commit_action()
	return _ok({"nodePath": _relative_path(root, node), "parentPath": _relative_path(root, new_parent)})


func _instantiate_scene(params: Dictionary) -> Dictionary:
	var root_result := _require_scene_root()
	if not root_result.ok:
		return root_result
	var root: Node = root_result.value
	var scene_path := _string_param(params, "scenePath", _string_param(params, "path", ""))
	if not _is_project_resource_path(scene_path):
		return _fail("INVALID_ARGUMENT", "edit.instantiateScene requires a res:// scenePath.")
	var packed := ResourceLoader.load(scene_path)
	if packed == null or not packed is PackedScene:
		return _fail("RESOURCE_NOT_FOUND", "'%s' is not a loadable PackedScene." % scene_path)
	var parent_path := _string_param(params, "parentPath", ".")
	var parent := _resolve_node(root, parent_path)
	if parent == null:
		return _fail("NODE_NOT_FOUND", "No parent exists at '%s'." % parent_path)
	var node: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	var requested_name := _string_param(params, "name", "")
	if not requested_name.is_empty():
		node.name = requested_name
	var undo := _editor.get_editor_undo_redo()
	undo.create_action("Godot Vibe OS: Instantiate %s" % scene_path.get_file(), UndoRedo.MERGE_DISABLE, root)
	undo.add_do_method(parent, &"add_child", node, true)
	undo.add_do_method(node, &"set_owner", root)
	undo.add_do_reference(node)
	undo.add_undo_method(parent, &"remove_child", node)
	undo.commit_action()
	var result := _node_summary(root, node)
	result["sourceScene"] = scene_path
	return _ok(result)


func _play_run(params: Dictionary) -> Dictionary:
	var mode := _string_param(params, "mode", "current")
	if _editor.is_playing_scene():
		return _fail("INVALID_ARGUMENT", "A project is already running. Stop it before starting another scene.", _play_status_payload())
	if not FileAccess.file_exists("res://project.godot"):
		return _fail("FEATURE_UNAVAILABLE", "Godot cannot run the project because project.godot is missing.")
	var requested_scene := ""
	match mode:
		"current":
			var root := _editor.get_edited_scene_root()
			if root == null:
				return _fail("SCENE_NOT_OPEN", "No current scene is open.")
			requested_scene = _scene_path(root)
			if requested_scene.is_empty():
				return _fail("FEATURE_UNAVAILABLE", "The current scene must be saved before it can run.")
			_editor.play_current_scene()
		"main":
			requested_scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
			if requested_scene.is_empty() or not ResourceLoader.exists(requested_scene, "PackedScene"):
				return _fail("RESOURCE_NOT_FOUND", "The project does not have a loadable main scene.")
			_editor.play_main_scene()
		"custom":
			var path := _string_param(params, "path", "")
			if not _is_project_resource_path(path) or not ResourceLoader.exists(path, "PackedScene"):
				return _fail("RESOURCE_NOT_FOUND", "A valid res:// scene path is required for custom play.")
			requested_scene = path
			_editor.play_custom_scene(path)
		_:
			return _fail("INVALID_ARGUMENT", "play.run mode must be current, main, or custom.")
	var result := _play_status_payload()
	if not result.playing or result.scenePath != requested_scene:
		if result.playing:
			_editor.stop_playing_scene()
		return _fail("FEATURE_UNAVAILABLE", "Godot did not start the requested scene.", {
			"mode": mode,
			"requestedScene": requested_scene,
			"playing": result.playing,
			"scenePath": result.scenePath,
		})
	result["started"] = true
	result["requestedMode"] = mode
	return _ok(result)


func _play_stop(params: Dictionary) -> Dictionary:
	var was_playing := _editor.is_playing_scene()
	if was_playing:
		var expected_run_id := _string_param(params, "expectedRunId", "")
		if not expected_run_id.is_empty():
			if _debugger == null or not _debugger.has_method("is_run_active"):
				return _fail("FEATURE_UNAVAILABLE", "The runtime debugger bridge cannot verify the requested run.")
			if not _debugger.is_run_active(expected_run_id):
				return _fail("RUN_CHANGED", "The active game is not the run this request started; it was left running.")
		_editor.stop_playing_scene()
	var result := _play_status_payload()
	if result.playing:
		return _fail("FEATURE_UNAVAILABLE", "Godot did not stop the running project.", result)
	result["stopped"] = was_playing
	return _ok(result)


func _play_status() -> Dictionary:
	return _ok(_play_status_payload())


func _debug_snapshot(params: Dictionary) -> Dictionary:
	if _debugger == null or not _debugger.has_method("snapshot"):
		return _fail("FEATURE_UNAVAILABLE", "The runtime debugger bridge is unavailable.")
	var result: Dictionary = _debugger.snapshot(params)
	result["playing"] = _editor.is_playing_scene()
	return _ok(result)


func _debug_capture_frames(params: Dictionary) -> Dictionary:
	if _debugger == null or not _debugger.has_method("capture_frames"):
		return _fail("FEATURE_UNAVAILABLE", "The runtime debugger bridge is unavailable.")
	if not _editor.is_playing_scene() and _string_param(params, "captureId", "").is_empty():
		return _fail("PLAY_MODE_REQUIRED", "No Godot game is running, so there are no frames to capture.")
	return _ok(_debugger.capture_frames(params))


func _play_status_payload() -> Dictionary:
	return {
		"playing": _editor.is_playing_scene(),
		"scenePath": _editor.get_playing_scene(),
	}


func _prepare_properties(node: Node, properties: Dictionary) -> Dictionary:
	var prepared: Array = []
	for key in properties:
		var property_name := str(key)
		var info := _find_property(node, property_name)
		if info.is_empty():
			return _fail("PROPERTY_NOT_FOUND", "%s has no property '%s'." % [node.get_class(), property_name])
		var decoded := _decode_value(properties[key], int(info.type))
		if not decoded.ok:
			return decoded
		prepared.append({"name": property_name, "value": decoded.value})
	return {"ok": true, "value": prepared}


func _decode_value(value, expected_type: int) -> Dictionary:
	match expected_type:
		TYPE_NIL:
			return {"ok": true, "value": value}
		TYPE_BOOL:
			if typeof(value) == TYPE_BOOL:
				return {"ok": true, "value": value}
		TYPE_INT:
			if typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT:
				return {"ok": true, "value": int(value)}
		TYPE_FLOAT:
			if typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT:
				return {"ok": true, "value": float(value)}
		TYPE_STRING:
			if typeof(value) == TYPE_STRING:
				return {"ok": true, "value": value}
		TYPE_STRING_NAME:
			if typeof(value) == TYPE_STRING:
				return {"ok": true, "value": StringName(value)}
		TYPE_NODE_PATH:
			if typeof(value) == TYPE_STRING:
				return {"ok": true, "value": NodePath(value)}
		TYPE_VECTOR2:
			var parts := _numeric_components(value, 2)
			if parts.ok:
				return {"ok": true, "value": Vector2(parts.value[0], parts.value[1])}
		TYPE_VECTOR2I:
			var parts := _numeric_components(value, 2)
			if parts.ok:
				return {"ok": true, "value": Vector2i(parts.value[0], parts.value[1])}
		TYPE_VECTOR3:
			var parts := _numeric_components(value, 3)
			if parts.ok:
				return {"ok": true, "value": Vector3(parts.value[0], parts.value[1], parts.value[2])}
		TYPE_VECTOR3I:
			var parts := _numeric_components(value, 3)
			if parts.ok:
				return {"ok": true, "value": Vector3i(parts.value[0], parts.value[1], parts.value[2])}
		TYPE_VECTOR4:
			var parts := _numeric_components(value, 4)
			if parts.ok:
				return {"ok": true, "value": Vector4(parts.value[0], parts.value[1], parts.value[2], parts.value[3])}
		TYPE_VECTOR4I:
			var parts := _numeric_components(value, 4)
			if parts.ok:
				return {"ok": true, "value": Vector4i(parts.value[0], parts.value[1], parts.value[2], parts.value[3])}
		TYPE_COLOR:
			var parts := _numeric_components(value, 4, 1.0)
			if parts.ok:
				return {"ok": true, "value": Color(parts.value[0], parts.value[1], parts.value[2], parts.value[3])}
		TYPE_DICTIONARY:
			if typeof(value) == TYPE_DICTIONARY:
				return {"ok": true, "value": value}
		TYPE_ARRAY:
			if typeof(value) == TYPE_ARRAY:
				return {"ok": true, "value": value}
		TYPE_PACKED_STRING_ARRAY:
			if typeof(value) == TYPE_ARRAY:
				return {"ok": true, "value": PackedStringArray(value)}
		TYPE_PACKED_INT32_ARRAY:
			if typeof(value) == TYPE_ARRAY:
				return {"ok": true, "value": PackedInt32Array(value)}
		TYPE_PACKED_INT64_ARRAY:
			if typeof(value) == TYPE_ARRAY:
				return {"ok": true, "value": PackedInt64Array(value)}
		TYPE_PACKED_FLOAT32_ARRAY:
			if typeof(value) == TYPE_ARRAY:
				return {"ok": true, "value": PackedFloat32Array(value)}
		TYPE_PACKED_FLOAT64_ARRAY:
			if typeof(value) == TYPE_ARRAY:
				return {"ok": true, "value": PackedFloat64Array(value)}
		TYPE_OBJECT:
			if value == null:
				return {"ok": true, "value": null}
			if typeof(value) == TYPE_DICTIONARY and value.has("resourcePath"):
				var resource_path := str(value.resourcePath)
				if _is_project_resource_path(resource_path) and ResourceLoader.exists(resource_path):
					return {"ok": true, "value": ResourceLoader.load(resource_path)}
	return _fail("UNSUPPORTED_VALUE", "The supplied JSON value cannot be converted to %s." % type_string(expected_type))


func _numeric_components(value, count: int, missing_last = null) -> Dictionary:
	var result: Array = []
	if typeof(value) == TYPE_ARRAY:
		result = value.duplicate()
	elif typeof(value) == TYPE_DICTIONARY:
		var names := ["x", "y", "z", "w"]
		if value.has("r"):
			names = ["r", "g", "b", "a"]
		for index in range(count):
			if value.has(names[index]):
				result.append(value[names[index]])
			elif missing_last != null and index == count - 1:
				result.append(missing_last)
			else:
				return {"ok": false}
	else:
		return {"ok": false}
	if result.size() == count - 1 and missing_last != null:
		result.append(missing_last)
	if result.size() != count:
		return {"ok": false}
	for component in result:
		if typeof(component) != TYPE_INT and typeof(component) != TYPE_FLOAT:
			return {"ok": false}
	return {"ok": true, "value": result}


func _find_property(object: Object, property_name: String) -> Dictionary:
	for info in object.get_property_list():
		if str(info.name) == property_name:
			return info
	return {}


func _object_properties(object: Object, limit: int) -> Array:
	var properties: Array = []
	for info in object.get_property_list():
		if (int(info.get("usage", 0)) & PROPERTY_USAGE_EDITOR) == 0:
			continue
		var property_name := str(info.name)
		properties.append({
			"name": property_name,
			"type": int(info.type),
			"typeName": type_string(int(info.type)),
			"hint": int(info.get("hint", 0)),
			"hintString": str(info.get("hint_string", "")),
			"value": _json_value(object.get(property_name)),
		})
		if properties.size() >= limit:
			break
	return properties


func _node_summary(scene_root: Node, node: Node) -> Dictionary:
	if node == null:
		return {}
	return {
		"name": str(node.name),
		"type": node.get_class(),
		"path": _relative_path(scene_root, node),
		"sceneFilePath": node.scene_file_path,
		"ownerPath": _relative_path(scene_root, node.owner),
		"childCount": node.get_child_count(),
		"instanceId": node.get_instance_id(),
	}


func _json_value(value, depth := 0):
	if depth > 8:
		return "<max-depth>"
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(value)
		TYPE_VECTOR2:
			return {"type": "Vector2", "x": value.x, "y": value.y}
		TYPE_VECTOR2I:
			return {"type": "Vector2i", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {"type": "Vector3", "x": value.x, "y": value.y, "z": value.z}
		TYPE_VECTOR3I:
			return {"type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
		TYPE_VECTOR4:
			return {"type": "Vector4", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
		TYPE_VECTOR4I:
			return {"type": "Vector4i", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
		TYPE_COLOR:
			return {"type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}
		TYPE_RECT2, TYPE_RECT2I:
			return {"type": type_string(typeof(value)), "position": _json_value(value.position, depth + 1), "size": _json_value(value.size, depth + 1)}
		TYPE_TRANSFORM2D:
			return {"type": "Transform2D", "x": _json_value(value.x, depth + 1), "y": _json_value(value.y, depth + 1), "origin": _json_value(value.origin, depth + 1)}
		TYPE_QUATERNION:
			return {"type": "Quaternion", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
		TYPE_DICTIONARY:
			var dictionary := {}
			for key in value:
				dictionary[str(key)] = _json_value(value[key], depth + 1)
			return dictionary
		TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY, TYPE_PACKED_VECTOR4_ARRAY:
			var array: Array = []
			for item in value:
				array.append(_json_value(item, depth + 1))
			return array
		TYPE_OBJECT:
			if value == null:
				return null
			var object_result := {"type": value.get_class(), "instanceId": value.get_instance_id()}
			if value is Resource:
				object_result["resourcePath"] = value.resource_path
			return object_result
		_:
			return str(value)


func _require_scene_root() -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _fail("SCENE_NOT_OPEN", "No edited scene is open.")
	return {"ok": true, "value": root}


func _require_node(params: Dictionary, key: String) -> Dictionary:
	var root_result := _require_scene_root()
	if not root_result.ok:
		return root_result
	var path := _string_param(params, key, "")
	if path.is_empty():
		return _fail("INVALID_ARGUMENT", "%s is required." % key)
	var node := _resolve_node(root_result.value, path)
	if node == null:
		return _fail("NODE_NOT_FOUND", "No node exists at '%s'." % path)
	return {"ok": true, "value": node}


func _resolve_node(root: Node, path: String) -> Node:
	if root == null:
		return null
	var normalized := path.strip_edges().trim_prefix("/")
	if normalized.is_empty() or normalized == "." or normalized == str(root.name) or path == str(root.get_path()):
		return root
	if normalized.begins_with(str(root.name) + "/"):
		normalized = normalized.substr(str(root.name).length() + 1)
	return root.get_node_or_null(NodePath(normalized))


func _relative_path(root: Node, node: Node) -> String:
	if root == null or node == null:
		return ""
	return str(root.get_path_to(node))


func _scene_path(root: Node) -> String:
	return root.scene_file_path if root != null else ""


func _project_path() -> String:
	return ProjectSettings.globalize_path("res://").trim_suffix("/")


func _is_project_resource_path(path: String) -> bool:
	return path.begins_with("res://") and not path.contains("..")


func _string_param(params: Dictionary, key: String, default_value: String) -> String:
	var value = params.get(key, default_value)
	return value if typeof(value) == TYPE_STRING else default_value


func _int_param(params: Dictionary, key: String, default_value: int) -> int:
	var value = params.get(key, default_value)
	return int(value) if typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT else default_value


func _bool_param(params: Dictionary, key: String, default_value: bool) -> bool:
	var value = params.get(key, default_value)
	return value if typeof(value) == TYPE_BOOL else default_value


func _ok(result) -> Dictionary:
	return {"ok": true, "result": result}


func _fail(code: String, message: String, details: Dictionary = {}) -> Dictionary:
	var error := {"code": code, "message": message}
	if not details.is_empty():
		error["details"] = details
	return {"ok": false, "error": error}
