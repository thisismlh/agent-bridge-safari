//  MCPServer.swift
//  `Agent Bridge for Safari --mcp` runs this: a Model Context Protocol server over stdio
//  that any MCP client (Claude Code, Codex CLI, Cursor, Zed, ...) can launch. It pairs
//  with the running app (launching it if needed) and turns MCP tool calls into bridge
//  commands, the same ones the Claude Code plugin sends.

import AppKit
import Foundation

final class MCPServer {
    private let token: String
    private var base: String? = nil
    private let out = FileHandle.standardOutput
    private let session = URLSession(configuration: .ephemeral)
    private let ports = (Bridge.preferredPort..<(Bridge.preferredPort + 10)).map { Int($0) }
    private let inflight = DispatchGroup()
    private let writeLock = NSLock()

    init() {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: stdio loop (newline-delimited JSON-RPC)

    func run() -> Never {
        let input = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { _ = inflight.wait(timeout: .now() + 120); exit(0) } // drain calls still running
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                guard !line.isEmpty, let msg = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                handle(msg)
            }
        }
    }

    private func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        writeLock.lock(); defer { writeLock.unlock() }
        out.write(data); out.write(Data([0x0A]))
    }
    private func reply(_ id: Any, result: Any) { send(["jsonrpc": "2.0", "id": id, "result": result]) }
    private func fail(_ id: Any, _ code: Int, _ message: String) { send(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]) }

    private func handle(_ msg: [String: Any]) {
        let method = msg["method"] as? String ?? ""
        let params = msg["params"] as? [String: Any] ?? [:]
        guard let id = msg["id"] else { return } // notifications need no answer
        switch method {
        case "initialize":
            reply(id, result: ["protocolVersion": params["protocolVersion"] as? String ?? "2025-06-18",
                               "capabilities": ["tools": [:]],
                               "serverInfo": ["name": "agent-bridge-safari", "version": Bridge.version],
                               "instructions": "Tools that read and drive Safari tabs on this Mac through the Agent Bridge for Safari app. Call tabs_context first; prefer read_page over screenshots."])
        case "ping": reply(id, result: [:])
        case "tools/list": reply(id, result: ["tools": MCPTools.list])
        case "tools/call":
            let name = params["name"] as? String ?? ""
            let args = params["arguments"] as? [String: Any] ?? [:]
            inflight.enter()
            DispatchQueue.global().async { [self] in
                defer { inflight.leave() }
                do { reply(id, result: try MCPTools.call(name, args, bridge: self)) }
                catch { reply(id, result: ["content": [["type": "text", "text": error.localizedDescription]], "isError": true]) }
            }
        default: fail(id, -32601, "Method not found: \(method)")
        }
    }

    // MARK: bridge client

    struct BridgeError: LocalizedError { let message: String; var errorDescription: String? { message } }

    private func request(_ base: String, _ path: String, body: [String: Any]?, timeout: TimeInterval) throws -> (Int, [String: Any], [String: String]) {
        var req = URLRequest(url: URL(string: base + path)!, timeoutInterval: timeout)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let sem = DispatchSemaphore(value: 0)
        var result: (Int, [String: Any], [String: String]) = (0, [:], [:])
        var failure: Error? = nil
        session.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            if let err { failure = err; return }
            let http = resp as? HTTPURLResponse
            var headers: [String: String] = [:]
            for (k, v) in http?.allHeaderFields ?? [:] { headers[String(describing: k).lowercased()] = String(describing: v) }
            let json = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
            result = (http?.statusCode ?? 0, json, headers)
        }.resume()
        sem.wait()
        if let failure { throw failure }
        return result
    }

    private func findBridge(pair: Bool) -> String? {
        for port in ports {
            let b = "http://127.0.0.1:\(port)"
            guard let (status, _, headers) = try? request(b, "/status", body: nil, timeout: 1.5), headers["x-claude-bridge"] == "1" else { continue }
            if status == 200 { return b }
            if status == 403 && pair {
                pairWithApp()
                for _ in 0..<8 {
                    Thread.sleep(forTimeInterval: 0.25)
                    if let (s, _, _) = try? request(b, "/status", body: nil, timeout: 1.5), s == 200 { return b }
                }
            }
        }
        return nil
    }

    private func pairWithApp() {
        if let url = URL(string: "agentbridge://pair?token=\(token)") { NSWorkspace.shared.open(url) }
    }

    private func ensureBridge() throws -> String {
        if let base, (try? request(base, "/status", body: nil, timeout: 1.5))?.0 == 200 { return base }
        if let found = findBridge(pair: true) { base = found; return found }
        // Launch the app hidden, pair, and wait.
        if let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.michaelhelms.agent-bridge-safari") {
            let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = false; cfg.arguments = ["--background"]
            let sem = DispatchSemaphore(value: 0)
            NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { _, _ in sem.signal() }
            sem.wait()
            Thread.sleep(forTimeInterval: 1.5)
            for _ in 0..<16 {
                if let found = findBridge(pair: true) { base = found; return found }
                Thread.sleep(forTimeInterval: 0.25)
            }
        }
        throw BridgeError(message: "Agent Bridge for Safari is not running and could not be launched. Install the app from https://github.com/thisismlh/agent-bridge-safari and open it once.")
    }

    func command(_ name: String, _ params: [String: Any] = [:], timeoutMs: Int = 60_000) throws -> Any {
        let base = try ensureBridge()
        let (status, json, _) = try request(base, "/call", body: ["name": name, "params": params, "timeoutMs": timeoutMs], timeout: TimeInterval(timeoutMs) / 1000 + 5)
        if let err = json["error"] as? String {
            if status == 503 { throw BridgeError(message: "Safari extension is not connected. Open Agent Bridge for Safari and turn the extension on in Safari > Settings > Extensions.") }
            throw BridgeError(message: err)
        }
        return json["result"] ?? NSNull()
    }
    func page(_ tabId: Any?, _ fn: String, _ args: Any) throws -> Any {
        var p: [String: Any] = ["fn": fn, "args": args]
        if let t = tabId { p["tabId"] = t }
        return try command("page", p)
    }
}

