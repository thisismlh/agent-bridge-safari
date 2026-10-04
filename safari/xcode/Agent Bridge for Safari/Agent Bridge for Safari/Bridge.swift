//  Bridge.swift
//  The local bridge between Claude Code and the Safari extension, hosted by this app.
//  Same protocol as safari/bridge/bridge.mjs, over one loopback HTTP listener:
//    extension side:  POST /ext/poll, POST /ext/result   (Origin safari-web-extension://, JSON)
//    Claude Code side: POST /call, GET /status            (Authorization: Bearer <token>, JSON)
//  Discovery: {port, token, pid, version} in Application Support/bridge.json (inside the
//  app's sandbox container, which Claude Code reads from outside).

import Foundation

// MARK: - Minimal HTTP/1.1 server over POSIX sockets

struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]   // lower-cased names
    let body: Data
    var json: [String: Any] { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:] }
}

final class HTTPConnection {
    private let fd: Int32
    private var done = false
    private let lock = NSLock()
    init(fd: Int32) { self.fd = fd }

    var isOpen: Bool { lock.lock(); defer { lock.unlock() }; return !done }

    func respond(_ status: Int, json: Any) {
        let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data("{}".utf8)
        respond(status, body: body, contentType: "application/json")
    }
    func respond(_ status: Int, body: Data, contentType: String) {
        lock.lock(); defer { lock.unlock() }
        if done { return }
        done = true
        let reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 503 ? "Service Unavailable" : status == 502 ? "Bad Gateway" : "Error"
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(contentType)\r\nContent-Length: \(status == 204 ? 0 : body.count)\r\nX-Claude-Bridge: 1\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8)
        if status != 204 { out.append(body) }
        out.withUnsafeBytes { raw in
            var sent = 0
            while sent < out.count {
                let n = send(fd, raw.baseAddress!.advanced(by: sent), out.count - sent, 0)
                if n <= 0 { break }
                sent += n
            }
        }
        head.removeAll()
        close(fd)
    }
    func abandon() {
        lock.lock(); defer { lock.unlock() }
        if done { return }
        done = true
        close(fd)
    }
}

final class HTTPServer {
    let port: UInt16
    private let listenFD: Int32
    private let acceptQueue = DispatchQueue(label: "bridge.accept")
    private var source: DispatchSourceRead?

