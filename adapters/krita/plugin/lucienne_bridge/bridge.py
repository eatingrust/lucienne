"""Native Qt main-thread bridge. No shell, eval, arbitrary paths or model actions."""
import hashlib
import json
import os
import pwd
import stat
from pathlib import Path

from krita import Extension, Krita
from PyQt5.QtCore import QByteArray, QTimer, Qt
from PyQt5.QtGui import QKeySequence
from PyQt5.QtWidgets import QApplication, QDockWidget, QToolBar, QWidget

from .diagnostics import mark_status
from .protocol import BridgeError, CATALOG, check_lease, read_json, require, validate_request

BINDINGS = {
    "krita.binding.brush": ("KritaShape/KisToolBrush", "B"),
    "krita.binding.select-rectangle": ("KisToolSelectRectangular", "M"),
    # Qt's portable Ctrl means Command on macOS; JS source Meta means Command.
    "krita.binding.transform": ("KisToolTransform", "Ctrl+T"),
}


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


def rect(value):
    return [value.x(), value.y(), value.width(), value.height()]


def shortcuts(action):
    return [s.toString(QKeySequence.PortableText) for s in action.shortcuts() if not s.isEmpty()]


class LucienneBridge(Extension):
    def __init__(self, parent):
        super().__init__(parent)
        self.app = Krita.instance()
        self.directory = None
        self.token = None
        self.busy = False
        self.last_id = None
        self.baseline = None
        self.document = None
        self.committed = None
        self.work_area_measurement = None
        self.touched_actions = set()
        self.simple_toolbar = None
        self.owned_nodes = []

    def setup(self):
        mark_status("setup-start")
        directory = os.environ.get("LUCIENNE_KRITA_BRIDGE_DIR")
        token = os.environ.get("LUCIENNE_KRITA_TOKEN")
        if not directory or not token:
            return  # An ordinary launch with the extension installed stays inert.
        try:
            self._account()
            candidate = Path(directory)
            info = candidate.lstat()
            require(candidate.is_absolute() and not candidate.is_symlink(), "UNSAFE_BRIDGE_DIRECTORY")
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0, "UNSAFE_BRIDGE_DIRECTORY")
            require(len(token) >= 32, "INVALID_TOKEN")
            self.directory = candidate
            self.token = token
            self.timer = QTimer(self)
            self.timer.setInterval(50)
            self.timer.timeout.connect(self._poll)
            self.timer.start()
            mark_status("setup-ready")
        except Exception as error:
            mark_status("setup-failed", error=error)
            # Never initialize on an ordinary personal account, nor expose paths/tokens in logs.
            return

    def createActions(self, window):
        pass

    def _account(self):
        require(pwd.getpwuid(os.geteuid()).pw_name == "lucienne", "WRONG_ACCOUNT")
        require(pwd.getpwuid(os.stat("/dev/console").st_uid).pw_name == "lucienne", "WRONG_CONSOLE_OWNER")

    def _guard(self, request):
        self._account()
        check_lease(read_json(self.directory / "lease.json"), request, self.token)

    def _mutate(self, request, operation):
        self._guard(request)
        result = operation()
        self._guard(request)
        return result

    def _wait(self, request):
        self._status("wait-start", request)
        if self.document:
            self.document.waitForDone()
        self._guard(request)
        self._status("wait-ready", request)

    def _status(self, phase, request, error=None):
        mark_status(phase, request.get("command"), request.get("id"), error)

    def _poll(self):
        if self.busy:
            return
        request = None
        try:
            request = read_json(self.directory / "request.json")
            if not isinstance(request, dict) or request.get("id") == self.last_id:
                return
            request = validate_request(request, self.token)
            self._status("command-received", request)
            self.last_id = request["id"]
            self.busy = True
            self._guard(request)
            result = self._dispatch(request)
            response = {"v": 1, "id": request["id"], "ok": True, "result": result}
        except FileNotFoundError as error:
            if isinstance(request, dict) and isinstance(request.get("id"), str):
                self._status("command-failed", request, error)
            return
        except Exception as error:
            if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                return
            self.last_id = request["id"]
            self._status("command-failed", request, error)
            # A failed/aborted mutation can still have queued a native stroke.
            # Do not acknowledge until it has drained; if draining itself fails,
            # withhold settlement and require the process owner to prove exit.
            try:
                if self.document is not None:
                    self._status("wait-start", request)
                    self.document.waitForDone()
                    self._status("wait-ready", request)
            except Exception as wait_error:
                self._status("wait-failed", request, wait_error)
                self.timer.stop()
                return
            code = str(error) if isinstance(error, BridgeError) else "NATIVE_EXCEPTION"
            response = {"v": 1, "id": request["id"], "ok": False, "error": code}
        finally:
            self.busy = False
        # Protocol receipts contain technical observations only. No token or paths.
        try:
            temporary = self.directory / "response.tmp"
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(response, stream, separators=(",", ":"))
            os.replace(temporary, self.directory / "response.json")
            self._status("response-written", request)
        except Exception as error:
            self._status("response-write-failed", request, error)
            raise

    def _window(self):
        window = self.app.activeWindow()
        require(window is not None and window.qwindow() is not None, "WINDOW_NOT_READY")
        return window, window.qwindow()

    def _actions(self):
        return {a.objectName(): a for a in self.app.actions() if a.objectName()}

    def _canvas_widget(self):
        candidates = [w for w in self.main.findChildren(QWidget)
                      if (w.inherits("KisOpenGLCanvas2") or w.inherits("KisQPainterCanvas")) and w.isVisible()]
        require(len(candidates) == 1, "CANVAS_NOT_READY")
        return candidates[0]

    def _create_node(self, request, name):
        # Retain newly allocated nodes before the post-mutation lease check.
        # This also keeps partial-apply ownership explicit until process exit.
        def create_owned_node():
            node = self.document.createNode(name, "paintlayer")
            require(node is not None, "NODE_CREATE_FAILED")
            self.owned_nodes.append(node)
            return node
        return self._mutate(request, create_owned_node)

    def _capture(self, request):
        self._status("capture-start", request)
        require(not self.app.documents(), "EXISTING_DOCUMENTS")
        window, main = self._window()
        require(main.isVisible() and not main.isMinimized() and QApplication.activeModalWidget() is None, "WINDOW_NOT_READY")
        require(len(self.app.windows()) == 1, "EXISTING_WINDOWS")
        actions = self._actions()
        require(all(name in actions for name, _ in BINDINGS.values()), "MISSING_NATIVE_ACTION")
        docks = {d.objectName(): d for d in main.findChildren(QDockWidget) if d.objectName()}
        # Stable native object names, never translated UI strings.
        layer = next((d for key, d in docks.items() if key in {"KisLayerBox", "Layers", "layerBox"}), None)
        toolbox = next((d for key, d in docks.items() if key in {"ToolBox", "KoToolBoxDocker"}), None)
        require(layer is not None and toolbox is not None, "MISSING_NATIVE_DOCK")
        # Krita intentionally hides auxiliary dockers on its welcome page.
        # Preserve that untouched baseline; inspect usable workspace docks only
        # after the owned document/view has been created.
        snapshot = {
            "actions": {name: shortcuts(action) for name, action in actions.items()},
            "configurable": {name: action.property("isShortcutConfigurable") for name, action in actions.items()},
            "docks": {name: {"hidden": d.isHidden(), "area": int(main.dockWidgetArea(d)), "floating": d.isFloating()} for name, d in docks.items()},
            "state": bytes(main.saveState()),
        }
        self.baseline = snapshot
        self.native_actions = actions
        self.docks = docks
        self.layer_dock = layer
        self.toolbox = toolbox
        self.non_key_docks = None
        self.main = main
        self.window = window
        self.baseline_fingerprint = digest({"actions": snapshot["actions"], "docks": snapshot["docks"], "state": snapshot["state"].hex()})

    def _resolve_work_area_docks(self):
        require(self.document is not None and self.app.activeDocument() == self.document, "OWNED_DOCUMENT_NOT_ACTIVE")
        if self.non_key_docks is None:
            areas = (Qt.LeftDockWidgetArea, Qt.RightDockWidgetArea, Qt.TopDockWidgetArea, Qt.BottomDockWidgetArea)
            candidates = [key for key, dock in self.docks.items()
                          if dock not in (self.layer_dock, self.toolbox) and dock.isVisible()
                          and not dock.isFloating() and self.main.dockWidgetArea(dock) in areas
                          and dock.width() > 0 and dock.height() > 0]
            require(bool(candidates), "WORK_AREA_NOT_DISTINCT")
            self.non_key_docks = candidates

    def _layout_canvas_size(self, request):
        # Request a synchronous layout pass without timers/processEvents or
        # deferred mutations. Later native readback must still match these sizes.
        layout = self.main.layout()
        require(layout is not None, "WORK_AREA_NOT_DISTINCT")
        self._mutate(request, layout.activate)
        canvas = self._canvas_widget()
        size = [canvas.width(), canvas.height()]
        require(all(value > 0 for value in size), "WORK_AREA_NOT_DISTINCT")
        return size

    def _apply_work_area(self, request, mode, layer_side):
        self.work_area_measurement = None
        self._resolve_work_area_docks()
        # Keep the native auxiliary controls opposite Layers so hiding them can
        # release real canvas space even when Layers was moved to the right.
        side = Qt.RightDockWidgetArea if layer_side == Qt.LeftDockWidgetArea else Qt.LeftDockWidgetArea
        for key in self.non_key_docks:
            dock = self.docks[key]
            self._mutate(request, lambda d=dock: d.setFloating(False))
            self._mutate(request, lambda d=dock: self.main.addDockWidget(side, d))
            self._mutate(request, dock.show)
        normal = self._layout_canvas_size(request)
        window_size = [self.main.width(), self.main.height()]
        for key in self.non_key_docks:
            self._mutate(request, self.docks[key].hide)
        large = self._layout_canvas_size(request)
        require([self.main.width(), self.main.height()] == window_size
                and large[0] >= normal[0] and large[1] >= normal[1]
                and large[0] * large[1] > normal[0] * normal[1], "WORK_AREA_NOT_DISTINCT")
        if mode == "normal":
            for key in self.non_key_docks:
                self._mutate(request, self.docks[key].show)
        actual = self._layout_canvas_size(request)
        require(actual == (normal if mode == "normal" else large), "NATIVE_WORK_AREA_DRIFT")
        self.work_area_measurement = {"normal": normal, "large": large, "mode": mode, "windowSize": window_size}

    def _dispatch(self, request):
        self._status("dispatch-start", request)
        command = request["command"]
        if command == "hello":
            if self.baseline is None:
                self._capture(request)
                self._status("capture-ready", request)
            return {"nativeVersion": self.app.version(), "baselineFingerprint": self.baseline_fingerprint, "pid": os.getpid(), "account": "lucienne", "documentCount": len(self.app.documents())}
        require(self.baseline is not None, "HELLO_REQUIRED")
        if command == "apply":
            self._apply(request)
            return {"applied": True}
        if command == "readback":
            self._wait(request)
            return self._readback(request)
        if command == "observe":
            self._wait(request)
            return self._observe()
        if command == "restore":
            return self._restore(request)
        if command == "close":
            require(self.document is None and not self.app.documents(), "DOCUMENTS_STILL_OPEN")
            # quit is requested here; the owner must wait for actual process exit.
            self._mutate(request, QApplication.instance().quit)
            return {"closing": True}
        raise BridgeError("INVALID_COMMAND")

    def _prepare(self, request):
        self._status("prepare-start", request)
        require(not self.app.documents(), "EXISTING_DOCUMENTS")
        def create_owned_document():
            self.document = self.app.createDocument(960, 640, "Lucienne practice", "RGBA", "U8", "", 96.0)
        self._mutate(request, create_owned_document)
        require(self.document is not None, "DOCUMENT_CREATE_FAILED")
        doc = self.document
        self._status("document-created", request)
        self._mutate(request, lambda: doc.setAutosave(False))
        background = self._create_node(request, "Prepared background")
        self._mutate(request, lambda: doc.rootNode().addChildNode(background, None))
        self._mutate(request, lambda: background.setPixelData(QByteArray(bytes([232, 236, 241, 255]) * (960 * 640)), 0, 0, 960, 640))
        self._mutate(request, lambda: background.setLocked(True))
        content = self._create_node(request, "Practice paint and transform")
        self._mutate(request, lambda: doc.rootNode().addChildNode(content, background))
        # This prepared colored rectangle is a baseline, never claimed as task QA.
        self._mutate(request, lambda: content.setPixelData(QByteArray(bytes([95, 103, 224, 255]) * (180 * 120)), 220, 220, 180, 120))
        self._status("layers-ready", request)
        self._mutate(request, lambda: self.window.addView(doc))
        self._status("view-attached", request)
        # Krita ignores setActiveNode unless this document has the active view.
        self._mutate(request, lambda: doc.setActiveNode(content))
        self._mutate(request, doc.refreshProjection)
        self._wait(request)
        require(doc.activeNode() == content, "PREPARED_LAYER_NOT_ACTIVE")
        self._status("prepare-ready", request)

    def _apply(self, request):
        self._status("apply-start", request)
        if self.document is None:
            self._prepare(request)
        require(self.app.activeDocument() == self.document, "OWNED_DOCUMENT_NOT_ACTIVE")
        self._resolve_work_area_docks()
        values = {o["capabilityId"]: o["value"] for o in request["operations"]}
        desired = {name: portable for name, portable in BINDINGS.values()}
        reserved = set(desired.values())
        for name, action in self.native_actions.items():
            before = shortcuts(action)
            after = [desired[name]] if name in desired else [s for s in before if s not in reserved]
            if before != after:
                self.touched_actions.add(name)
                # Native collection rereads settings on tool changes, but skips
                # actions carrying this native property. Restore it on reset.
                self._mutate(request, lambda a=action: a.setProperty("isShortcutConfigurable", False))
                self._mutate(request, lambda a=action, s=after: a.setShortcuts([QKeySequence(v) for v in s]))
        side = Qt.LeftDockWidgetArea if values["krita.layout.panel-side"] == "left" else Qt.RightDockWidgetArea
        self._mutate(request, lambda: self.layer_dock.setFloating(False))
        self._mutate(request, lambda: self.main.addDockWidget(side, self.layer_dock))
        self._mutate(request, self.layer_dock.show)
        # A finite native toolbar avoids Krita's toolbox re-showing hidden buttons
        # on tool/layer switches. It exposes exactly the three practiced tools.
        if self.simple_toolbar is None:
            def create_owned_toolbar():
                self.simple_toolbar = QToolBar("Lucienne practice tools", self.main)
            self._mutate(request, create_owned_toolbar)
            self._mutate(request, lambda: self.simple_toolbar.setObjectName("LuciennePracticeTools"))
            self._mutate(request, lambda: self.simple_toolbar.setMovable(False))
            for name in desired:
                self._mutate(request, lambda a=self.native_actions[name]: self.simple_toolbar.addAction(a))
            self._mutate(request, lambda: self.main.addToolBar(Qt.LeftToolBarArea, self.simple_toolbar))
        simple = values["krita.tool-layout.density"] == "simple"
        self._mutate(request, lambda: self.toolbox.setVisible(not simple))
        self._mutate(request, lambda: self.simple_toolbar.setVisible(simple))
        self._apply_work_area(request, values["krita.canvas.work-area"], side)
        self._wait(request)
        canvas = self._canvas_widget()
        self._mutate(request, self.main.raise_)
        self._mutate(request, self.main.activateWindow)
        self._mutate(request, lambda: canvas.setFocus(Qt.OtherFocusReason))
        # Native activation/focus events settle on the next ordinary event-loop
        # turn. No processEvents reentrancy and no deferred mutation callback.
        self.committed = {key: request[key] for key in ("runId", "requestId", "generation")}
        self._status("apply-ready", request)

    def _readback(self, request):
        require(self.committed is not None and all(self.committed[k] == request[k] for k in self.committed), "UNCOMMITTED_REQUEST")
        operations = []
        for capability, (name, expected) in BINDINGS.items():
            require(shortcuts(self.native_actions[name]) == [expected], "NATIVE_SHORTCUT_DRIFT")
            conflicts = [a for key, a in self.native_actions.items() if key != name and expected in shortcuts(a) and a.isEnabled()]
            require(not conflicts, "NATIVE_SHORTCUT_CONFLICT")
            operations.append({"capabilityId": capability, "value": CATALOG[capability][0]})
        area = self.main.dockWidgetArea(self.layer_dock)
        require(not self.layer_dock.isHidden() and not self.layer_dock.isFloating() and area in (Qt.LeftDockWidgetArea, Qt.RightDockWidgetArea), "NATIVE_PANEL_DRIFT")
        operations.append({"capabilityId": "krita.layout.panel-side", "value": "left" if area == Qt.LeftDockWidgetArea else "right"})
        require(bool(self.non_key_docks) and self.work_area_measurement is not None, "NATIVE_WORK_AREA_DRIFT")
        visible = [not self.docks[name].isHidden() for name in self.non_key_docks]
        require(all(visible) or not any(visible), "NATIVE_WORK_AREA_DRIFT")
        work_area = "normal" if all(visible) else "large"
        measurement = self.work_area_measurement
        measured_canvas = self._canvas_widget()
        require(work_area == measurement["mode"]
                and [self.main.width(), self.main.height()] == measurement["windowSize"]
                and [measured_canvas.width(), measured_canvas.height()] == measurement[work_area], "NATIVE_WORK_AREA_DRIFT")
        operations.append({"capabilityId": "krita.canvas.work-area", "value": work_area})
        simple = self.toolbox.isHidden() and self.simple_toolbar is not None and not self.simple_toolbar.isHidden()
        full = not self.toolbox.isHidden() and self.simple_toolbar is not None and self.simple_toolbar.isHidden()
        require(simple or full, "NATIVE_TOOLS_DRIFT")
        operations.append({"capabilityId": "krita.tool-layout.density", "value": "simple" if simple else "full"})
        canvas = self._canvas_widget()
        focus = QApplication.focusWidget()
        canvas_focused = focus is not None and (focus == canvas or canvas.isAncestorOf(focus))
        visible = self.main.isVisible() and not self.main.isMinimized() and self.main.isActiveWindow() and canvas.isVisible()
        interactive = visible and canvas_focused and self.main.isEnabled() and canvas.isEnabled() and QApplication.activeModalWidget() is None and self.app.activeDocument() == self.document and self.window.activeView() is not None
        return {"requestId": request["requestId"], "targetVisible": visible, "interactive": interactive, "operations": operations, "evidenceRefs": []}

    def _observe(self):
        result = {"nativeVersion": self.app.version(), "pid": os.getpid(), "baselineFingerprint": self.baseline_fingerprint,
                  "windowVisible": self.main.isVisible(), "windowRect": rect(self.main.geometry()),
                  "docks": [{"id": key, "visible": not d.isHidden(), "rect": rect(d.geometry()), "area": int(self.main.dockWidgetArea(d))} for key, d in self.docks.items()],
                  "bindings": {key: shortcuts(self.native_actions[name]) for key, (name, _) in BINDINGS.items()},
                  "documentCount": len(self.app.documents()), "document": None}
        if self.document is not None:
            doc = self.document
            require(doc.width() <= 2048 and doc.height() <= 2048, "DOCUMENT_TOO_LARGE")
            width, height = doc.width(), doc.height()
            require(len(doc.topLevelNodes()) <= 16, "TOO_MANY_LAYERS")
            layers = [{"layerId": n.uniqueId().toString(), "type": n.type(), "bounds": rect(n.bounds()), "pixelDigest": digest(bytes(n.pixelData(0, 0, width, height)))} for n in doc.topLevelNodes()]
            selection = doc.selection()
            mask = bytes(selection.pixelData(0, 0, width, height)) if selection else b""
            result["document"] = {"width": width, "height": height, "layers": layers,
                                  "projectionDigest": digest(bytes(doc.pixelData(0, 0, width, height))),
                                  "selection": {"present": selection is not None, "selectedPixels": sum(v > 0 for v in mask), "digest": digest(mask),
                                                "bounds": [selection.x(), selection.y(), selection.width(), selection.height()] if selection else None}}
            active = doc.activeNode()
            active_id = active.uniqueId().toString() if active else None
            active_state = next((layer for layer in layers if layer["layerId"] == active_id), None)
            result["taskState"] = dict(active_state, selectionPixels=sum(v > 0 for v in mask), selectionDigest=digest(mask)) if active_state else None
            result["otherLayers"] = {layer["layerId"]: layer["pixelDigest"] for layer in layers if layer["layerId"] != active_id}
        else:
            result["taskState"] = None
            result["otherLayers"] = {}
        result["geometry"] = {"window": result["windowRect"], "docks": result["docks"], "canvas": rect(self._canvas_widget().geometry()) if self.document is not None else None}
        result["workAreaMeasurement"] = dict(self.work_area_measurement) if self.work_area_measurement else None
        return result

    def _restore(self, request):
        require(all(d == self.document for d in self.app.documents()), "UNOWNED_DOCUMENTS_PRESENT")
        self._wait(request)
        if self.document is not None:
            self._mutate(request, lambda: self.document.setModified(False))
            def close_owned_document():
                closed = self.document.close()
                if closed:
                    self.document = None
                return closed
            closed = self._mutate(request, close_owned_document)
            require(closed and not self.app.documents(), "DOCUMENT_CLOSE_FAILED")
        if self.simple_toolbar is not None:
            self._mutate(request, self.simple_toolbar.hide)
            self._mutate(request, lambda: self.main.removeToolBar(self.simple_toolbar))
        for name in self.touched_actions:
            original = self.baseline["actions"][name]
            self._mutate(request, lambda a=self.native_actions[name], s=original: a.setShortcuts([QKeySequence(v) for v in s]))
            self._mutate(request, lambda a=self.native_actions[name], v=self.baseline["configurable"][name]: a.setProperty("isShortcutConfigurable", v))
        restored = self._mutate(request, lambda: self.main.restoreState(QByteArray(self.baseline["state"])))
        for name, state in self.baseline["docks"].items():
            self._mutate(request, lambda d=self.docks[name], s=state: d.setVisible(not s["hidden"]))
        self._guard(request)
        action_match = all(shortcuts(self.native_actions[name]) == self.baseline["actions"][name] and self.native_actions[name].property("isShortcutConfigurable") == self.baseline["configurable"][name] for name in self.touched_actions)
        dock_match = all(d.isHidden() == self.baseline["docks"][name]["hidden"] and int(self.main.dockWidgetArea(d)) == self.baseline["docks"][name]["area"] and d.isFloating() == self.baseline["docks"][name]["floating"] for name, d in self.docks.items())
        self.committed = None
        self.work_area_measurement = None
        return {"documentsClosed": not self.app.documents(), "nativeStateRestored": bool(restored and action_match and dock_match), "baselineFingerprint": self.baseline_fingerprint}
