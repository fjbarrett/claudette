// Opt-in macOS integration test. Saves every pasteboard item/type in memory;
// never writes the user's clipboard contents to logs or disk.
// Usage: swift scripts/test-native-clipboard.swift /absolute/path/to/node
import AppKit
import Foundation

let board = NSPasteboard.general
let initialCount = board.changeCount
var saved: [[NSPasteboard.PasteboardType: Data]] = []
for item in board.pasteboardItems ?? [] {
    var types: [NSPasteboard.PasteboardType: Data] = [:]
    for type in item.types {
        guard let data = item.data(forType: type) else {
            fatalError("Cannot preserve all clipboard formats; test not started.")
        }
        types[type] = data
    }
    saved.append(types)
}
let marker = "Claudette clipboard test " + UUID().uuidString
let child = Process()
child.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
child.arguments = ["scripts/test-native-clipboard.mjs"]
var env = ProcessInfo.processInfo.environment
env["CLAUDETTE_CLIPBOARD_TEST_MARKER"] = marker
child.environment = env
do {
    try child.run()
    child.waitUntilExit()
} catch {
    print("Could not start clipboard integration test: \(error)")
    exit(1)
}
if board.changeCount != initialCount {
    if board.string(forType: .string)?.hasPrefix(marker) == true {
        let items = saved.map { types -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in types { item.setData(data, forType: type) }
            return item
        }
        board.clearContents()
        if !items.isEmpty && !board.writeObjects(items) {
            print("FAIL: could not restore clipboard.")
            exit(1)
        }
        print("Original clipboard restored (all saved formats).")
    } else {
        print("Clipboard changed externally; leaving the newer clipboard untouched.")
        exit(1)
    }
}
exit(child.terminationStatus)