// MARK: - Tools (same names and inputs as the Claude Code plugin)

enum MCPTools {
    static let tab: [String: Any] = ["tabId": ["type": "string", "description": "Tab id from tabs_context. Omit for the current tab."]]
    static let ref: [String: Any] = ["ref": ["type": "string", "description": "Element ref such as \"ref_12\" from read_page or find."]]
    static func schema(_ props: [String: Any], required: [String] = []) -> [String: Any] {
        var s: [String: Any] = ["type": "object", "properties": props]; if !required.isEmpty { s["required"] = required }; return s
    }
    static func merge(_ a: [String: Any]...) -> [String: Any] { a.reduce(into: [:]) { $0.merge($1) { _, n in n } } }

    static let list: [[String: Any]] = [
        ["name": "tabs_context", "description": "List Safari tabs with tabId, url, title and which tab is active.", "inputSchema": schema([:])],
        ["name": "tabs_create", "description": "Open a new Safari tab, optionally at a URL. Returns its tabId.", "inputSchema": schema(["url": ["type": "string"]])],
        ["name": "tabs_close", "description": "Close a Safari tab by tabId.", "inputSchema": schema(tab, required: ["tabId"])],
        ["name": "navigate", "description": "Load a URL in a tab, or go \"back\", \"forward\" or \"reload\". Waits for the page to load.", "inputSchema": schema(merge(["url": ["type": "string"]], tab), required: ["url"])],
        ["name": "read_page", "description": "Read the page as an accessibility tree; interactive elements carry a [ref_N] for click, type, form_input, scroll, hover and upload_file. Prefer this over screenshots.", "inputSchema": schema(merge(tab, ["filter": ["type": "string", "enum": ["all", "interactive"]], "ref": ["type": "string"], "max_chars": ["type": "number"], "depth": ["type": "number"]]))],
        ["name": "find", "description": "Search the page for elements whose role, name, value or href contains the query. Returns refs.", "inputSchema": schema(merge(["query": ["type": "string"]], tab), required: ["query"])],
        ["name": "get_page_text", "description": "Extract the visible text of the page.", "inputSchema": schema(merge(tab, ["max_chars": ["type": "number"]]))],
        ["name": "click", "description": "Click an element by ref, or a point in viewport CSS pixels.", "inputSchema": schema(merge(ref, tab, ["x": ["type": "number"], "y": ["type": "number"], "count": ["type": "number"], "button": ["type": "string", "enum": ["left", "right"]], "modifiers": ["type": "string"]]))],
        ["name": "hover", "description": "Hover an element by ref or coordinates.", "inputSchema": schema(merge(ref, tab, ["x": ["type": "number"], "y": ["type": "number"]]))],
        ["name": "type", "description": "Type text into the focused element or the element given by ref.", "inputSchema": schema(merge(["text": ["type": "string"], "replace": ["type": "boolean"]], ref, tab), required: ["text"])],
        ["name": "press_key", "description": "Press Enter, Tab or Escape in the page (e.g. \"Return\", \"Tab\", \"Escape\").", "inputSchema": schema(merge(["keys": ["type": "string"]], tab), required: ["keys"])],
        ["name": "form_input", "description": "Set a form control by ref: text, checkbox or radio (true/false), select (option), contenteditable.", "inputSchema": schema(merge(ref, ["value": [:]], tab), required: ["ref", "value"])],
        ["name": "upload_file", "description": "Attach local files to a file input by ref (absolute paths, 10 MB total).", "inputSchema": schema(merge(ref, ["paths": ["type": "array", "items": ["type": "string"]]], tab), required: ["ref", "paths"])],
        ["name": "scroll", "description": "Scroll by direction and ticks, or scroll a ref into view.", "inputSchema": schema(merge(["direction": ["type": "string", "enum": ["up", "down", "left", "right"]], "amount": ["type": "number"], "x": ["type": "number"], "y": ["type": "number"]], ref, tab))],
        ["name": "screenshot", "description": "Viewport PNG scaled to CSS pixels, so coordinates read from it can be clicked.", "inputSchema": schema(merge(tab, ["scale": ["type": "number"]]))],
        ["name": "console_messages", "description": "Console output captured in the tab since its last navigation.", "inputSchema": schema(merge(tab, ["pattern": ["type": "string"], "onlyErrors": ["type": "boolean"], "limit": ["type": "number"]]))],
        ["name": "network_requests", "description": "Network requests observed in the tab since its last navigation.", "inputSchema": schema(merge(tab, ["urlPattern": ["type": "string"], "limit": ["type": "number"]]))],
        ["name": "javascript", "description": "Evaluate a JavaScript expression in the page and return JSON.", "inputSchema": schema(merge(["expression": ["type": "string"]], tab), required: ["expression"])],
        ["name": "wait", "description": "Wait seconds, or until a CSS selector or text appears.", "inputSchema": schema(merge(["seconds": ["type": "number"], "selector": ["type": "string"], "text": ["type": "string"], "timeout": ["type": "number"]], tab))],
    ]

