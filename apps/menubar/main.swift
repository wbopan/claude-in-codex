import AppKit

func drawMark(_ rect: NSRect, phase: String, color: NSColor) {
    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.translateX(by: rect.minX, yBy: rect.minY)
    transform.scaleX(by: rect.width / 18, yBy: rect.height / 18)
    transform.concat()
    color.setStroke(); color.setFill()
    let brackets = NSBezierPath()
    brackets.lineWidth = 1.65; brackets.lineCapStyle = .round; brackets.lineJoinStyle = .round
    brackets.move(to: NSPoint(x: 5.5, y: 3.5)); brackets.line(to: NSPoint(x: 2.5, y: 3.5))
    brackets.line(to: NSPoint(x: 2.5, y: 14.5)); brackets.line(to: NSPoint(x: 5.5, y: 14.5))
    brackets.move(to: NSPoint(x: 12.5, y: 3.5)); brackets.line(to: NSPoint(x: 15.5, y: 3.5))
    brackets.line(to: NSPoint(x: 15.5, y: 14.5)); brackets.line(to: NSPoint(x: 12.5, y: 14.5))
    brackets.stroke()
    if phase == "draining" || phase == "attaching" || phase == "detaching" {
        for x in [6.0, 9.0, 12.0] { NSBezierPath(ovalIn: NSRect(x: x - 0.7, y: 8.3, width: 1.4, height: 1.4)).fill() }
    } else if phase == "attached" {
        NSBezierPath(ovalIn: NSRect(x: 6.7, y: 6.7, width: 4.6, height: 4.6)).fill()
    } else if phase == "error" {
        let bar = NSBezierPath(roundedRect: NSRect(x: 8.2, y: 7.5, width: 1.6, height: 5), xRadius: 0.8, yRadius: 0.8)
        bar.fill(); NSBezierPath(ovalIn: NSRect(x: 8.2, y: 4.5, width: 1.6, height: 1.6)).fill()
    } else {
        let dot = NSBezierPath(ovalIn: NSRect(x: 7.2, y: 7.2, width: 3.6, height: 3.6))
        dot.lineWidth = 1.2; dot.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
}

func statusIcon(_ phase: String) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
        drawMark(rect, phase: phase, color: .black); return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Codex Host \(phase)"
    return image
}

func renderAssets(_ directory: String) throws {
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    for phase in ["detached", "attached", "draining", "error"] {
        let image = NSImage(size: NSSize(width: 180, height: 180), flipped: false) { rect in
            NSColor.white.setFill(); rect.fill(); drawMark(rect.insetBy(dx: 20, dy: 20), phase: phase, color: .black); return true
        }
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent("menu-\(phase).png"))
    }
    let image = NSImage(size: NSSize(width: 1024, height: 1024), flipped: false) { rect in
        let tile = NSBezierPath(roundedRect: rect.insetBy(dx: 36, dy: 36), xRadius: 215, yRadius: 215)
        NSGradient(starting: NSColor(calibratedRed: 0.28, green: 0.25, blue: 0.67, alpha: 1),
                   ending: NSColor(calibratedRed: 0.12, green: 0.14, blue: 0.35, alpha: 1))!.draw(in: tile, angle: -55)
        drawMark(rect.insetBy(dx: 230, dy: 230), phase: "attached", color: .white)
        return true
    }
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent("AppIcon.png"))
}

