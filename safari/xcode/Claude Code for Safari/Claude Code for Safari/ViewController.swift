//  ViewController.swift
//  The status window: a small web view fed by the bridge every second.

import Cocoa
import SafariServices
import ServiceManagement
import WebKit

let extensionBundleIdentifier = "com.michaelhelms.claude-code-safari.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!
    private var timer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        if let w = view.window, w.frame.height < 600 {
            w.setContentSize(NSSize(width: 480, height: 640))
            w.center()
        }
    }

    override func viewWillDisappear() { timer?.invalidate(); timer = nil; super.viewWillDisappear() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        push()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.push() }
    }

    private func push() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, _ in
            let b = Bridge.shared
            let instances = b.liveInstances.map { ["tabs": $0.instance.tabs, "reach": $0.instance.reach, "version": $0.instance.version ?? "?"] }
            var login = false
            if #available(macOS 13.0, *) { login = SMAppService.mainApp.status == .enabled }
            let status: [String: Any] = [
                "bridgePort": Int(b.port), "bridgeError": b.lastError ?? "",
                "extensionEnabled": state?.isEnabled ?? false, "extensionKnown": state != nil, "extensionConnected": b.isConnected, "extensionVersion": b.primaryVersion ?? "",
                "instances": instances, "lastClaudeCall": b.lastClaudeCall.map { AppDelegate.ago($0) } ?? "",
                "launchAtLogin": login, "appVersion": Bridge.version,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: status), let text = String(data: data, encoding: .utf8) {
                DispatchQueue.main.async { self.webView.evaluateJavaScript("setStatus(\(text))") }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.body as? String {
        case "open-preferences":
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
        case "copy-command":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("/plugin marketplace add thisismlh/claude-code-safari && /plugin install safari@claude-code-safari", forType: .string)
        case "toggle-login":
            if #available(macOS 13.0, *) {
                let svc = SMAppService.mainApp
                if svc.status == .enabled { try? svc.unregister() } else { try? svc.register() }
            }
        default: break
        }
    }
}
