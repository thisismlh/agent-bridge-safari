//  AppDelegate.swift
//  Claude Code for Safari: hosts the bridge, keeps running in the background, and
//  shows status in a window and a menu bar item.

import Cocoa
import SafariServices
import ServiceManagement

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var refresh: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Bridge.shared.start()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "safari", accessibilityDescription: "Claude Code for Safari")
        item.menu = buildMenu()
        statusItem = item
        refresh = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.statusItem?.menu = self?.buildMenu() }
        // Launched hidden by Claude Code (`open -g`): stay out of the way.
        if ProcessInfo.processInfo.arguments.contains("--background") { NSApp.setActivationPolicy(.accessory) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let b = Bridge.shared
        let bridgeLine = b.lastError.map { "Bridge: failed (\($0))" } ?? "Bridge: listening on port \(b.port)"
        let extLine = b.isConnected ? "Extension: connected (v\(b.primaryVersion ?? "?"))" : "Extension: not connected"
        let claudeLine = b.lastClaudeCall.map { "Claude Code: last call \(Self.ago($0))" } ?? "Claude Code: no calls yet"
        for line in [bridgeLine, extLine, claudeLine] { let i = NSMenuItem(title: line, action: nil, keyEquivalent: ""); i.isEnabled = false; menu.addItem(i) }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open Safari Extension Settings…", action: #selector(openSafariSettings), keyEquivalent: "")
        menu.addItem(withTitle: "Show Status Window", action: #selector(showWindowAction), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Claude Code for Safari", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    static func ago(_ d: Date) -> String {
        let s = Int(Date().timeIntervalSince(d))
        return s < 60 ? "\(s) s ago" : s < 3600 ? "\(s / 60) min ago" : "\(s / 3600) h ago"
    }

    @objc func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
    }
    @objc func showWindowAction() { showWindow() }

    private func showWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if NSApp.windows.first(where: { $0.isVisible }) == nil {
            let sb = NSStoryboard(name: "Main", bundle: nil)
            if let wc = sb.instantiateInitialController() as? NSWindowController { wc.showWindow(nil) }
        }
    }
}