    static func text(_ s: String) -> [String: Any] { ["content": [["type": "text", "text": s]]] }
    static func str(_ v: Any?) -> String { v.map { "\($0)" } ?? "" }

    static func call(_ name: String, _ a: [String: Any], bridge b: MCPServer) throws -> [String: Any] {
        let tab = a["tabId"]
        switch name {
        case "tabs_context":
            let tabs = try b.command("tabs.list") as? [[String: Any]] ?? []
            if tabs.isEmpty { return text("Safari has no tabs open. Use tabs_create or navigate.") }
            let lines = tabs.map { "\(($0["active"] as? Bool ?? false) ? "*" : " ") \(str($0["tabId"]))  \(str($0["title"]).isEmpty ? "(untitled)" : str($0["title"]))  \(str($0["url"]))" }
            return text(lines.joined(separator: "\n"))
        case "tabs_create":
            let r = try b.command("tabs.create", ["url": a["url"] ?? "about:blank"]) as? [String: Any] ?? [:]
            return text("Opened tab \(str(r["tabId"])): \(str(r["title"]))  \(str(r["url"]))")
        case "tabs_close":
            _ = try b.command("tabs.close", ["tabId": tab ?? ""]); return text("Closed tab \(str(tab)).")
        case "navigate":
            var p: [String: Any] = ["url": a["url"] ?? ""]; if let tab { p["tabId"] = tab }
            let r = try b.command("navigate", p) as? [String: Any] ?? [:]
            return text("\(str(r["title"]).isEmpty ? "(untitled)" : str(r["title"]))  \(str(r["url"]))\((r["ready"] as? Bool ?? true) ? "" : " (still loading)") [tab \(str(r["tabId"]))]")
        case "read_page":
            let r = try b.page(tab, "tree", ["filter": a["filter"] ?? "all", "ref": a["ref"] as Any, "depth": a["depth"] ?? 15]) as? [String: Any] ?? [:]
            let lines = (r["lines"] as? [String] ?? []).joined(separator: "\n")
            let max = a["max_chars"] as? Int ?? 50_000
            let body = lines.count > max ? String(lines.prefix(max)) + "\n… truncated; pass a larger max_chars or a ref." : lines
            return text("\(str(r["title"]).isEmpty ? "(untitled)" : str(r["title"])) — \(str(r["url"]))\n\(body.isEmpty ? "(no visible elements)" : body)")
        case "find":
            let rows = try b.page(tab, "find", a["query"] ?? "") as? [[String: Any]] ?? []
            if rows.isEmpty { return text("No matching elements.") }
            return text(rows.map { "\(str($0["ref"]))  \(str($0["role"]))\(str($0["name"]).isEmpty ? "" : " \"\(str($0["name"]))\"")\(str($0["href"]).isEmpty ? "" : " " + str($0["href"]))" }.joined(separator: "\n"))
        case "get_page_text":
            let r = try b.page(tab, "pageText", a["max_chars"] ?? 50_000) as? [String: Any] ?? [:]
            return text("\(str(r["title"])) — \(str(r["url"]))\n\n\(str(r["text"]))")
        case "click":
            let r = try b.page(tab, "click", ["ref": a["ref"] as Any, "x": a["x"] as Any, "y": a["y"] as Any, "count": a["count"] as Any, "button": a["button"] as Any, "modifiers": a["modifiers"] as Any].compactMapValues { $0 }) as? [String: Any] ?? [:]
            return text("Clicked \(str(r["clicked"])) at (\(str(r["x"])), \(str(r["y"]))).")
        case "hover":
            let r = try b.page(tab, "hover", ["ref": a["ref"] as Any, "x": a["x"] as Any, "y": a["y"] as Any].compactMapValues { $0 }) as? [String: Any] ?? [:]
            return text("Hovering \(str(r["hovered"]))")
        case "type":
            let r = try b.page(tab, "type", ["text": a["text"] ?? "", "ref": a["ref"] as Any, "replace": a["replace"] as Any].compactMapValues { $0 }) as? [String: Any] ?? [:]
            return text("Typed \(str(r["typed"])) characters into \(str(r["into"])); value is now \"\(str(r["value"]))\"")
        case "press_key":
            let keys = (a["keys"] as? String ?? "").split(separator: " ").map(String.init)
            for k in keys {
                let name = ["return": "Enter", "enter": "Enter", "tab": "Tab", "escape": "Escape", "esc": "Escape"][k.lowercased()]
                guard let name else { throw MCPServer.BridgeError(message: "press_key over MCP supports Return, Tab and Escape; got \(k).") }
                _ = try b.page(tab, "pressKey", ["key": name])
            }
            return text("Pressed \(keys.joined(separator: " "))")
        case "form_input":
            let r = try b.page(tab, "formInput", ["ref": a["ref"] ?? "", "value": a["value"] ?? ""]) as? [String: Any] ?? [:]
            return text("Set \(str(r["into"])) to \(str(r["set"]))")
        case "upload_file":
            var files: [[String: Any]] = []
            var total = 0
            for p in a["paths"] as? [String] ?? [] {
                let data = try Data(contentsOf: URL(fileURLWithPath: p))
                total += data.count
                if total > 10 * 1024 * 1024 { throw MCPServer.BridgeError(message: "Uploads are limited to 10 MB in total.") }
                files.append(["name": (p as NSString).lastPathComponent, "type": "application/octet-stream", "base64": data.base64EncodedString()])
            }
            let r = try b.page(tab, "upload", ["ref": a["ref"] ?? "", "files": files]) as? [String: Any] ?? [:]
            return text("Attached \((r["attached"] as? [String] ?? []).joined(separator: ", ")) to \(str(r["into"]))")
        case "scroll":
            let r = try b.page(tab, "scroll", ["direction": a["direction"] as Any, "amount": a["amount"] as Any, "x": a["x"] as Any, "y": a["y"] as Any, "ref": a["ref"] as Any].compactMapValues { $0 }) as? [String: Any] ?? [:]
            return text("Scroll position (\(str(r["scrollX"])), \(str(r["scrollY"]))); page height \(str(r["pageHeight"])), viewport \(str(r["viewportHeight"])).")
        case "screenshot":
            var p: [String: Any] = ["scale": a["scale"] ?? 1]; if let tab { p["tabId"] = tab }
            let r = try b.command("screenshot", p) as? [String: Any] ?? [:]
            let g = r["geometry"] as? [String: Any] ?? [:]
            return ["content": [["type": "text", "text": "Viewport \(str(g["innerWidth"]))×\(str(g["innerHeight"])) CSS px; coordinates in that frame."], ["type": "image", "data": str(r["base64"]), "mimeType": "image/png"]]]
        case "console_messages":
            var p: [String: Any] = ["pattern": a["pattern"] as Any, "onlyErrors": a["onlyErrors"] as Any, "limit": a["limit"] ?? 50].compactMapValues { $0 }; if let tab { p["tabId"] = tab }
            let r = try b.command("console", p) as? [String: Any] ?? [:]
            let entries = r["entries"] as? [[String: Any]] ?? []
            if entries.isEmpty { return text("No console output captured in tab \(str(r["tabId"])).") }
            return text(entries.map { "[\(str($0["level"]))] \(str($0["text"]))" }.joined(separator: "\n"))
        case "network_requests":
            var p: [String: Any] = ["urlPattern": a["urlPattern"] as Any, "limit": a["limit"] ?? 50].compactMapValues { $0 }; if let tab { p["tabId"] = tab }
            let r = try b.command("network", p) as? [String: Any] ?? [:]
            let entries = r["entries"] as? [[String: Any]] ?? []
            if entries.isEmpty { return text("No requests observed in tab \(str(r["tabId"])).") }
            return text(entries.map { "\(str($0["method"])) \(str($0["status"] ?? $0["error"] ?? "?")) \(str($0["type"])) \(str($0["ms"]))ms  \(str($0["url"]))" }.joined(separator: "\n"))
        case "javascript":
            return text(str(try b.page(tab, "evaluate", a["expression"] ?? "")))
        case "wait":
            if a["selector"] == nil && a["text"] == nil {
                let s = min(30.0, max(0.0, (a["seconds"] as? Double) ?? 1)); Thread.sleep(forTimeInterval: s); return text("Waited \(s) s")
            }
            let limit = min(60.0, max(1.0, (a["timeout"] as? Double) ?? 10)); let deadline = Date().addingTimeInterval(limit)
            while Date() < deadline {
                if (try b.page(tab, "waitFor", ["selector": a["selector"] as Any, "text": a["text"] as Any].compactMapValues { $0 })) as? Bool == true { return text("Found.") }
                Thread.sleep(forTimeInterval: 0.3)
            }
            throw MCPServer.BridgeError(message: "Timed out after \(Int(limit)) s.")
        default:
            throw MCPServer.BridgeError(message: "Unknown tool \(name)")
        }
    }
}