    init(preferredPort: UInt16, attempts: Int = 10) throws {
        var fd: Int32 = -1
        var bound: UInt16 = 0
        for offset in 0..<attempts {
            let p = preferredPort + UInt16(offset)
            fd = socket(AF_INET, SOCK_STREAM, 0)
            if fd < 0 { throw NSError(domain: "bridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket() failed"]) }
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = p.bigEndian
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            if ok == 0, listen(fd, 64) == 0 { bound = p; break }
            close(fd); fd = -1
        }
        if fd < 0 { throw NSError(domain: "bridge", code: 2, userInfo: [NSLocalizedDescriptionKey: "no free loopback port from \(preferredPort)"]) }
        listenFD = fd
        port = bound
    }

    func start(handler: @escaping (HTTPRequest, HTTPConnection) -> Void) {
        let src = DispatchSource.makeReadSource(fileDescriptor: listenFD, queue: acceptQueue)
        src.setEventHandler { [listenFD] in
            var addr = sockaddr(); var len = socklen_t(MemoryLayout<sockaddr>.size)
            let cfd = accept(listenFD, &addr, &len)
            if cfd < 0 { return }
            var one: Int32 = 1
            setsockopt(cfd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            DispatchQueue.global(qos: .userInitiated).async {
                let conn = HTTPConnection(fd: cfd)
                guard let req = HTTPServer.read(fd: cfd) else { conn.respond(400, json: ["error": "bad request"]); return }
                handler(req, conn)
            }
        }
        src.resume()
        source = src
    }

    private static func read(fd: Int32) -> HTTPRequest? {
        var buf = [UInt8](repeating: 0, count: 65536)
        var data = Data()
        var headerEnd: Range<Data.Index>? = nil
        var tv = timeval(tv_sec: 10, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        while headerEnd == nil {
            let n = recv(fd, &buf, buf.count, 0)
            if n <= 0 { return nil }
            data.append(buf, count: n)
            headerEnd = data.range(of: Data("\r\n\r\n".utf8))
            if data.count > 16 * 1024 * 1024 { return nil }
        }
        guard let he = headerEnd, let headText = String(data: data[..<he.lowerBound], encoding: .utf8) else { return nil }
        var lines = headText.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            if let i = line.firstIndex(of: ":") {
                headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
        }
        var body = Data(data[he.upperBound...])
        if (headers["transfer-encoding"] ?? "").lowercased().contains("chunked") {
            // Chunked bodies (Node's http client sends these when no Content-Length is given).
            var raw = body
            var decoded = Data()
            while true {
                guard let lineEnd = raw.range(of: Data("\r\n".utf8)) else {
                    let n = recv(fd, &buf, buf.count, 0); if n <= 0 { return nil }; raw.append(buf, count: n); continue
                }
                let sizeText = String(data: raw[..<lineEnd.lowerBound], encoding: .utf8)?.split(separator: ";").first.map(String.init) ?? "0"
                guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16) else { return nil }
                while raw.count < lineEnd.upperBound + size + 2 {
                    let n = recv(fd, &buf, buf.count, 0); if n <= 0 { return nil }; raw.append(buf, count: n)
                }
                if size == 0 { break }
                decoded.append(raw[lineEnd.upperBound..<(lineEnd.upperBound + size)])
                raw = Data(raw[(lineEnd.upperBound + size + 2)...])
                if decoded.count > 16 * 1024 * 1024 { return nil }
            }
            body = decoded
        } else {
            let length = Int(headers["content-length"] ?? "0") ?? 0
            while body.count < length {
                let n = recv(fd, &buf, min(buf.count, length - body.count), 0)
                if n <= 0 { return nil }
                body.append(buf, count: n)
            }
        }
        return HTTPRequest(method: String(requestLine[0]), path: String(requestLine[1]), headers: headers, body: body)
    }
}

// MARK: - Bridge state and protocol

final class Bridge {
    static let shared = Bridge()
    static let version = "0.9.0"
    static let preferredPort: UInt16 = 47831

    struct Instance { var lastSeen: Date; var tabs: Int; var reach: Int; var version: String? }
    private struct Waiter { let conn: HTTPConnection; let origin: String; let timer: DispatchWorkItem }
    private struct Pending { let conn: HTTPConnection; let name: String; let timer: DispatchWorkItem; let pickup: DispatchWorkItem }
    private struct Command { let id: String; let name: String; let params: [String: Any]; let deadline: Double }

    private let q = DispatchQueue(label: "bridge.state")
    private var server: HTTPServer?
    private(set) var port: UInt16 = 0
    private(set) var token = ""           // the app's own token, written to the discovery file
    private var pairedTokens: [String] = []    // tokens handed over by Claude Code sessions via agentbridge://pair
    private var queue: [Command] = []
    private var waiters: [Waiter] = []
    private var instances: [String: Instance] = [:]
    private var pending: [String: Pending] = [:]
    private var primary: String? = nil
    private(set) var lastClaudeCall: Date? = nil
    private(set) var lastError: String? = nil

    private let connectedWindow: TimeInterval = 40
    private let recent: TimeInterval = 3
    private let pollHold: TimeInterval = 25
    private let pickupWindow: TimeInterval = 8

