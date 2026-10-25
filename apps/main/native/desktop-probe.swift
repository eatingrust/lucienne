import AppKit
import CoreGraphics
import Darwin
import Foundation
import SystemConfiguration

// Fixed helper: no shell commands, Apple Events, capture, window titles, or app quits.
// A successful activation request is NOT evidence that the desktop is visible.
let desktopProbeProtocolVersion = 1
let desktopProbeWindowLimit = 128
let desktopProbeScreenLimit = 8

struct AccountSnapshot: Codable {
    let realUID: UInt32
    let effectiveUID: UInt32
    let realUser: String?
    let effectiveUser: String?
    let consoleUser: String?
    let consoleUID: UInt32?
    let consoleDeviceUID: UInt32?
    let onConsole: Bool?
    let loginDone: Bool?
}

func permitsFinderActivation(_ value: AccountSnapshot) -> Bool {
    value.realUID != 0 && value.realUID == value.effectiveUID &&
        value.realUser == "lucienne" && value.effectiveUser == "lucienne" &&
        value.consoleUser == "lucienne" && value.consoleUID == value.realUID &&
        value.consoleDeviceUID == value.realUID && value.onConsole == true &&
        value.loginDone == true
}

private func username(_ uid: uid_t) -> String? {
    guard let entry = getpwuid(uid), let name = entry.pointee.pw_name else { return nil }
    return String(String(cString: name).prefix(128))
}

func readAccountSnapshot() -> AccountSnapshot {
    let realUID = getuid()
    let effectiveUID = geteuid()
    // Copy immediately: getpwuid may reuse its storage on a subsequent call.
    let realUser = username(realUID)
    let effectiveUser = username(effectiveUID)
    var consoleUID: uid_t = 0
    var consoleGID: gid_t = 0
    let consoleUser = SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID) as String?
    let consoleAttributes = try? FileManager.default.attributesOfItem(atPath: "/dev/console")
    let consoleDeviceUID = (consoleAttributes?[.ownerAccountID] as? NSNumber)?.uint32Value
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    return AccountSnapshot(
        realUID: realUID, effectiveUID: effectiveUID, realUser: realUser,
        effectiveUser: effectiveUser, consoleUser: consoleUser.map { String($0.prefix(128)) },
        consoleUID: consoleUser == nil ? nil : consoleUID, consoleDeviceUID: consoleDeviceUID,
        onConsole: session?[kCGSessionOnConsoleKey as String] as? Bool,
        loginDone: session?[kCGSessionLoginDoneKey as String] as? Bool
    )
}

struct ProbeRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init?(_ rect: CGRect) {
        let values = [rect.origin.x, rect.origin.y, rect.width, rect.height]
        guard values.allSatisfy({ $0.isFinite }), rect.width >= 0, rect.height >= 0 else { return nil }
        x = Double(rect.origin.x); y = Double(rect.origin.y)
        width = Double(rect.width); height = Double(rect.height)
    }
}

struct WindowSnapshot: Codable {
    let windowID: UInt32?
    let ownerPID: Int32?
    let ownerBundleID: String?
    let ownerActivationPolicy: Int?
    let ownerSystemRole: String?
    let layer: Int?
    let alpha: Double?
    let onScreen: Bool?
    let boundsCG: ProbeRect?
    let requiredMetadataComplete: Bool
}

// Resolve identity through the kernel's executable path, never a window title,
// process display name, or hard-coded PID. These executables live on macOS's
// system volume; unknown owners remain ordinary potential obstructions.
func systemWindowRole(executablePath: String) -> String? {
    switch executablePath {
    case "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
         "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer":
        return "window-server"
    case "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock":
        return "dock"
    default: return nil
    }
}

private func systemWindowRole(pid: pid_t) -> String? {
    // PROC_PIDPATHINFO_MAXSIZE is a C expression macro (4 * MAXPATHLEN),
    // which Swift does not import directly.
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard count > 0 else { return nil }
    return systemWindowRole(executablePath: String(cString: buffer))
}

struct WindowInventory: Codable {
    let available: Bool
    let totalCount: Int
    let truncated: Bool
    let windows: [WindowSnapshot]
}

func readWindows(_ options: CGWindowListOption) -> WindowInventory {
    guard let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return WindowInventory(available: false, totalCount: 0, truncated: false, windows: [])
    }
    let windows = rows.prefix(desktopProbeWindowLimit).map { row -> WindowSnapshot in
        let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value
        let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        let owner = pid.flatMap { NSRunningApplication(processIdentifier: $0) }
        let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue
        let rawAlpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue
        let alpha = rawAlpha.flatMap { $0.isFinite && $0 >= 0 && $0 <= 1 ? $0 : nil }
        let onScreen = row[kCGWindowIsOnscreen as String] as? Bool
        let rect = (row[kCGWindowBounds as String] as? [String: Any]).flatMap {
            CGRect(dictionaryRepresentation: $0 as CFDictionary)
        }.flatMap(ProbeRect.init)
        return WindowSnapshot(
            windowID: id, ownerPID: pid,
            ownerBundleID: owner?.bundleIdentifier.map { String($0.prefix(200)) },
            ownerActivationPolicy: owner?.activationPolicy.rawValue,
            ownerSystemRole: pid.flatMap { systemWindowRole(pid: $0) }, layer: layer,
            alpha: alpha, onScreen: onScreen, boundsCG: rect,
            requiredMetadataComplete: id != nil && pid != nil && layer != nil &&
                alpha != nil && onScreen != nil && rect != nil
        )
    }
    return WindowInventory(available: true, totalCount: rows.count,
                           truncated: rows.count > desktopProbeWindowLimit, windows: windows)
}

