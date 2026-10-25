// One finite, lease-guarded menu action against the canonical owned Kdenlive.
// Caller serializes the child, revokes cancellation leases, and drains process exit.
import AppKit
import ApplicationServices
import Darwin
import Foundation

private let expectedUID: uid_t = 502
private let expectedBundle = "org.kde.Kdenlive"
private let expectedExecutable = "/PUBLIC_NATIVE_APPS_REQUIRED/kdenlive.app/Contents/MacOS/kdenlive"
private let deadline = ProcessInfo.processInfo.systemUptime + 5.0
private func finish(_ value: [String: Any], code: Int32 = 0) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        FileHandle.standardOutput.write(Data("{\"version\":1,\"ok\":false,\"error\":\"KDENLIVE_MENU_SERIALIZATION\"}\n".utf8)); exit(2)
    }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); exit(code)
}
private func fail(_ code: String) -> Never { finish(["version": 1, "ok": false, "error": code], code: 2) }
private struct ProcessIdentity: Equatable { let uid: uid_t; let seconds: UInt64; let microseconds: UInt64 }
private func identity(_ pid: pid_t) -> ProcessIdentity? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return ProcessIdentity(uid: info.pbi_uid, seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
}
private func validateProcess(_ pid: pid_t) -> ProcessIdentity {
    guard getuid() == expectedUID, geteuid() == expectedUID,
          NSUserName() == "lucienne", NSHomeDirectory() == "/PUBLIC_NATIVE_HOME_REQUIRED" else { fail("KDENLIVE_MENU_WRONG_ACCOUNT") }
    var console = stat()
    guard lstat("/dev/console", &console) == 0, console.st_uid == expectedUID else { fail("KDENLIVE_MENU_WRONG_CONSOLE") }
    guard let process = identity(pid), process.uid == expectedUID else { fail("KDENLIVE_MENU_WRONG_PROCESS_OWNER") }
    var bytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0,
          String(cString: bytes) == expectedExecutable,
          let app = NSRunningApplication(processIdentifier: pid),
          app.bundleIdentifier == expectedBundle, app.executableURL?.path == expectedExecutable,
          !app.isTerminated else { fail("KDENLIVE_MENU_WRONG_PROCESS") }
    return process
}
private func checkTime() {
    if ProcessInfo.processInfo.systemUptime >= deadline { fail("KDENLIVE_MENU_TIMEOUT") }
}
private func validID(_ string: String) -> Bool {
    string.range(of: "^[a-zA-Z0-9._:/-]{1,160}$", options: .regularExpression) != nil
}
private func safePath(_ path: String) -> Bool {
    guard path.hasPrefix("/"), path != "/", URL(fileURLWithPath: path).standardizedFileURL.path == path else { return false }
    var cursor = "/"
    let parts = path.split(separator: "/")
    for part in parts.dropLast() {
        cursor = (cursor as NSString).appendingPathComponent(String(part))
        var info = stat()
        guard lstat(cursor, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else { return false }
    }
    return true
}
private func readOwnedJSON(_ path: String, maxBytes: Int, failure: String) -> Any {
    guard safePath(path) else { fail(failure) }
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { fail(failure) }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == expectedUID, (info.st_mode & 0o022) == 0,
          info.st_size > 0, info.st_size <= maxBytes else { fail(failure) }
    let capacity = maxBytes + 1
    var bytes = [UInt8](repeating: 0, count: capacity)
    var total = 0
    while total < capacity {
        let count = bytes.withUnsafeMutableBytes { raw in
            Darwin.read(descriptor, raw.baseAddress!.advanced(by: total), capacity - total)
        }
        if count == 0 { break }
        if count < 0 { if errno == EINTR { continue }; fail(failure) }
        total += count
    }
    guard total <= maxBytes, let value = try? JSONSerialization.jsonObject(with: Data(bytes.prefix(total))) else { fail(failure) }
    // Reject a file replaced/unlinked during the read; atomic renewals can safely retry.
    var current = stat()
    guard lstat(path, &current) == 0, current.st_dev == info.st_dev, current.st_ino == info.st_ino,
          (current.st_mode & S_IFMT) == S_IFREG else { fail(failure) }
    return value
}

let arguments = Array(CommandLine.arguments.dropFirst())
let allowedKeys: Set<String> = ["--pid", "--lease", "--token", "--run-id", "--request-id", "--generation", "--title", "--allowed-titles", "--checked"]
guard arguments.count % 2 == 0 else { fail("KDENLIVE_MENU_USAGE") }
var options = [String: String]()
for offset in stride(from: 0, to: arguments.count, by: 2) {
    let key = arguments[offset]
    guard allowedKeys.contains(key), options[key] == nil else { fail("KDENLIVE_MENU_USAGE") }
    options[key] = arguments[offset + 1]
}
let required = allowedKeys.subtracting(["--checked"])
guard required.allSatisfy({ options[$0] != nil }) else { fail("KDENLIVE_MENU_USAGE") }
guard let pid = Int32(options["--pid"]!), pid > 1 else { fail("KDENLIVE_MENU_INVALID_PID") }
let token = options["--token"]!, runID = options["--run-id"]!, requestID = options["--request-id"]!
guard token.count >= 16, validID(token), validID(runID), validID(requestID),
      let generation = Int64(options["--generation"]!), generation >= 0, generation <= 9_007_199_254_740_991 else { fail("KDENLIVE_MENU_INVALID_IDENTITY") }
let title = options["--title"]!
guard !title.isEmpty, title.count <= 300, !title.contains("\n"), !title.contains("\r"), !title.contains("\0") else { fail("KDENLIVE_MENU_INVALID_TITLE") }
var desiredChecked: Bool?
if let checked = options["--checked"] {
    guard checked == "true" || checked == "false" else { fail("KDENLIVE_MENU_INVALID_CHECKED") }
    desiredChecked = checked == "true"
}
private let initialIdentity = validateProcess(pid)
let leasePath = options["--lease"]!, titlesPath = options["--allowed-titles"]!
func checkLease() {
    checkTime()
    guard let lease = readOwnedJSON(leasePath, maxBytes: 4096, failure: "KDENLIVE_MENU_LEASE_INVALID") as? [String: Any],
          Set(lease.keys) == Set(["token", "runId", "requestId", "generation", "expiresAt"]),
          lease["token"] as? String == token, lease["runId"] as? String == runID, lease["requestId"] as? String == requestID,
          let actualGeneration = lease["generation"] as? NSNumber,
          CFGetTypeID(actualGeneration) != CFBooleanGetTypeID(), actualGeneration.doubleValue == Double(generation),
          let expiry = lease["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(), expiry.doubleValue.isFinite else {
        fail("KDENLIVE_MENU_LEASE_INVALID")
    }
    let now = Date().timeIntervalSince1970 * 1000
    guard expiry.doubleValue > now, expiry.doubleValue <= now + 2000 else { fail("KDENLIVE_MENU_LEASE_EXPIRED") }
}
checkLease()
guard let titles = readOwnedJSON(titlesPath, maxBytes: 16_384, failure: "KDENLIVE_MENU_ALLOWLIST_INVALID") as? [String],
      !titles.isEmpty, titles.count <= 32, Set(titles).count == titles.count,
      titles.allSatisfy({ !$0.isEmpty && $0.count <= 300 && !$0.contains("\n") && !$0.contains("\r") && !$0.contains("\0") }),
      titles.contains(title) else { fail("KDENLIVE_MENU_TITLE_NOT_ALLOWED") }
guard AXIsProcessTrusted() else { fail("KDENLIVE_MENU_AX_PERMISSION") }
let app = AXUIElementCreateApplication(pid)
guard AXUIElementSetMessagingTimeout(app, 0.20) == .success else { fail("KDENLIVE_MENU_TIMEOUT_SETUP") }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    checkTime()
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if status == .attributeUnsupported || status == .noValue { return nil }
    guard status == .success else { fail("KDENLIVE_MENU_AX_READ_FAILED") }
    return value
}
func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
guard let menu = element(attribute(app, "AXMenuBar")) else { fail("KDENLIVE_MENU_BAR_UNAVAILABLE") }
var pending: [(AXUIElement, Int)] = [(menu, 0)]
var seen = [AXUIElement]()
var matches = [AXUIElement]()
var cursor = 0
while cursor < pending.count {
    checkLease()
    guard pending.count <= 1600 else { fail("KDENLIVE_MENU_TREE_LIMIT") }
    let (node, depth) = pending[cursor]; cursor += 1
    if seen.contains(where: { CFEqual($0, node) }) { continue }
    seen.append(node)
    guard depth <= 24 else { fail("KDENLIVE_MENU_TREE_LIMIT") }
    guard let role = attribute(node, "AXRole") as? String else { fail("KDENLIVE_MENU_AX_READ_FAILED") }
    if role == "AXMenuItem" {
        guard let nodeTitle = attribute(node, "AXTitle") as? String else { fail("KDENLIVE_MENU_AX_READ_FAILED") }
        if nodeTitle == title { matches.append(node) }
    }
    if let raw = attribute(node, "AXChildren"), CFGetTypeID(raw) == CFArrayGetTypeID() {
        let children = raw as! [CFTypeRef]
        guard children.count <= 200 else { fail("KDENLIVE_MENU_TREE_LIMIT") }
        pending.append(contentsOf: children.compactMap(element).map { ($0, depth + 1) })
    }
}
guard matches.count == 1 else { fail(matches.isEmpty ? "KDENLIVE_MENU_NOT_FOUND" : "KDENLIVE_MENU_AMBIGUOUS") }
let target = matches[0]
func checkedState() -> Bool? {
    guard let mark = attribute(target, "AXMenuItemMarkChar") as? String else { return nil }
    return !mark.isEmpty
}
func verifyActionState() -> Bool? {
    guard attribute(target, "AXRole") as? String == "AXMenuItem", attribute(target, "AXTitle") as? String == title,
          let enabled = attribute(target, "AXEnabled"), CFGetTypeID(enabled) == CFBooleanGetTypeID(),
          (enabled as! NSNumber).boolValue else { fail("KDENLIVE_MENU_DISABLED") }
    if desiredChecked != nil {
        guard let current = checkedState() else { fail("KDENLIVE_MENU_CHECKED_UNAVAILABLE") }
        return current
    }
    return nil
}
let _ = verifyActionState()
var actionNames: CFArray?
guard AXUIElementCopyActionNames(target, &actionNames) == .success,
      (actionNames as? [String])?.contains(kAXPressAction as String) == true else { fail("KDENLIVE_MENU_PRESS_UNAVAILABLE") }
// The only mutation follows fresh state, lease and identity checks. Cancellation
// after dispatch cannot retract AXPress; caller must stop the owned app if unsure.
let actualChecked = verifyActionState()
checkLease()
guard validateProcess(pid) == initialIdentity else { fail("KDENLIVE_MENU_PROCESS_REPLACED") }
checkLease()
if let desiredChecked, actualChecked == desiredChecked {
    finish(["version": 1, "ok": true, "performed": false, "reason": "already-matched", "checked": desiredChecked])
}
let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
guard result == .success else { fail("KDENLIVE_MENU_PRESS_FAILED") }
finish(["version": 1, "ok": true, "performed": true])
