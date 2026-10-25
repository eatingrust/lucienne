// Read-only observation of the canonical Kdenlive process. No launch, AX writes,
// synthetic input, permission prompt, or desired-patch input is accepted.
import AppKit
import ApplicationServices
import Darwin
import Foundation

private let expectedUID: uid_t = 502
private let expectedBundle = "org.kde.Kdenlive"
private let expectedExecutable = "/PUBLIC_NATIVE_APPS_REQUIRED/kdenlive.app/Contents/MacOS/kdenlive"
private let maximumNodes = 1800
private let maximumChildren = 200
private let maximumDepth = 24
private let maximumSeconds = 6.0

private func emit(_ value: [String: Any], exitCode: Int32 = 0) -> Never {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard data.count <= 2_000_000 else {
            FileHandle.standardOutput.write(Data("{\"version\":1,\"ok\":false,\"error\":\"KDENLIVE_OBSERVER_OUTPUT_LIMIT\"}\n".utf8))
            exit(2)
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    } catch {
        FileHandle.standardOutput.write(Data("{\"version\":1,\"ok\":false,\"error\":\"KDENLIVE_OBSERVER_SERIALIZATION\"}\n".utf8))
        exit(2)
    }
    exit(exitCode)
}
private func fail(_ code: String) -> Never {
    emit(["version": 1, "ok": false, "error": code], exitCode: 2)
}
private func processPath(_ pid: pid_t) -> String? {
    var bytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let count = proc_pidpath(pid, &bytes, UInt32(bytes.count))
    return count > 0 ? String(cString: bytes) : nil
}
private func processIdentity(_ pid: pid_t) -> (uid: uid_t, startSeconds: UInt64, startMicroseconds: UInt64)? {
    var info = proc_bsdinfo()
    let expected = Int32(MemoryLayout<proc_bsdinfo>.stride)
    let actual = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expected)
    return actual == expected ? (info.pbi_uid, info.pbi_start_tvsec, info.pbi_start_tvusec) : nil
}
private func consoleUID() -> uid_t? {
    var info = stat()
    return lstat("/dev/console", &info) == 0 ? info.st_uid : nil
}
private func validateProcess(_ pid: pid_t) -> NSRunningApplication {
    guard getuid() == expectedUID, geteuid() == expectedUID,
          NSUserName() == "lucienne", NSHomeDirectory() == "/PUBLIC_NATIVE_HOME_REQUIRED" else {
        fail("KDENLIVE_OBSERVER_WRONG_ACCOUNT")
    }
    guard consoleUID() == expectedUID else { fail("KDENLIVE_OBSERVER_WRONG_CONSOLE") }
    guard processIdentity(pid)?.uid == expectedUID else { fail("KDENLIVE_OBSERVER_WRONG_PROCESS_OWNER") }
    guard processPath(pid) == expectedExecutable,
          let application = NSRunningApplication(processIdentifier: pid),
          application.bundleIdentifier == expectedBundle,
          application.executableURL?.path == expectedExecutable,
          !application.isTerminated else { fail("KDENLIVE_OBSERVER_WRONG_PROCESS") }
    return application
}

let args = CommandLine.arguments
if args.count != 3 || args[1] != "--pid" { fail("KDENLIVE_OBSERVER_USAGE") }
guard let pid = Int32(args[2]), pid > 1 else { fail("KDENLIVE_OBSERVER_INVALID_PID") }
let application = validateProcess(pid)
guard let initialIdentity = processIdentity(pid) else { fail("KDENLIVE_OBSERVER_WRONG_PROCESS") }
guard AXIsProcessTrusted() else { fail("KDENLIVE_OBSERVER_AX_PERMISSION") }
let started = ProcessInfo.processInfo.systemUptime
let axApp = AXUIElementCreateApplication(pid)
guard AXUIElementSetMessagingTimeout(axApp, 0.20) == .success else { fail("KDENLIVE_OBSERVER_TIMEOUT_SETUP") }