    var discoveryURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Agent Bridge for Safari", isDirectory: true)
        return dir.appendingPathComponent("bridge.json")
    }

    func start() {
        q.sync {
            guard server == nil else { return }
            do {
                let args = ProcessInfo.processInfo.arguments
                var preferred = Bridge.preferredPort
                if let i = args.firstIndex(of: "--port"), i + 1 < args.count, let p = UInt16(args[i + 1]) { preferred = p }
                if let i = args.firstIndex(of: "--token"), i + 1 < args.count { pairedTokens.append(args[i + 1]) }
                let s = try HTTPServer(preferredPort: preferred, attempts: preferred == Bridge.preferredPort ? 10 : 1)
                var bytes = [UInt8](repeating: 0, count: 32)
                _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
                token = bytes.map { String(format: "%02x", $0) }.joined()
                port = s.port
                server = s
                s.start { [weak self] req, conn in self?.handle(req, conn) }
                writeDiscovery()
                lastError = nil
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func writeDiscovery() {
        let url = discoveryURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let info: [String: Any] = ["port": Int(port), "token": token, "pid": Int(ProcessInfo.processInfo.processIdentifier), "version": Bridge.version]
        if let data = try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted]) {
            try? data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }

    // MARK: routing

    private func handle(_ req: HTTPRequest, _ conn: HTTPConnection) {
        q.async { [self] in
            switch (req.method, req.path) {
            case ("POST", "/ext/poll"), ("POST", "/ext/result"):
                guard fromExtension(req) else { conn.respond(403, json: ["error": "not the Safari extension"]); return }
                if req.path == "/ext/poll" { extPoll(req, conn) } else { extResult(req, conn) }
            case ("GET", "/status"), ("POST", "/call"), ("POST", "/shutdown"):
                guard fromClaude(req) else { conn.respond(403, json: ["error": "missing or wrong bridge token"]); return }
                if req.path == "/status" { conn.respond(200, json: statusJSON()) }
                else if req.path == "/call" { call(req, conn) }
                else { conn.respond(200, json: ["ok": true]); DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) } }
            default:
                conn.respond(404, json: ["error": "not found"])
            }
        }
    }

    private func fromExtension(_ req: HTTPRequest) -> Bool {
        let ct = req.headers["content-type"] ?? ""
        let origin = req.headers["origin"] ?? ""
        return ct.hasPrefix("application/json") && origin.hasPrefix("safari-web-extension://")
    }
    private func fromClaude(_ req: HTTPRequest) -> Bool {
        let auth = req.headers["authorization"] ?? ""
        guard auth.hasPrefix("Bearer ") else { return false }
        let t = String(auth.dropFirst(7))
        return (!token.isEmpty && t == token) || pairedTokens.contains(t)
    }
    /// A Claude Code session pairs by opening agentbridge://pair?token=<hex>. Several sessions may
    /// be paired at once; the list is bounded so a flood cannot grow it without limit.
    func pair(token t: String) {
        guard t.count >= 32, t.count <= 128, t.allSatisfy({ $0.isHexDigit }) else { return }
        q.async {
            self.pairedTokens.removeAll { $0 == t }
            self.pairedTokens.append(t)
            if self.pairedTokens.count > 32 { self.pairedTokens.removeFirst() }
        }
    }

    // MARK: instances and primary (same rules as bridge.mjs)

    private func usable(_ origin: String, _ i: Instance, now: Date) -> Bool {
        waiters.contains { $0.origin == origin && $0.conn.isOpen } || now.timeIntervalSince(i.lastSeen) <= recent
    }
    private func score(_ i: Instance) -> Int { i.reach * 1000 + i.tabs }
    private func primaryOrigin() -> String? {
        let now = Date()
        let alive = instances.filter { usable($0.key, $0.value, now: now) }
        guard let best = alive.max(by: { a, b in
            let sa = score(a.value), sb = score(b.value)
            return sa != sb ? sa < sb : a.value.lastSeen < b.value.lastSeen
        }) else { primary = nil; return nil }
        if let p = primary, let current = alive[p] {
            if score(best.value) > score(current) { primary = best.key }
        } else {
            primary = best.key
        }
        return primary
    }
    var isConnected: Bool { q.sync { primaryOrigin() != nil } }
    var primaryVersion: String? { q.sync { primaryOrigin().flatMap { instances[$0]?.version } } }
    var liveInstances: [(origin: String, instance: Instance)] {
        q.sync { let now = Date(); return instances.filter { now.timeIntervalSince($0.value.lastSeen) <= connectedWindow }.map { ($0.key, $0.value) } }
    }

    private func statusJSON() -> [String: Any] {
        let now = Date()
        var inst: [String: Any] = [:]
        for (o, i) in instances where now.timeIntervalSince(i.lastSeen) <= connectedWindow {
            inst[o] = ["lastSeen": Int(i.lastSeen.timeIntervalSince1970 * 1000), "tabs": i.tabs, "reach": i.reach, "version": i.version.map { $0 as Any } ?? NSNull()]
        }
        let p = primaryOrigin()
        return [
            "ok": true, "pid": Int(ProcessInfo.processInfo.processIdentifier), "host": "app", "version": Bridge.version,
            "extensionConnected": p != nil, "extensionVersion": (p.flatMap { instances[$0]?.version }).map { $0 as Any } ?? NSNull(),
            "primary": p ?? NSNull(), "instances": inst, "queued": queue.count, "pending": pending.count, "port": Int(port),
        ]
    }

    private func dispatch() {
        let p = primaryOrigin()
        while !queue.isEmpty {
            guard let idx = waiters.firstIndex(where: { $0.origin == p && $0.conn.isOpen }) else { return }
            let w = waiters.remove(at: idx)
            w.timer.cancel()
            let cmd = queue.removeFirst()
            w.conn.respond(200, json: ["id": cmd.id, "name": cmd.name, "params": cmd.params, "deadline": cmd.deadline])
        }
    }

    // MARK: extension side

    private func extPoll(_ req: HTTPRequest, _ conn: HTTPConnection) {
        let body = req.json
        let origin = req.headers["origin"] ?? ""
        let now = Date()
        instances = instances.filter { now.timeIntervalSince($0.value.lastSeen) <= 5 * connectedWindow }
        instances[origin] = Instance(lastSeen: now, tabs: body["tabs"] as? Int ?? -1, reach: body["reach"] as? Int ?? 0, version: body["version"] as? String)
        let timer = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.waiters.removeAll { $0.conn === conn }
            conn.respond(204, json: [:])
        }
        waiters.append(Waiter(conn: conn, origin: origin, timer: timer))
        q.asyncAfter(deadline: .now() + pollHold, execute: timer)
        dispatch()
    }

    private func extResult(_ req: HTTPRequest, _ conn: HTTPConnection) {
        let body = req.json
        let origin = req.headers["origin"] ?? ""
        if var i = instances[origin] { i.lastSeen = Date(); instances[origin] = i }
        if let id = body["id"] as? String, let p = pending.removeValue(forKey: id) {
            p.timer.cancel(); p.pickup.cancel()
            if let err = body["error"] { p.conn.respond(502, json: ["error": err]) }
            else { p.conn.respond(200, json: ["result": body["result"] ?? NSNull()]) }
        }
        conn.respond(200, json: ["ok": true])
    }

    // MARK: Claude Code side

    private func call(_ req: HTTPRequest, _ conn: HTTPConnection) {
        let body = req.json
        lastClaudeCall = Date()
        guard let name = body["name"] as? String else { conn.respond(400, json: ["error": "name required"]); return }
        guard primaryOrigin() != nil else { conn.respond(503, json: ["error": "Safari extension is not connected."]); return }
        let timeoutMs = min(600_000, max(1000, body["timeoutMs"] as? Int ?? 60_000))
        let id = UUID().uuidString.lowercased()
        let params = body["params"] as? [String: Any] ?? [:]
        let cmd = Command(id: id, name: name, params: params, deadline: Date().timeIntervalSince1970 * 1000 + Double(timeoutMs))
        let timer = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pending.removeValue(forKey: id)
            self.queue.removeAll { $0.id == id }
            conn.respond(502, json: ["error": "Safari did not answer \(name) within \(timeoutMs / 1000) s."])
        }
        let pickup = DispatchWorkItem { [weak self] in
            guard let self, self.queue.contains(where: { $0.id == id }) else { return }
            if let p = self.pending.removeValue(forKey: id) { p.timer.cancel() }
            self.queue.removeAll { $0.id == id }
            self.primary = nil
            conn.respond(503, json: ["error": "Safari extension is not connected."])
        }
        pending[id] = Pending(conn: conn, name: name, timer: timer, pickup: pickup)
        q.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timer)
        q.asyncAfter(deadline: .now() + pickupWindow, execute: pickup)
        queue.append(cmd)
        dispatch()
    }
}
