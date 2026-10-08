//  main.swift
//  `--mcp` turns this executable into a stdio MCP server; otherwise the normal app runs.

import AppKit

if CommandLine.arguments.contains("--mcp") {
    MCPServer().run()
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
_ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