struct ScreenSnapshot: Codable {
    let displayID: UInt32?
    let boundsCG: ProbeRect?
    let frameAppKit: ProbeRect?
    let visibleFrameAppKit: ProbeRect?
}

struct ProbeResult: Encodable {
    let protocolVersion = desktopProbeProtocolVersion
    let operation = "probe"
    let observedAt: String
    let osVersion: String
    let helperPID: Int32
    let account: AccountSnapshot
    let finderActivationAllowed: Bool
    let frontmostPID: Int32?
    let frontmostBundleID: String?
    let finderPIDs: [Int32]
    let screenCount: Int
    let screensTruncated: Bool
    let screens: [ScreenSnapshot]
    let windowLevels: [String: Int32]
    let includingDesktop: WindowInventory
    let excludingDesktop: WindowInventory
}

func probe() -> ProbeResult {
    let account = readAccountSnapshot()
    let front = NSWorkspace.shared.frontmostApplication
    let screens = NSScreen.screens
    return ProbeResult(
        observedAt: ISO8601DateFormatter().string(from: Date()),
        osVersion: ProcessInfo.processInfo.operatingSystemVersionString, helperPID: getpid(),
        account: account, finderActivationAllowed: permitsFinderActivation(account),
        frontmostPID: front?.processIdentifier,
        frontmostBundleID: front?.bundleIdentifier.map { String($0.prefix(200)) },
        finderPIDs: Array(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder")
            .prefix(8).map(\.processIdentifier)),
        screenCount: screens.count, screensTruncated: screens.count > desktopProbeScreenLimit,
        screens: screens.prefix(desktopProbeScreenLimit).map { screen in
            let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
            return ScreenSnapshot(displayID: id, boundsCG: id.flatMap { ProbeRect(CGDisplayBounds($0)) },
                frameAppKit: ProbeRect(screen.frame), visibleFrameAppKit: ProbeRect(screen.visibleFrame))
        },
        windowLevels: [
            "desktop": CGWindowLevelForKey(.desktopWindow),
            "desktopIcon": CGWindowLevelForKey(.desktopIconWindow),
            "normal": CGWindowLevelForKey(.normalWindow),
            "floating": CGWindowLevelForKey(.floatingWindow),
            "dock": CGWindowLevelForKey(.dockWindow),
            "mainMenu": CGWindowLevelForKey(.mainMenuWindow),
            "status": CGWindowLevelForKey(.statusWindow),
            "cursor": CGWindowLevelForKey(.cursorWindow),
        ],
        includingDesktop: readWindows([.optionOnScreenOnly]),
        excludingDesktop: readWindows([.optionOnScreenOnly, .excludeDesktopElements])
    )
}

struct OperationResult: Encodable {
    let protocolVersion = desktopProbeProtocolVersion
    let operation: String
    let ok: Bool
    let code: String
    let activationRequested: Bool
    // Intentionally no desktopVisible property: the caller must probe afterward.
}

func emitJSON<T: Encodable>(_ value: T) {
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard data.count <= 262_144 else { throw NSError(domain: "DesktopProbe", code: 1) }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    } catch {
        FileHandle.standardError.write(Data("DESKTOP_PROBE_ENCODING_FAILED\n".utf8))
        exit(70)
    }
}

func runDesktopHelper(arguments: [String]) -> Int32 {
    guard arguments.count == 1, arguments[0] == "probe" || arguments[0] == "activate-finder" else {
        emitJSON(OperationResult(operation: "invalid", ok: false, code: "INVALID_OPERATION", activationRequested: false))
        return 64
    }
    if arguments[0] == "probe" {
        emitJSON(probe())
        return 0
    }
    guard permitsFinderActivation(readAccountSnapshot()) else {
        emitJSON(OperationResult(operation: "activate-finder", ok: false,
                                 code: "DEDICATED_ACCOUNT_REQUIRED", activationRequested: false))
        return 77
    }
    let finders = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder")
    guard finders.count == 1, let finder = finders.first, !finder.isTerminated else {
        emitJSON(OperationResult(operation: "activate-finder", ok: false, code: "FINDER_UNAVAILABLE", activationRequested: false))
        return 69
    }
    // Recheck immediately before the only GUI mutation, including console-device UID.
    guard permitsFinderActivation(readAccountSnapshot()) else {
        emitJSON(OperationResult(operation: "activate-finder", ok: false,
                                 code: "CONSOLE_CHANGED", activationRequested: false))
        return 77
    }
    let requested = finder.activate(options: [])
    emitJSON(OperationResult(operation: "activate-finder", ok: requested,
        code: requested ? "ACTIVATION_REQUESTED" : "ACTIVATION_REJECTED", activationRequested: requested))
    return requested ? 0 : 69
}

#if !DESKTOP_PROBE_TESTS
@main
struct DesktopProbeMain {
    static func main() {
        exit(runDesktopHelper(arguments: Array(CommandLine.arguments.dropFirst())))
    }
}
#endif