// AXUIElementSetMessagingTimeout only configures this observer's local messaging
// timeout. It does not mutate the target accessibility tree or application state.
var truncationReasons = Set<String>()
var nodes = [[String: Any]]()
var elements = [AXUIElement]()
var identityBuckets = [CFHashCode: [Int]]()
var queue = [(id: Int, depth: Int)]()
var next = 0
func expired() -> Bool {
    if ProcessInfo.processInfo.systemUptime - started >= maximumSeconds {
        truncationReasons.insert("time-budget")
        return true
    }
    return false
}
func read(_ element: AXUIElement, _ name: String) -> (CFTypeRef?, AXError) {
    if expired() { return (nil, .cannotComplete) }
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (value, error)
}
func scalar(_ value: CFTypeRef) -> Any? {
    let type = CFGetTypeID(value)
    if type == CFBooleanGetTypeID() { return (value as! NSNumber).boolValue }
    if type == CFNumberGetTypeID() {
        let number = value as! NSNumber
        return number.doubleValue.isFinite ? number : nil
    }
    if type == CFStringGetTypeID() { return String((value as! String).prefix(2000)) }
    if type == CFURLGetTypeID() { return (value as! URL).absoluteString }
    if type == AXValueGetTypeID() {
        let ax = value as! AXValue
        switch AXValueGetType(ax) {
        case .cgPoint:
            var p = CGPoint.zero
            if AXValueGetValue(ax, .cgPoint, &p), p.x.isFinite, p.y.isFinite { return ["x": p.x, "y": p.y] }
        case .cgSize:
            var s = CGSize.zero
            if AXValueGetValue(ax, .cgSize, &s), s.width.isFinite, s.height.isFinite { return ["width": s.width, "height": s.height] }
        case .cgRect:
            var r = CGRect.zero
            if AXValueGetValue(ax, .cgRect, &r), r.origin.x.isFinite, r.origin.y.isFinite,
               r.width.isFinite, r.height.isFinite {
                return ["x": r.origin.x, "y": r.origin.y, "width": r.width, "height": r.height]
            }
        case .cfRange:
            var range = CFRange(location: 0, length: 0)
            if AXValueGetValue(ax, .cfRange, &range) { return ["location": range.location, "length": range.length] }
        default: break
        }
    }
    return nil
}
func register(_ element: AXUIElement, depth: Int) -> Int? {
    let hash = CFHash(element)
    for index in identityBuckets[hash] ?? [] {
        if CFEqual(elements[index], element) { return index }
    }
    guard elements.count < maximumNodes else { truncationReasons.insert("node-limit"); return nil }
    guard depth <= maximumDepth else { truncationReasons.insert("depth-limit"); return nil }
    let id = elements.count
    elements.append(element)
    nodes.append(["id": id, "depth": depth])
    identityBuckets[hash, default: []].append(id)
    queue.append((id, depth))
    return id
}
func elementValue(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func childValues(_ value: CFTypeRef?) -> [AXUIElement] {
    guard let value, CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
    return (value as! [CFTypeRef]).compactMap(elementValue)
}
let appID = register(axApp, depth: 0)!
let (windowValue, windowsError) = read(axApp, "AXWindows")
guard windowsError == .success else { fail("KDENLIVE_OBSERVER_AX_WINDOWS_UNAVAILABLE") }
let windowIDs = childValues(windowValue).compactMap { register($0, depth: 1) }
let (menuValue, _) = read(axApp, "AXMenuBar")
let menuID = elementValue(menuValue).flatMap { register($0, depth: 1) }
let (focusedValue, _) = read(axApp, "AXFocusedUIElement")
let focusedID = elementValue(focusedValue).flatMap { register($0, depth: 1) }
let (focusedWindowValue, _) = read(axApp, "AXFocusedWindow")
let focusedWindowID = elementValue(focusedWindowValue).flatMap { register($0, depth: 1) }

let attributes: [(String, String)] = [
    ("AXRole", "role"), ("AXSubrole", "subrole"), ("AXIdentifier", "identifier"),
    ("AXTitle", "title"), ("AXDescription", "description"), ("AXHelp", "help"),
    ("AXValue", "value"), ("AXEnabled", "enabled"), ("AXFocused", "focused"),
    ("AXMain", "main"), ("AXModal", "modal"), ("AXSelected", "selected"),
    ("AXExpanded", "expanded"), ("AXMinimized", "minimized"),
    ("AXPosition", "position"), ("AXSize", "size"), ("AXDocument", "document"),
    ("AXMenuItemCmdChar", "menuCommandCharacter"), ("AXMenuItemCmdVirtualKey", "menuCommandVirtualKey"),
    ("AXMenuItemCmdGlyph", "menuCommandGlyph"), ("AXMenuItemCmdModifiers", "menuCommandModifiers"),
    ("AXMenuItemMarkChar", "menuMarkCharacter")
]
while next < queue.count && !expired() {
    let (id, depth) = queue[next]
    next += 1
    let element = elements[id]
    var node = nodes[id]
    var errors = [String: Int32]()
    for (attribute, key) in attributes {
        let (raw, status) = read(element, attribute)
        if status == .success, let raw, let value = scalar(raw) { node[key] = value }
        else if status != .attributeUnsupported && status != .noValue { errors[key] = status.rawValue }
        if expired() { break }
    }
    let (rawChildren, status) = read(element, "AXChildren")
    if status == .success {
        let children = childValues(rawChildren)
        if children.count > maximumChildren { truncationReasons.insert("children-limit") }
        node["children"] = children.prefix(maximumChildren).compactMap { register($0, depth: depth + 1) }
    } else if status != .attributeUnsupported && status != .noValue { errors["children"] = status.rawValue }
    if !errors.isEmpty { node["attributeErrors"] = errors }
    nodes[id] = node
}
if next < queue.count { truncationReasons.insert("unfinished-nodes") }

// Read from the Window Server separately from AX. AX window presence alone is
// not visibility, readiness, or proof that a shortcut/action has been applied.
let rawWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var serverWindows = [[String: Any]]()
for window in rawWindows {
    guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { continue }
    var record: [String: Any] = [:]
    for (source, destination) in [(kCGWindowNumber as String, "id"), (kCGWindowIsOnscreen as String, "onScreen"),
                                  (kCGWindowLayer as String, "layer"), (kCGWindowAlpha as String, "alpha"),
                                  (kCGWindowBounds as String, "bounds")] {
        if let value = window[source] { record[destination] = value }
    }
    serverWindows.append(record)
}
// Recheck identity/account after the bounded read. A logout, PID replacement or
// target exit invalidates the snapshot instead of emitting stale native evidence.
let finalApplication = validateProcess(pid)
guard let finalIdentity = processIdentity(pid),
      finalIdentity.startSeconds == initialIdentity.startSeconds,
      finalIdentity.startMicroseconds == initialIdentity.startMicroseconds else { fail("KDENLIVE_OBSERVER_PROCESS_REPLACED") }
var roots: [String: Any] = ["application": appID, "windows": windowIDs]
if let menuID { roots["menuBar"] = menuID }
if let focusedID { roots["focusedElement"] = focusedID }
if let focusedWindowID { roots["focusedWindow"] = focusedWindowID }
emit([
    "version": 1, "ok": true, "observedAt": ISO8601DateFormatter().string(from: Date()),
    "pid": pid, "uid": expectedUID, "consoleUid": expectedUID,
    "bundleId": expectedBundle, "executable": expectedExecutable,
    "app": ["active": finalApplication.isActive, "hidden": finalApplication.isHidden, "terminated": finalApplication.isTerminated],
    "windowServer": serverWindows, "roots": roots, "nodes": nodes,
    "truncated": !truncationReasons.isEmpty, "reasons": truncationReasons.sorted(),
    "durationMs": (ProcessInfo.processInfo.systemUptime - started) * 1000
])