final class HostMenu: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var child: Process?
    private var control: FileHandle?
    private var readBuffer = Data()
    private var state: [String: Any] = ["phase": "detached"]
    private var quitting = false
    private var allowExit = false
    private var menuOpen = false
    private var logURL: URL!
    private var stdoutPipe: Pipe?
    private var stdinPipe: Pipe?
    private var statusWindow: NSWindow?
    private var statusLabel: NSTextField?
    private var panelIcon: NSImageView?
    private var panelConnect: NSButton?
    private var panelDisconnect: NSButton?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let applicationMenu = NSMenu()
        let appItem = NSMenuItem()
        applicationMenu.addItem(appItem)
        let appSubmenu = NSMenu()
        let quitItem = NSMenuItem(title: "退出 Codex Host", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appSubmenu.addItem(quitItem); appItem.submenu = appSubmenu; NSApp.mainMenu = applicationMenu
        statusItem = NSStatusBar.system.statusItem(withLength: 28)
        statusItem.menu = menu; menu.delegate = self
        updateMenu(); startHost()
        if ProcessInfo.processInfo.environment["CODEXHOST_SHOW_STATUS_WINDOW"] == "1" { showStatus() }
    }

    private func startHost() {
        guard child?.isRunning != true else { return }
        readBuffer.removeAll()
        let resources = Bundle.main.resourceURL!
        let process = Process()
        process.executableURL = resources.appendingPathComponent("runtime/node")
        process.arguments = [resources.appendingPathComponent("host.mjs").path, "--codexhost-menubar"]
        var environment = ProcessInfo.processInfo.environment
        for key in ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CODEX_CLI_PATH", "CODEXHOST_THREAD_ID", "CODEXHOST_PARENT_THREAD_ID"] { environment.removeValue(forKey: key) }
        process.environment = environment
        let dataRoot = environment["CODEXHOST_DATA_DIR"] ?? NSHomeDirectory() + "/.codexhost"
        let logDirectory = URL(fileURLWithPath: dataRoot).appendingPathComponent("logs")
        do {
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            logURL = logDirectory.appendingPathComponent("menubar.log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            let log = try FileHandle(forWritingTo: logURL); try log.seekToEnd()
            process.standardError = log
            let input = Pipe(), output = Pipe()
            stdinPipe = input; stdoutPipe = output
            process.standardInput = input; process.standardOutput = output
            control = input.fileHandleForWriting
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async { self?.receive(data) }
            }
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.control = nil; self.child = nil
                    if self.quitting { self.allowExit = true; NSApp.terminate(nil) }
                    else { self.state = ["phase": "error", "error": "Host 已退出（\(process.terminationStatus)）"]; self.updateMenu() }
                }
            }
            child = process; try process.run()
        } catch { state = ["phase": "error", "error": error.localizedDescription]; updateMenu() }
    }

    private func receive(_ data: Data) {
        readBuffer.append(data)
        while let newline = readBuffer.firstIndex(of: 10) {
            let line = readBuffer[..<newline]; readBuffer.removeSubrange(...newline)
            guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if message["type"] as? String == "status" { state = message; updateMenu() }
        }
    }
    private func send(_ command: String) {
        guard let control, let data = try? JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "command": command]) else { return }
        do { try control.write(contentsOf: data + Data([10])) }
        catch { state = ["phase": "error", "error": error.localizedDescription]; updateMenu() }
    }
    private func item(_ title: String, _ action: Selector? = nil, key: String = "", enabled: Bool = true) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self; entry.isEnabled = enabled && action != nil; menu.addItem(entry)
    }
    private func updateMenu() {
        let phase = state["phase"] as? String ?? "detached"
        statusItem?.button?.image = statusIcon(phase)
        statusItem?.button?.toolTip = "Codex Host · " + phase
        statusLabel?.stringValue = statusDescription()
        panelIcon?.image = statusIcon(phase)
        panelConnect?.isEnabled = phase == "detached" || phase == "error"
        panelDisconnect?.isEnabled = phase == "attached" || phase == "draining"
        panelDisconnect?.title = phase == "draining" ? "取消断开" : "等待完成后断开"
        if menuOpen { return }
        menu.removeAllItems(); menu.autoenablesItems = false
        item("Codex Host")
        let labels = ["detached": "未接入", "attaching": "正在接入…", "attached": "已接入原版 App",
                      "draining": "等待任务完成…", "detaching": "正在断开…", "error": "接入未完成"]
        item(labels[phase] ?? phase)
        if let version = state["appVersion"] as? String { item("Desktop \(version)") }
        if let error = state["error"] as? String, !error.isEmpty {
            let entry = NSMenuItem(title: String(error.prefix(100)), action: nil, keyEquivalent: "")
            entry.toolTip = error; entry.isEnabled = false; menu.addItem(entry)
        }
        if phase == "attached" || phase == "draining" {
            let count = state["activeExternal"] as? Int ?? 0
            item(count == 0 ? "本机模型 · Claude + GPT" : "\(count) 个外部任务运行中")
            let background = state["backgroundTasks"] as? Int ?? 0
            if background > 0 { item("\(background) 个后台任务运行中") }
        }
        menu.addItem(.separator())
        if phase == "attached" { item("断开（等待任务完成）", #selector(disconnect)) }
        else if phase == "draining" {
            item("取消断开", #selector(cancelDisconnect))
            item("停止外部任务并断开…", #selector(stopAndDisconnect))
        } else { item("接入原版 App", #selector(connect), enabled: phase == "detached" || phase == "error") }
        item("打开原版 App", #selector(openDesktop))
        menu.addItem(.separator())
        item("连接状态…", #selector(showStatus))
        item("查看诊断日志", #selector(openLogs))
        item(quitting ? "正在退出…" : "退出 Codex Host", #selector(quitHost), key: "q", enabled: !quitting)
    }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = false; updateMenu(); menuOpen = true; send("status") }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; updateMenu() }
    @objc private func connect() { if child?.isRunning != true { startHost() } else { send("attach") } }
    @objc private func disconnect() { send("detach") }
    @objc private func cancelDisconnect() { quitting = false; send("cancel-drain") }
    @objc private func stopAndDisconnect() {
        let alert = NSAlert(); alert.messageText = "停止外部任务并断开？"
        alert.informativeText = "正在运行的 Claude 任务会被中断，已保存的历史会保留。原版 App 和 GPT 任务会继续运行。"
        alert.addButton(withTitle: "停止并断开"); alert.addButton(withTitle: "继续等待")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { send("stop-and-detach") }
    }
    @objc private func openDesktop() {
        let path = state["appPath"] as? String ?? "/Applications/ChatGPT.app"
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: NSWorkspace.OpenConfiguration())
    }
    @objc private func openLogs() { if let logURL { NSWorkspace.shared.open(logURL) } }
    private func statusDescription() -> String {
        let phase = state["phase"] as? String ?? "detached"
        let labels = ["detached": "未接入", "attaching": "正在接入…", "attached": "已接入原版 App",
                      "draining": "等待任务完成…", "detaching": "正在断开…", "error": "接入未完成"]
        var lines = [labels[phase] ?? phase]
        if let version = state["appVersion"] as? String { lines.append("Desktop \(version)") }
        if let count = state["activeExternal"] as? Int { lines.append("\(count) 个外部任务运行中") }
        if let count = state["backgroundTasks"] as? Int, count > 0 { lines.append("\(count) 个后台任务运行中") }
        if let error = state["error"] as? String { lines.append(error) }
        return lines.joined(separator: "\n")
    }
    @objc private func showStatus() {
        if statusWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 285),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Codex Host"; window.isReleasedWhenClosed = false
            let content = window.contentView!
            let icon = NSImageView(frame: NSRect(x: 24, y: 205, width: 42, height: 42))
            icon.image = statusIcon(state["phase"] as? String ?? "detached")
            icon.imageScaling = .scaleProportionallyUpOrDown
            content.addSubview(icon); panelIcon = icon
            let title = NSTextField(labelWithString: "Codex Host")
            title.font = NSFont.systemFont(ofSize: 22, weight: .semibold)
            title.frame = NSRect(x: 82, y: 214, width: 310, height: 30); content.addSubview(title)
            let subtitle = NSTextField(labelWithString: "在原版 App 中使用你的模型")
            subtitle.textColor = .secondaryLabelColor
            subtitle.frame = NSRect(x: 82, y: 192, width: 310, height: 22); content.addSubview(subtitle)
            let more = NSButton(image: NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "更多操作")!, target: self, action: #selector(showMore))
            more.isBordered = false; more.frame = NSRect(x: 392, y: 218, width: 25, height: 25)
            content.addSubview(more)
            let label = NSTextField(wrappingLabelWithString: statusDescription())
            label.frame = NSRect(x: 24, y: 73, width: 392, height: 97)
            content.addSubview(label); statusLabel = label
            let connectButton = NSButton(title: "接入", target: self, action: #selector(connect))
            connectButton.frame = NSRect(x: 22, y: 22, width: 90, height: 32); content.addSubview(connectButton)
            panelConnect = connectButton
            let disconnectButton = NSButton(title: "等待完成后断开", target: self, action: #selector(panelDisconnectAction))
            disconnectButton.frame = NSRect(x: 123, y: 22, width: 145, height: 32); content.addSubview(disconnectButton)
            panelDisconnect = disconnectButton
            let appButton = NSButton(title: "打开原版 App", target: self, action: #selector(openDesktop))
            appButton.frame = NSRect(x: 278, y: 22, width: 140, height: 32); content.addSubview(appButton)
            window.center(); statusWindow = window
        }
        statusWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        updateMenu()
    }
    @objc private func panelDisconnectAction() {
        if state["phase"] as? String == "draining" { cancelDisconnect() } else { disconnect() }
    }
    @objc private func showMore() {
        updateMenu()
        menu.popUp(positioning: nil, at: NSPoint(x: 417, y: 212), in: statusWindow?.contentView)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showStatus(); return true
    }
    @objc private func quitHost() {
        quitting = true
        if child?.isRunning == true { send("quit"); updateMenu() }
        else { allowExit = true; NSApp.terminate(nil) }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowExit { return .terminateNow }
        quitHost(); return .terminateCancel
    }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--render-assets" {
    try renderAssets(CommandLine.arguments[2])
} else {
    let app = NSApplication.shared
    let delegate = HostMenu()
    app.delegate = delegate
    app.run()
}
