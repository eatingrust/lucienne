"""Blender main-thread adapter. Mutations are finite recipes, never model code.

Only an explicitly launched dedicated-account process imports this module. No
startup file, add-on installation, user preference save, or project save occurs.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat

import bpy
import bmesh
from bpy.props import EnumProperty

from protocol import BridgeError, CATALOG, check_lease, guarded_mutation, read_json, require, validate_request

BRIDGE = None
ACTIONS = [key.rsplit(".", 1)[1] for key in CATALOG if key.startswith("blender.binding.")]
SCOPES = {
    "brush": (("3D View", "VIEW_3D"),),
    "select-rectangle": (("3D View", "VIEW_3D"),),
    "transform": (("3D View", "VIEW_3D"),),
    "select": (("3D View", "VIEW_3D"), ("Sequencer", "SEQUENCE_EDITOR")),
    "pan": (("3D View", "VIEW_3D"), ("Sequencer", "SEQUENCE_EDITOR")),
    "zoom": (("3D View", "VIEW_3D"),),
    "razor-tool": (("Sequencer", "SEQUENCE_EDITOR"),),
    "play-pause": (("3D View", "VIEW_3D"), ("Sequencer", "SEQUENCE_EDITOR")),
    "preview-toggle": (("3D View", "VIEW_3D"), ("Sequencer", "SEQUENCE_EDITOR")),
    "blade-tool": (("Sequencer", "SEQUENCE_EDITOR"),),
    "mark-in": (("Sequencer", "SEQUENCE_EDITOR"),),
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def native_identity(kind, datablock):
    # ID.session_uid is Blender's read-only data-block lifetime identity, stable
    # across renames/reallocation. A reused memory address must not identify a
    # replacement object as the old one. Never fall back to a pointer or name.
    # https://docs.blender.org/api/5.2/bpy.types.ID.html#bpy.types.ID.session_uid
    try:
        session_uid = datablock.session_uid
    except (AttributeError, ReferenceError):
        raise BridgeError("INVALID_NATIVE_IDENTITY") from None
    require(type(session_uid) is int and session_uid > 0, "INVALID_NATIVE_IDENTITY")
    return "blender:" + kind + ":" + digest({"pid": os.getpid(), "sessionUid": session_uid})


def key_parts(value):
    parts = value.split("+")
    return {"type": "SPACE" if parts[-1] == "Space" else parts[-1], "shift": "Shift" in parts,
            "ctrl": "Ctrl" in parts, "alt": "Alt" in parts, "oskey": "Meta" in parts}


def binding_value(item):
    return "+".join((["Meta"] if item.oskey else []) + (["Ctrl"] if item.ctrl else []) +
                    (["Alt"] if item.alt else []) + (["Shift"] if item.shift else []) +
                    ["Space" if item.type == "SPACE" else item.type])


class LUCIENNE_OT_source_action(bpy.types.Operator):
    bl_idname = "lucienne.source_action"
    bl_label = "Source-familiar native control"
    bl_options = {"REGISTER", "UNDO"}
    action: EnumProperty(items=[(action, action, "Native Blender equivalent") for action in ACTIONS])

    def invoke(self, context, event):
        return self.execute(context)

    def execute(self, context):
        if BRIDGE is None or not BRIDGE.armed:
            return {"CANCELLED"}
        try:
            BRIDGE.assert_owned()
            action = self.action
            if action in {"play-pause", "preview-toggle"}:
                return bpy.ops.screen.animation_play()
            if action == "mark-in":
                context.scene.use_preview_range = True
                context.scene.frame_preview_start = context.scene.frame_current
                context.scene.frame_preview_end = max(context.scene.frame_current + 1, context.scene.frame_end)
                return {"FINISHED"}
            if action in {"razor-tool", "blade-tool"}:
                # Native cut at current playhead; no claim of source project conversion.
                return bpy.ops.sequencer.split(frame=context.scene.frame_current, type="SOFT", side="BOTH")
            if action == "pan":
                return bpy.ops.view3d.move("INVOKE_DEFAULT") if context.area.type == "VIEW_3D" else bpy.ops.view2d.pan("INVOKE_DEFAULT")
            if action == "zoom":
                return bpy.ops.view3d.zoom("INVOKE_DEFAULT")
            if action == "select" and context.area.type == "SEQUENCE_EDITOR":
                return bpy.ops.wm.tool_set_by_id(name="builtin.select_box")
            if action == "brush":
                require(context.active_object is not None and context.active_object.type == "MESH", "SELECT_MESH_FOR_SCULPT")
                if context.object.mode != "SCULPT":
                    bpy.ops.object.mode_set(mode="SCULPT")
                return bpy.ops.brush.asset_activate(asset_library_type="ESSENTIALS",
                    relative_asset_identifier="brushes/essentials_brushes-mesh_sculpt.blend/Brush/Draw")
            if context.object is not None and context.object.mode != "OBJECT":
                bpy.ops.object.mode_set(mode="OBJECT")
            tool = {"select": "builtin.select_box", "select-rectangle": "builtin.select_box", "transform": "builtin.transform"}[action]
            return bpy.ops.wm.tool_set_by_id(name=tool)
        except (BridgeError, RuntimeError, KeyError):
            self.report({"WARNING"}, "This control needs the matching Blender editor and selected object")
            return {"CANCELLED"}


class LUCIENNE_PT_native_tools(bpy.types.Panel):
    bl_label = "Select and Move"
    bl_idname = "LUCIENNE_PT_native_tools"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Lucienne"

    @classmethod
    def poll(cls, context):
        return BRIDGE is not None and BRIDGE.armed and context.scene == BRIDGE.scene

    def draw(self, context):
        row = self.layout.row(align=True)
        row.operator("wm.tool_set_by_id", text="Select").name = "builtin.select_box"
        row.operator("wm.tool_set_by_id", text="Move").name = "builtin.move"
        obj = context.active_object
        if obj:
            self.layout.label(text=obj.name)
            self.layout.prop(obj, "location", text="Position")
        self.layout.label(text="Native Blender practice scene")


class BlenderBridge:
    def __init__(self, directory, token):
        self.directory, self.token = Path(directory), token
        self.last_id = None
        self.baseline = None
        self.window = self.view = self.scene = None
        self.created_objects, self.created_meshes = [], []
        self.keymaps, self.disabled = [], []
        self.registered = []
        self.committed = None
        self.armed = False
        self.stopped = False

    def account(self):
        require(not bpy.app.background, "GUI_PROCESS_REQUIRED")
        require(pwd.getpwuid(os.geteuid()).pw_name == "lucienne", "WRONG_ACCOUNT")
        require(pwd.getpwuid(os.stat("/dev/console").st_uid).pw_name == "lucienne", "WRONG_CONSOLE_OWNER")

    def guard(self, request):
        self.account()
        check_lease(read_json(self.directory / "lease.json"), request, self.token)

    def mutate(self, request, operation):
        return guarded_mutation(lambda: self.guard(request), operation)

    def set(self, request, obj, key, value):
        return self.mutate(request, lambda: setattr(obj, key, value))

    def assert_owned(self):
        require(self.baseline is not None, "HELLO_REQUIRED")
        require(bpy.data.filepath == self.baseline["filepath"], "UNOWNED_DOCUMENTS_PRESENT")
        require(self.window in list(bpy.context.window_manager.windows), "OWNED_WINDOW_LOST")
        require(self.window.scene in (self.scene, self.baseline["scene"]), "UNOWNED_DOCUMENTS_PRESENT")
        require(self.window.workspace.sequencer_scene in (self.scene, self.baseline["sequencer_scene"]), "UNOWNED_DOCUMENTS_PRESENT")
        allowed = set(self.baseline["scenes"])
        if self.scene is not None:
            allowed.add(self.scene.as_pointer())
        require(all(scene.as_pointer() in allowed for scene in bpy.data.scenes), "UNOWNED_DOCUMENTS_PRESENT")

    def capture(self, request):
        require(len(bpy.context.window_manager.windows) == 1, "EXISTING_WINDOWS")
        require(not bpy.data.filepath, "EXISTING_DOCUMENT")
        window = bpy.context.window_manager.windows[0]
        views = [a for a in window.screen.areas if a.type == "VIEW_3D"]
        require(len(views) == 1 and views[0].width > 0 and views[0].height > 0, "WINDOW_NOT_READY")
        self.window, self.view = window, views[0]
        space = self.view.spaces.active
        ui = next((r for r in self.view.regions if r.type == "UI"), None)
        require(ui is not None, "SIDEBAR_UNAVAILABLE")
        self.baseline = {"scene": window.scene, "scenes": [s.as_pointer() for s in bpy.data.scenes],
            "sequencer_scene": window.workspace.sequencer_scene,
            "filepath": bpy.data.filepath, "view": {key: getattr(space, key) for key in
                ("show_region_ui", "show_region_toolbar", "show_region_tool_header")},
            "region3d": {"view_distance": space.region_3d.view_distance,
                "view_location": list(space.region_3d.view_location),
                "view_rotation": list(space.region_3d.view_rotation),
                "view_perspective": space.region_3d.view_perspective},
            "alignment": ui.alignment,
            "areas": [(a, a.type, a.ui_type) for a in window.screen.areas]}
        self.baseline_fingerprint = digest({"scene": window.scene.name, "regions": self.baseline["view"],
            "region3d": self.baseline["region3d"], "alignment": ui.alignment,
            "areas": [(a.type, a.ui_type, a.x, a.y, a.width, a.height) for a in window.screen.areas]})
        for cls in (LUCIENNE_OT_source_action, LUCIENNE_PT_native_tools):
            def register(cls=cls):
                bpy.utils.register_class(cls)
                self.registered.append(cls)
            self.mutate(request, register)

    def prepare(self, request):
        if self.scene is not None:
            return
        def scene_new():
            self.scene = bpy.data.scenes.new("Lucienne Native Practice")
        self.mutate(request, scene_new)
        for name, location, radius in (("Lucienne Sphere", (-1.5, 0, 0), 1), ("Lucienne Marker", (2, 0, 0), .6)):
            bm = bmesh.new()
            try:
                bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=radius)
                holder = {}
                def mesh_new():
                    holder["mesh"] = bpy.data.meshes.new(name)
                    self.created_meshes.append(holder["mesh"])
                self.mutate(request, mesh_new)
                self.mutate(request, lambda: bm.to_mesh(holder["mesh"]))
                def object_new():
                    holder["obj"] = bpy.data.objects.new(name, holder["mesh"])
                    self.created_objects.append(holder["obj"])
                self.mutate(request, object_new)
                self.mutate(request, lambda: self.scene.collection.objects.link(holder["obj"]))
                self.set(request, holder["obj"], "location", location)
            finally:
                bm.free()
        self.set(request, self.window, "scene", self.scene)
        self.set(request, self.window.workspace, "sequencer_scene", self.scene)
        self.set(request, self.scene, "frame_end", 120)
        self.set(request, self.scene, "frame_current", 60)
        self.mutate(request, self.scene.sequence_editor_create)
        holder = {}
        def strip_new():
            strips = self.scene.sequence_editor.strips
            holder["strip"] = strips.new_effect("Lucienne color practice", type="COLOR", channel=1, frame_start=1, length=120)
        self.mutate(request, strip_new)
        self.set(request, holder["strip"], "color", (.18, .4, .8))
        self.set(request, holder["strip"], "select", True)
        self.set(request, self.scene.sequence_editor, "active_strip", holder["strip"])
        # A real native sequencer accompanies the main 3D task for video controls.
        timeline = next((a for a in self.window.screen.areas if a.type == "DOPESHEET_EDITOR"), None)
        require(timeline is not None, "TIMELINE_UNAVAILABLE")
        self.set(request, timeline, "type", "SEQUENCE_EDITOR")
        self.set(request, timeline.spaces.active, "view_type", "SEQUENCER")
        self.set(request, self.view.spaces.active.region_3d, "view_distance", 9)
        self.set(request, self.view.spaces.active.region_3d, "view_location", (0, 0, 0))

    def clear_bindings(self, request):
        while self.keymaps:
            km, item, _ = self.keymaps[-1]
            def remove():
                km.keymap_items.remove(item)
                self.keymaps.pop()
            self.mutate(request, remove)
        while self.disabled:
            item, active = self.disabled[-1]
            def restore():
                item.active = active
                self.disabled.pop()
            self.mutate(request, restore)

    def install_bindings(self, request, values):
        self.clear_bindings(request)
        wm = bpy.context.window_manager
        require(wm.keyconfigs.addon is not None, "KEYMAP_NOT_READY")
        active = {action: values["blender.binding." + action] for action in ACTIONS
                  if values["blender.binding." + action] != "disabled"}
        # Disable exact conflicting default/user shortcuts only for the active native contexts.
        signatures = [key_parts(value) for value in active.values()]
        for config in (wm.keyconfigs.default, wm.keyconfigs.user):
            for km in config.keymaps:
                if km.name not in {"3D View", "Object Mode", "Sculpt", "Sequencer"}:
                    continue
                for item in km.keymap_items:
                    if item.active and any(all(getattr(item, key) == val for key, val in sig.items()) for sig in signatures):
                        def disable(item=item):
                            self.disabled.append((item, item.active))
                            item.active = False
                        self.mutate(request, disable)
        for action, value in active.items():
            for name, space in SCOPES[action]:
                holder = {}
                self.mutate(request, lambda: holder.update(km=wm.keyconfigs.addon.keymaps.new(name=name, space_type=space)))
                def item_new():
                    item = holder["km"].keymap_items.new("lucienne.source_action", value="PRESS", head=True, **key_parts(value))
                    self.keymaps.append((holder["km"], item, action))
                    holder["item"] = item
                self.mutate(request, item_new)
                self.set(request, holder["item"].properties, "action", action)

    def sidebar(self):
        return next(r for r in self.view.regions if r.type == "UI")

    def flip_sidebar(self, request, side):
        region = self.sidebar()
        if region.alignment.lower() != side:
            with bpy.context.temp_override(window=self.window, area=self.view, region=region):
                result = self.mutate(request, bpy.ops.screen.region_flip)
                require("FINISHED" in result, "PANEL_MOVE_FAILED")
        require(self.sidebar().alignment.lower() == side, "PANEL_MOVE_FAILED")

    def apply(self, request):
        self.assert_owned()
        self.armed = False
        self.prepare(request)
        values = {op["capabilityId"]: op["value"] for op in request["operations"]}
        self.install_bindings(request, values)
        space = self.view.spaces.active
        self.set(request, space, "show_region_ui", True)
        self.flip_sidebar(request, values["blender.layout.panel-side"])
        self.set(request, space, "show_region_toolbar", values["blender.tool-layout.density"] == "full")
        # Native sidebar/tool-header regions release actual viewport pixels.
        normal = values["blender.canvas.work-area"] == "normal"
        self.set(request, space, "show_region_ui", normal)
        self.set(request, space, "show_region_tool_header", normal)
        self.guard(request)
        self.committed = {k: request[k] for k in ("runId", "requestId", "generation")}
        self.armed = True
        self.view.tag_redraw()
        return {"applied": True}

    def actual_operations(self):
        operations = []
        for action in ACTIONS:
            found = [(km, item) for km, item, owned_action in self.keymaps if owned_action == action and item.active]
            if not found:
                value = "disabled"
            else:
                require(len(found) == len(SCOPES[action]), "BINDING_READBACK_MISMATCH")
                require({(km.name, km.space_type) for km, _ in found} == set(SCOPES[action]), "BINDING_READBACK_MISMATCH")
                values = {binding_value(item) for _, item in found}
                require(len(values) == 1 and all(item.idname == "lucienne.source_action" and item.properties.action == action for _, item in found), "BINDING_READBACK_MISMATCH")
                value = values.pop()
                signature = key_parts(value)
                for config in (bpy.context.window_manager.keyconfigs.default, bpy.context.window_manager.keyconfigs.user):
                    for km in config.keymaps:
                        if km.name not in {"3D View", "Object Mode", "Sculpt", "Sequencer"}:
                            continue
                        require(not any(item.active and item.idname != "lucienne.source_action" and
                            all(getattr(item, key) == val for key, val in signature.items()) for item in km.keymap_items), "BINDING_CONFLICT_ACTIVE")
            operations.append({"capabilityId": "blender.binding." + action, "value": value})
        space = self.view.spaces.active
        require(space.show_region_ui == space.show_region_tool_header, "WORK_AREA_READBACK_MISMATCH")
        operations.extend([
            {"capabilityId": "blender.layout.panel-side", "value": self.sidebar().alignment.lower()},
            {"capabilityId": "blender.canvas.work-area", "value": "normal" if space.show_region_ui else "large"},
            {"capabilityId": "blender.tool-layout.density", "value": "full" if space.show_region_toolbar else "simple"},
        ])
        return operations

    def geometry(self):
        return {"areas": [{"type": a.type, "x": a.x, "y": a.y, "width": a.width, "height": a.height,
            "regions": [{"type": r.type, "alignment": r.alignment, "x": r.x, "y": r.y,
                         "width": r.width, "height": r.height} for r in a.regions]} for a in self.window.screen.areas]}

    def readiness(self):
        self.assert_owned()
        region = next((r for r in self.view.regions if r.type == "WINDOW"), None)
        visible = not bpy.app.background and self.window.width > 0 and self.window.height > 0 and region is not None and region.width > 0 and region.height > 0
        # Outer runtime must additionally confirm OS window visibility/minimization.
        interactive = visible and self.armed and self.scene is not None and self.window.scene == self.scene and not self.window.modal_operators
        return visible, interactive

    def observe(self):
        self.assert_owned()
        require(self.armed and self.scene is not None and self.window.scene == self.scene, "OWNED_SCENE_NOT_ACTIVE")
        objects = [{"id": native_identity("object", o), "name": o.name, "selected": o.select_get(), "location": list(o.location),
                    "meshDigest": digest([list(v.co) for v in o.data.vertices]) if o.type == "MESH" else None} for o in self.scene.objects]
        layer = self.window.view_layer
        active = layer.objects.active
        return {"contextId": native_identity("scene", self.scene),
            "taskState": {"objects": objects, "activeObject": active.name if active else None,
            "activeObjectId": native_identity("object", active) if active else None,
            "mode": active.mode if active else "OBJECT", "frame": self.scene.frame_current,
            "previewStart": self.scene.frame_preview_start, "previewEnabled": self.scene.use_preview_range,
            "playing": self.window.screen.is_animation_playing,
            "strips": [{"name": s.name, "start": s.frame_final_start, "end": s.frame_final_end, "selected": s.select}
                       for s in self.scene.sequence_editor.strips]}, "geometry": self.geometry(), "evidenceRefs": []}

    def restore(self, request):
        self.assert_owned()
        self.armed = False
        active = self.window.view_layer.objects.active
        if active is not None and active in list(self.created_objects) and active.mode != "OBJECT":
            region = next(r for r in self.view.regions if r.type == "WINDOW")
            with bpy.context.temp_override(window=self.window, area=self.view, region=region):
                self.mutate(request, lambda: bpy.ops.object.mode_set(mode="OBJECT"))
        if self.window.screen.is_animation_playing:
            with bpy.context.temp_override(window=self.window):
                self.mutate(request, lambda: bpy.ops.screen.animation_cancel(restore_frame=False))
        self.clear_bindings(request)
        self.set(request, self.window, "scene", self.baseline["scene"])
        self.set(request, self.window.workspace, "sequencer_scene", self.baseline["sequencer_scene"])
        for area, kind, ui_type in self.baseline["areas"]:
            if area.type != kind:
                self.set(request, area, "type", kind)
            self.set(request, area, "ui_type", ui_type)
        self.set(request, self.view.spaces.active, "show_region_ui", True)
        if self.baseline["alignment"] in ("LEFT", "RIGHT"):
            self.flip_sidebar(request, self.baseline["alignment"].lower())
        for key, value in self.baseline["view"].items():
            self.set(request, self.view.spaces.active, key, value)
        for key, value in self.baseline["region3d"].items():
            self.set(request, self.view.spaces.active.region_3d, key, value)
        if self.scene is not None:
            def remove_scene():
                bpy.data.scenes.remove(self.scene)
                self.scene = None
            self.mutate(request, remove_scene)
        while self.created_objects:
            obj = self.created_objects[-1]
            def remove_object():
                bpy.data.objects.remove(obj, do_unlink=True)
                self.created_objects.pop()
            self.mutate(request, remove_object)
        while self.created_meshes:
            mesh = self.created_meshes[-1]
            def remove_mesh():
                bpy.data.meshes.remove(mesh)
                self.created_meshes.pop()
            self.mutate(request, remove_mesh)
        while self.registered:
            cls = self.registered[-1]
            def unregister():
                bpy.utils.unregister_class(cls)
                self.registered.pop()
            self.mutate(request, unregister)
        self.committed = None
        require(not self.keymaps and not self.disabled and self.scene is None and not self.created_objects and not self.created_meshes, "RESTORE_INCOMPLETE")
        require(self.window.scene == self.baseline["scene"] and self.window.workspace.sequencer_scene == self.baseline["sequencer_scene"] and
            all(getattr(self.view.spaces.active, key) == value for key, value in self.baseline["view"].items()) and
            self.sidebar().alignment == self.baseline["alignment"], "RESTORE_READBACK_MISMATCH")
        for key, value in self.baseline["region3d"].items():
            actual = getattr(self.view.spaces.active.region_3d, key)
            require(list(actual) == value if isinstance(value, list) else actual == value, "RESTORE_READBACK_MISMATCH")
        return {"ownedStateRestored": True, "ownedSceneRemoved": True}

    def dispatch(self, request):
        command = request["command"]
        if command == "hello":
            if self.baseline is None:
                self.capture(request)
            return {"nativeVersion": bpy.app.version_string, "pid": os.getpid(), "account": "lucienne",
                    "baselineFingerprint": self.baseline_fingerprint}
        require(self.baseline is not None, "HELLO_REQUIRED")
        if command == "apply":
            return self.apply(request)
        if command in ("readback", "observe"):
            require(self.committed is not None and all(request[k] == self.committed[k] for k in self.committed), "STALE_OBSERVATION")
            if command == "observe":
                return self.observe()
            visible, interactive = self.readiness()
            return {"requestId": request["requestId"], "targetVisible": visible, "interactive": interactive,
                    "operations": self.actual_operations(), "evidenceRefs": []}
        if command == "restore":
            return self.restore(request)
        if command == "close":
            require(self.scene is None and not self.keymaps and not self.registered, "RESTORE_REQUIRED")
            self.assert_owned()
            self.mutate(request, lambda: bpy.ops.wm.quit_blender())
            return {"closing": True}
        raise BridgeError("INVALID_COMMAND")

    def poll(self):
        if self.stopped:
            return None
        request = None
        try:
            request = read_json(self.directory / "request.json")
            if not isinstance(request, dict) or request.get("id") == self.last_id:
                return .025
            request = validate_request(request, self.token)
            self.last_id = request["id"]
            self.guard(request)
            result = self.dispatch(request)
            self.guard(request)
            response = {"v": 1, "id": request["id"], "ok": True, "result": result}
        except FileNotFoundError:
            return .025
        except Exception as error:
            if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                return .025
            self.last_id = request["id"]
            self.armed = False
            response = {"v": 1, "id": request["id"], "ok": False,
                        "error": str(error) if isinstance(error, BridgeError) else "NATIVE_EXCEPTION"}
        temporary = self.directory / "response.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(response, stream, separators=(",", ":"))
        os.replace(temporary, self.directory / "response.json")
        return .025


def start():
    global BRIDGE
    directory = os.environ.get("LUCIENNE_BLENDER_BRIDGE_DIR")
    token = os.environ.get("LUCIENNE_BLENDER_TOKEN")
    require(directory and token and len(token) >= 32, "INVALID_BOOTSTRAP")
    path = Path(directory)
    info = path.lstat()
    require(path.is_absolute() and not path.is_symlink() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0, "UNSAFE_BRIDGE_DIRECTORY")
    BRIDGE = BlenderBridge(directory, token)
    BRIDGE.account()
    bpy.app.timers.register(BRIDGE.poll, first_interval=.05, persistent=False)
