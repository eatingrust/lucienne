import AppKit
import CoreGraphics
import Darwin
import Foundation
import SystemConfiguration

// PID-only mode is read-only. Explicit --activate mode may unhide/activate only the validated owned Blender PID.
// No screenshots, Apple Events, window titles or prompts; activation acknowledgement never proves visibility.
private let bundleID = "org.blenderfoundation.blender"
private let windowLimit = 64

private func username(_ uid: uid_t) -> String? {
    guard let entry = getpwuid(uid), let name = entry.pointee.pw_name else { return nil }
    return String(cString: name)
}

private func demoAccountActive() -> Bool {
    let uid = getuid()
    let realUser = username(uid)
    let effectiveUser = username(geteuid())
    var consoleUID: uid_t = 0
    var consoleGID: gid_t = 0
    let consoleUser = SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID) as String?
    let console = try? FileManager.default.attributesOfItem(atPath: "/dev/console")
    let deviceUID = (console?[.ownerAccountID] as? NSNumber)?.uint32Value
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    return uid != 0 && uid == geteuid() && realUser == "lucienne" && effectiveUser == "lucienne" &&
        consoleUser == "lucienne" && consoleUID == uid && deviceUID == uid &&
        session?[kCGSessionOnConsoleKey as String] as? Bool == true &&
        session?[kCGSessionLoginDoneKey as String] as? Bool == true
}

private struct Window: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let layer: Int
    let alpha: Double
    let onScreen: Bool

    init?(_ row: [String: Any]) {
        guard let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue,
              let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue,
              let onScreen = row[kCGWindowIsOnscreen as String] as? Bool,
              [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy({ $0.isFinite }),
              abs(rect.origin.x) <= 100_000, abs(rect.origin.y) <= 100_000,
              rect.width >= 0, rect.height >= 0, rect.width <= 100_000, rect.height <= 100_000,
              alpha.isFinite, alpha >= 0, alpha <= 1, abs(layer) <= 100_000 else { return nil }
        self.x = Double(rect.origin.x); self.y = Double(rect.origin.y)
        self.width = Double(rect.width); self.height = Double(rect.height)
        self.layer = layer; self.alpha = alpha; self.onScreen = onScreen
    }
    var usable: Bool { layer == 0 && alpha > 0 && onScreen && width >= 320 && height >= 240 }
}

private struct Observation: Encodable {
    let pid: Int32
    let bundleId: String
    let active: Bool
    let hidden: Bool
    let visible: Bool
    let windowCount: Int
    let windows: [Window]
}

private func fail(_ code: String, _ status: Int32) -> Never {
    FileHandle.standardError.write(Data((code + "\n").utf8))
    exit(status)
}

private struct ProbeArguments {
    let pid: Int32
    let activate: Bool
}
private func parseArguments(_ arguments: [String]) -> ProbeArguments? {
    let activate = arguments.count == 2 && arguments[0] == "--activate"
    guard arguments.count == 1 || activate, let raw = arguments.last,
          raw.range(of: "^[1-9][0-9]{0,9}$", options: .regularExpression) != nil,
          let pid = Int32(raw), pid > 0 else { return nil }
    return ProbeArguments(pid: pid, activate: activate)
}

#if !BLENDER_WINDOW_PROBE_TESTS
@main
private struct BlenderWindowProbe {
    static func main() {
        guard let arguments = parseArguments(Array(CommandLine.arguments.dropFirst())) else {
            fail("BLENDER_WINDOW_PID_REQUIRED", 64)
        }
        let pid = arguments.pid
        guard demoAccountActive() else { fail("BLENDER_WINDOW_DEMO_ACCOUNT_REQUIRED", 77) }
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.bundleIdentifier == bundleID else { fail("BLENDER_WINDOW_PROCESS_UNAVAILABLE", 69) }
        if arguments.activate {
            // Recheck immediately before each GUI mutation. Only this already-validated PID is eligible.
            guard demoAccountActive(), !app.isTerminated, app.bundleIdentifier == bundleID else {
                fail("BLENDER_WINDOW_CONTEXT_CHANGED", 77)
            }
            _ = app.unhide()
            guard demoAccountActive(), !app.isTerminated, app.bundleIdentifier == bundleID else {
                fail("BLENDER_WINDOW_CONTEXT_CHANGED", 77)
            }
            _ = app.activate(options: [.activateIgnoringOtherApps])
        }
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              rows.count <= 2048 else { fail("BLENDER_WINDOW_INVENTORY_UNAVAILABLE", 69) }
        var windows: [Window] = []
        for row in rows {
            guard let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else {
                fail("BLENDER_WINDOW_METADATA_INCOMPLETE", 69)
            }
            if owner != pid { continue }
            guard windows.count < windowLimit, let window = Window(row) else {
                fail("BLENDER_WINDOW_METADATA_INCOMPLETE", 69)
            }
            windows.append(window)
        }
        guard demoAccountActive(), !app.isTerminated, app.bundleIdentifier == bundleID else {
            fail("BLENDER_WINDOW_CONTEXT_CHANGED", 77)
        }
        let active = app.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        let hidden = app.isHidden
        let observation = Observation(pid: pid, bundleId: bundleID, active: active, hidden: hidden,
            visible: active && !hidden && windows.contains(where: { $0.usable }), windowCount: windows.count, windows: windows)
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(observation)
            guard data.count <= 32_768 else { fail("BLENDER_WINDOW_OUTPUT_TOO_LARGE", 70) }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        } catch { fail("BLENDER_WINDOW_ENCODING_FAILED", 70) }
    }
}

#else
// Compile with BLENDER_WINDOW_PROBE_TESTS to test fixed CLI parsing without touching native UI.
@main
private struct BlenderWindowProbeArgumentTests {
    static func main() {
        assert(parseArguments(["123"])?.pid == 123)
        assert(parseArguments(["123"])?.activate == false)
        assert(parseArguments(["--activate", "123"])?.activate == true)
        for invalid in [[], ["--activate"], ["--quit", "123"], ["--activate", "123", "extra"],
                        ["0"], ["-1"], ["+1"], ["123 ", "extra"], ["2147483648"], ["123;open"]] {
            assert(parseArguments(invalid) == nil)
        }
        print("Blender window helper: 13 CLI parsing assertions passed; no native probe or activation executed")
    }
}
#endif
