import AppKit
import ApplicationServices
import Foundation

// Read-only, fail-closed readiness. Never dismiss an evaluation or permission dialog.
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func blockingTitle(_ title: String) -> Bool {
    let value = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    // REAPER may include EVALUATION LICENSE in the usable main-window title.
    // Never confuse that honest status label with the reminder dialog itself.
    return value.hasPrefix("about reaper") || value == "evaluation license" ||
        value.hasPrefix("reaper license") || value.hasPrefix("reaper registration") ||
        value.hasPrefix("purchase reaper") || value.hasPrefix("audio device settings")
}
#if REAPER_PROBE_TESTS
assert(!blockingTitle("[unsaved project] - REAPER v7.83 - EVALUATION LICENSE"))
assert(blockingTitle("About REAPER v7.83"))
assert(blockingTitle("REAPER Registration"))
print("3 readiness title classification tests passed; no native probe performed")
#else
let args = CommandLine.arguments
guard args.count == 2, let pid = Int32(args[1]), pid > 1 else { exit(64) }
let app = NSRunningApplication(processIdentifier: pid)
let ax = AXUIElementCreateApplication(pid)
let trusted = AXIsProcessTrusted()
let windows = trusted ? attribute(ax, kAXWindowsAttribute) as? [AXUIElement] : nil
let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
let visible = rows?.contains { row in
    guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
          let rect = row[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: rect as CFDictionary) else { return false }
    return bounds.width >= 600 && bounds.height >= 300
} ?? false
let modal = windows?.contains { window in
    let title = attribute(window, kAXTitleAttribute) as? String ?? ""
    let sheets = (attribute(window, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
        (attribute($0, kAXRoleAttribute) as? String) == kAXSheetRole
    }
    return (attribute(window, kAXModalAttribute) as? Bool ?? false) || !sheets.isEmpty ||
        blockingTitle(title)
} ?? true
let focused = trusted ? attribute(ax, kAXFocusedWindowAttribute) : nil
let focusedWindow = focused.map { unsafeBitCast($0, to: AXUIElement.self) }
let focusedStandard = focusedWindow.map {
    guard let raw = attribute($0, kAXSizeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return false }
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgSize, &size) else { return false }
    return (attribute($0, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole &&
        !(attribute($0, kAXMinimizedAttribute) as? Bool ?? true) && size.width >= 600 && size.height >= 300
} ?? false
let executable = app?.executableURL?.path ?? ""
let validApp = app?.bundleIdentifier == "com.cockos.reaper" && executable.hasSuffix("/REAPER.app/Contents/MacOS/REAPER")
let interactive = validApp && trusted && frontmost && visible && !modal && focusedStandard && !(app?.isTerminated ?? true)
let result: [String: Any] = ["protocol": 1, "pid": pid, "targetVisible": validApp && visible,
    "interactive": interactive, "accessibilityTrusted": trusted, "frontmost": frontmost,
    "modal": modal, "focusedStandardWindow": focusedStandard, "windowCount": windows?.count ?? 0]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([10]))
#endif
