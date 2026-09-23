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

// MARK: Text and formatting

let phaseLabels = ["detached": "未接入", "attaching": "正在接入…", "attached": "已接入 Codex App",
                   "draining": "等待任务完成后断开…", "detaching": "正在断开…", "error": "接入未完成"]
let shortPhaseLabels = ["detached": "未接入", "attaching": "正在接入", "attached": "已接入",
                        "draining": "等待任务完成后断开", "detaching": "正在断开", "error": "未接入"]

func windowName(_ window: String?) -> String {
    guard let window else { return "" }
    switch window {
    case "five_hour": return "5 小时"
    case "weekly": return "每周"
    case "monthly": return "每月"
    default:
        if window.hasSuffix("h"), let hours = Int(window.dropLast()) { return "\(hours) 小时" }
        if window.hasSuffix("d"), let days = Int(window.dropLast()) { return "\(days) 天" }
        return window
    }
}

func productName(_ source: String, short: Bool) -> String {
    switch source {
    case "codex": return "Codex"
    case "claude-code": return short ? "Claude" : "Claude Code"
    case "pi": return "Pi"
    default: return source
    }
}

/// "Fable 每周"; a server-driven text row keeps its own label.
func meterWindowLabel(_ meter: [String: Any]) -> String {
    if let label = meter["label"] as? String { return label }
    let window = windowName(meter["window"] as? String)
    guard let scope = meter["scope"] as? String, !scope.isEmpty else { return window }
    return window.isEmpty ? scope : "\(scope) \(window)"
}

let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

func parseDate(_ value: Any?) -> Date? {
    guard let text = value as? String else { return nil }
    return isoFormatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}

func dateText(_ format: String, _ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN"); formatter.dateFormat = format
    return formatter.string(from: date)
}

/// Today "14:30", within a week "周六 18:00", later "9月30日".
func resetText(_ date: Date?) -> String {
    guard let date else { return "" }
    if Calendar.current.isDateInToday(date) { return dateText("HH:mm", date) }
    if date.timeIntervalSinceNow < 6.5 * 86400 { return dateText("EEE HH:mm", date) }
    return dateText("M月d日", date)
}

func clockText(since milliseconds: Double) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince1970 - milliseconds / 1000))
    if seconds >= 3600 { return String(format: "%d:%02d:%02d", seconds / 3600, seconds % 3600 / 60, seconds % 60) }
    return String(format: "%d:%02d", seconds / 60, seconds % 60)
}

func activityText(_ activity: [String: Any]?) -> String {
    guard let kind = activity?["kind"] as? String else { return "运行中" }
    return ["starting": "启动中", "thinking": "思考中", "responding": "回复中", "command": "运行命令",
            "tool": "调用工具", "editing": "编辑文件", "subagent": "子代理", "compacting": "压缩上下文",
            "approval": "等待批准", "question": "等待回答"][kind] ?? "运行中"
}

func displayPath(_ path: String) -> String {
    let home = NSHomeDirectory()
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}

// MARK: Visual primitives

func dynamicColor(light: NSColor, dark: NSColor) -> NSColor {
    NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light }
}
func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

enum Palette {
    static let group = dynamicColor(light: NSColor(white: 0, alpha: 0.03), dark: NSColor(white: 1, alpha: 0.05))
    static let separator = dynamicColor(light: NSColor(white: 0, alpha: 0.06), dark: NSColor(white: 1, alpha: 0.08))
    static let track = dynamicColor(light: NSColor(white: 0, alpha: 0.09), dark: NSColor(white: 1, alpha: 0.12))
    static let tile = dynamicColor(light: NSColor(white: 0, alpha: 0.05), dark: NSColor(white: 1, alpha: 0.08))
    static let okFill = dynamicColor(light: rgb(0x34C759, 0.14), dark: rgb(0x30D158, 0.18))
    static let okInk = dynamicColor(light: rgb(0x1F7A38), dark: rgb(0x30D158))
    static let warnFill = dynamicColor(light: rgb(0xFF8D28, 0.16), dark: rgb(0xFF9230, 0.18))
    static let warnInk = dynamicColor(light: rgb(0xA84B00), dark: rgb(0xFF9230))
}

/// Remaining quota at or below this share reads as a warning.
let lowRemaining = 20

func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight); field.textColor = color
    field.lineBreakMode = .byTruncatingTail; field.maximumNumberOfLines = 1
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
}

func tabular(_ field: NSTextField) -> NSTextField {
    let size = field.font?.pointSize ?? 13
    field.font = .monospacedDigitSystemFont(ofSize: size, weight: .regular)
    return field
}

@discardableResult
func pin(_ view: NSView, width: CGFloat? = nil, height: CGFloat? = nil) -> NSView {
    view.translatesAutoresizingMaskIntoConstraints = false
    if let width { view.widthAnchor.constraint(equalToConstant: width).isActive = true }
    if let height { view.heightAnchor.constraint(equalToConstant: height).isActive = true }
    return view
}

func hstack(_ views: [NSView], spacing: CGFloat = 10) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .horizontal; stack.alignment = .centerY; stack.spacing = spacing; stack.distribution = .fill
    return stack
}

func vstack(_ views: [NSView], spacing: CGFloat) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = spacing
    return stack
}

/// A flexible gap inside a horizontal stack.
func spacer() -> NSView {
    let view = NSView(); view.setContentHuggingPriority(.init(1), for: .horizontal)
    return view
}

class FillView: NSView {
    var fill: NSColor { didSet { needsDisplay = true } }
    init(_ fill: NSColor, radius: CGFloat = 0) {
        self.fill = fill
        super.init(frame: .zero)
        wantsLayer = true; layer?.cornerRadius = radius; layer?.cornerCurve = .continuous
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override var wantsUpdateLayer: Bool { true }
    // AppKit makes the effective appearance current here, so dynamic colors resolve correctly.
    override func updateLayer() { layer?.backgroundColor = fill.cgColor }
}

final class Pill: FillView {
    private let text = label("", size: 11, weight: .semibold)
    init() {
        super.init(Palette.tile, radius: 10)
        text.translatesAutoresizingMaskIntoConstraints = false
        text.setContentCompressionResistancePriority(.required, for: .horizontal)
        addSubview(text)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 20),
            text.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            text.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func show(_ title: String, tone: String) {
        text.stringValue = title
        switch tone {
        case "ok": fill = Palette.okFill; text.textColor = Palette.okInk
        case "warn": fill = Palette.warnFill; text.textColor = Palette.warnInk
        default: fill = Palette.tile; text.textColor = .secondaryLabelColor
        }
    }
}

final class UsageBar: NSView {
    var remaining: Int = 0 { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        Palette.track.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        guard remaining > 0 else { return }
        var filled = bounds
        filled.size.width = max(bounds.height, bounds.width * CGFloat(min(100, remaining)) / 100)
        (remaining <= lowRemaining ? NSColor.systemOrange : NSColor.systemBlue).setFill()
        NSBezierPath(roundedRect: filled, xRadius: radius, yRadius: radius).fill()
    }
}

/// Claude Code's pixel mascot on its dark tile, drawn at any size from the 16×10 source grid.
func clawdImage(size: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
        rgb(0x1F1E1D).setFill()
        NSBezierPath(roundedRect: rect, xRadius: rect.width / 4, yRadius: rect.width / 4).fill()
        let unit = rect.width / 24, origin = NSPoint(x: rect.width / 2 - 8 * unit, y: rect.height / 2 - 5 * unit)
        rgb(0xD97757).setFill()
        let pixels: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
            (3, 0, 12, 2), (3, 2, 2, 2), (6, 2, 6, 2), (13, 2, 2, 2), (1, 4, 16, 2), (3, 6, 12, 2),
            (4, 8, 1, 2), (6, 8, 1, 2), (11, 8, 1, 2), (13, 8, 1, 2),
        ]
        for (x, y, width, height) in pixels {
            NSRect(x: origin.x + (x - 1) * unit, y: origin.y + y * unit, width: width * unit, height: height * unit).fill()
        }
        return true
    }
}

final class FlippedView: NSView { override var isFlipped: Bool { true } }

extension NSToolbarItem.Identifier {
    static let links = NSToolbarItem.Identifier("links")
    static let action = NSToolbarItem.Identifier("action")
}

/// One Dashboard component card: icon and health pill on top, name and version below.
final class ComponentCard {
    let view = FillView(Palette.group, radius: 12)
    let pill = Pill()
    let version = tabular(label("—", size: 11, color: .secondaryLabelColor))
    let icon = NSImageView()
    init(name: String) {
        icon.imageScaling = .scaleProportionallyUpOrDown
        pin(icon, width: 36, height: 36)
        let top = hstack([icon, spacer(), pill]); top.alignment = .top
        let nameLabel = label(name, weight: .semibold)
        let content = vstack([top, vstack([nameLabel, version], spacing: 2)], spacing: 12)
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            content.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -14),
            top.widthAnchor.constraint(equalTo: content.widthAnchor),
        ])
    }
}

// MARK: App

final class HostMenu: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, NSToolbarDelegate {
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
    private var dashboard: NSWindow?
    private var dashboardTimer: Timer?
    private var actionItem: NSToolbarItem?
    private var errorLabel: NSTextField?
    private var appCard: ComponentCard?
    private var cliCard: ComponentCard?
    private var hostCard: ComponentCard?
    private var usageSummary: NSTextField?
    private var usageList: NSStackView?
    private var taskSummary: NSTextField?
    private var taskList: NSStackView?

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
        let environment = ProcessInfo.processInfo.environment
        if environment["CODEXHOST_SHOW_DASHBOARD"] == "1" || environment["CODEXHOST_SHOW_STATUS_WINDOW"] == "1" { showDashboard() }
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

    private var phase: String { state["phase"] as? String ?? "detached" }
    private var connected: Bool { phase == "attached" || phase == "draining" }
    private var tasks: [[String: Any]] { state["tasks"] as? [[String: Any]] ?? [] }
    private var activeTasks: [[String: Any]] { tasks.filter { $0["status"] as? String != "idle" } }
    private var meters: [[String: Any]] { state["usage"] as? [[String: Any]] ?? [] }
    private var runningText: String {
        activeTasks.isEmpty ? "没有运行中的任务" : "\(activeTasks.count) 个任务运行中"
    }

    // MARK: Menu

    private func item(_ title: String, _ action: Selector? = nil, key: String = "", enabled: Bool = true) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self; entry.isEnabled = enabled && action != nil; menu.addItem(entry)
    }
    /// Custom rows share the inset of the menu's own titles and shortcuts.
    private func menuRow(_ views: [NSView], height: CGFloat) -> NSMenuItem {
        let row = hstack(views, spacing: 12)
        row.edgeInsets = NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 18)
        row.frame = NSRect(x: 0, y: 0, width: 240, height: height)
        row.heightAnchor.constraint(equalToConstant: height).isActive = true
        row.widthAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true
        let entry = NSMenuItem(); entry.view = row
        return entry
    }
    /// The read-only status block; a custom view keeps its colors instead of the disabled dimming.
    private func statusMenuItem() -> NSMenuItem {
        let lines: [NSView] = [label(phaseLabels[phase] ?? phase, weight: .semibold)]
            + (connected ? [label(runningText, color: .secondaryLabelColor)] : [])
            + ((state["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }.map { error in
                let line = label(error, color: .secondaryLabelColor); line.toolTip = error
                return [line]
            } ?? [])
        let block = vstack(lines, spacing: 2)
        block.edgeInsets = NSEdgeInsets(top: 4, left: 16, bottom: 5, right: 18)
        block.frame = NSRect(x: 0, y: 0, width: 240, height: block.fittingSize.height)
        block.widthAnchor.constraint(equalToConstant: 240).isActive = true
        let entry = NSMenuItem(); entry.view = block
        return entry
    }
    private func usageMenuItems() -> [NSMenuItem] {
        guard connected, !meters.isEmpty else { return [] }
        let heading = label("用量", size: 11, weight: .semibold, color: .secondaryLabelColor)
        let remaining = label("剩余", size: 11, color: .secondaryLabelColor)
        var items = [menuRow([heading, spacer(), remaining], height: 20)]
        for meter in meters {
            let name = meter["label"] is String ? meterWindowLabel(meter)
                : "\(productName(meter["source"] as? String ?? "", short: true)) \(meterWindowLabel(meter))"
            let title = label(name)
            title.setContentHuggingPriority(.init(1), for: .horizontal)
            var views: [NSView] = [title]
            var tip = name
            if let left = meter["remainingPercent"] as? Int {
                let bar = UsageBar(); bar.remaining = left
                views.append(pin(bar, width: 56, height: 5))
                tip += " · 剩余 \(left)%"
            } else {
                views.append(label(meter["text"] as? String ?? "—", color: .secondaryLabelColor))
            }
            if let reset = parseDate(meter["resetsAt"]) { tip += " · \(resetText(reset)) 重置" }
            let entry = menuRow(views, height: 22)
            entry.view?.toolTip = tip
            items.append(entry)
        }
        return items
    }
    private func updateMenu() {
        statusItem?.button?.image = statusIcon(phase)
        statusItem?.button?.toolTip = "Codex Host · " + (phaseLabels[phase] ?? phase)
        updateDashboard()
        if menuOpen { return }
        menu.removeAllItems(); menu.autoenablesItems = false
        menu.addItem(statusMenuItem())
        let usage = usageMenuItems()
        if !usage.isEmpty { menu.addItem(.separator()); usage.forEach(menu.addItem) }
        menu.addItem(.separator())
        if phase == "attached" { item("断开（等待任务完成）", #selector(disconnect)) }
        else if phase == "draining" {
            item("取消断开", #selector(cancelDisconnect))
            item("停止外部任务并断开…", #selector(stopAndDisconnect))
        } else { item("接入 Codex App", #selector(connect), enabled: phase == "detached" || phase == "error") }
        item("Dashboard…", #selector(showDashboard), key: "d")
        menu.addItem(.separator())
        item(quitting ? "正在退出…" : "退出 Codex Host", #selector(quitHost), key: "q", enabled: !quitting)
    }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = false; updateMenu(); menuOpen = true; send("status") }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; updateMenu() }

    // MARK: Actions

    @objc private func connect() { if child?.isRunning != true { startHost() } else { send("attach") } }
    @objc private func disconnect() { send("detach") }
    @objc private func cancelDisconnect() { quitting = false; send("cancel-drain") }
    @objc private func stopAndDisconnect() {
        let alert = NSAlert(); alert.messageText = "停止外部任务并断开？"
        alert.informativeText = "正在运行的 Claude 任务会被中断，已保存的历史会保留。Codex App 和 GPT 任务会继续运行。"
        alert.addButton(withTitle: "停止并断开"); alert.addButton(withTitle: "继续等待")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { send("stop-and-detach") }
    }
    @objc private func primaryAction() {
        switch phase {
        case "attached": disconnect()
        case "draining": cancelDisconnect()
        default: connect()
        }
    }
    @objc private func linkAction(_ sender: NSToolbarItemGroup) {
        if sender.selectedIndex == 0 { openDesktop() } else { openLogs() }
    }
    @objc private func openDesktop() {
        let path = state["appPath"] as? String ?? "/Applications/ChatGPT.app"
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: NSWorkspace.OpenConfiguration())
    }
    @objc private func openLogs() { if let logURL { NSWorkspace.shared.open(logURL) } }

    // MARK: Dashboard

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .links, .action] }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .links, .action] }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch identifier {
        case .links:
            let images = ["arrow.up.forward.app", "doc.text"].map { NSImage(systemSymbolName: $0, accessibilityDescription: nil)! }
            let group = NSToolbarItemGroup(itemIdentifier: identifier, images: images, selectionMode: .momentary,
                                           labels: ["打开 Codex App", "查看诊断日志"], target: self, action: #selector(linkAction(_:)))
            group.subitems[0].toolTip = "打开 Codex App"; group.subitems[1].toolTip = "查看诊断日志"
            return group
        case .action:
            let item = NSToolbarItem(itemIdentifier: identifier)
            item.isBordered = true; item.autovalidates = false
            item.target = self; item.action = #selector(primaryAction)
            actionItem = item
            return item
        default:
            return nil
        }
    }

    private func section(_ title: String, summary: NSTextField?, content: NSView) -> NSView {
        let heading = label(title, weight: .semibold)
        heading.setContentHuggingPriority(.init(1), for: .horizontal)
        let header = hstack(summary.map { [heading, $0] } ?? [heading])
        header.alignment = .firstBaseline
        header.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)
        let stack = vstack([header, content], spacing: 6)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        content.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }
    /// A grouped panel whose rows are separated by hairlines inset with the content.
    private func panel() -> (FillView, NSStackView) {
        let box = FillView(Palette.group, radius: 12)
        let rows = vstack([], spacing: 0)
        rows.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(rows)
        NSLayoutConstraint.activate([
            rows.topAnchor.constraint(equalTo: box.topAnchor),
            rows.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            rows.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 10),
            rows.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
        ])
        return (box, rows)
    }
    private func setRows(_ list: NSStackView, _ rows: [NSView]) {
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (index, row) in rows.enumerated() {
            if index > 0 {
                let line = pin(FillView(Palette.separator), height: 1)
                list.addArrangedSubview(line)
                line.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
            }
            pin(row, height: 36)
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
    }
    private func noteRow(_ text: String) -> NSView { hstack([label(text, color: .secondaryLabelColor)]) }

    @objc private func showDashboard() {
        if dashboard == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
                                  styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Codex Host"; window.isReleasedWhenClosed = false; window.delegate = self
            let toolbar = NSToolbar(identifier: "dashboard")
            toolbar.delegate = self; toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
            window.toolbar = toolbar; window.toolbarStyle = .unified

            let error = NSTextField(wrappingLabelWithString: "")
            error.textColor = .systemRed; error.font = .systemFont(ofSize: 12); errorLabel = error

            let app = ComponentCard(name: "Codex App"), cli = ComponentCard(name: "Claude Code CLI"), host = ComponentCard(name: "Codex Host")
            cli.icon.image = clawdImage(size: 36)
            host.icon.image = NSApp.applicationIconImage
            host.version.stringValue = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
            appCard = app; cliCard = cli; hostCard = host
            let cards = NSStackView(views: [app.view, cli.view, host.view])
            cards.orientation = .horizontal; cards.distribution = .fillEqually; cards.spacing = 10; cards.alignment = .top

            let usageSummary = label("", size: 11, color: .secondaryLabelColor); self.usageSummary = usageSummary
            let (usageBox, usageRows) = panel(); usageList = usageRows
            let taskSummary = label("", size: 11, color: .secondaryLabelColor); self.taskSummary = taskSummary
            let (taskBox, taskRows) = panel(); taskList = taskRows

            let stack = vstack([error, section("组件", summary: nil, content: cards),
                                section("用量", summary: usageSummary, content: usageBox),
                                section("外部任务", summary: taskSummary, content: taskBox)], spacing: 20)
            stack.edgeInsets = NSEdgeInsets(top: 8, left: 20, bottom: 20, right: 20)
            stack.translatesAutoresizingMaskIntoConstraints = false
            for view in stack.arrangedSubviews { view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true }
            let content = window.contentView!
            content.addSubview(stack)
            // The window takes its height from the content, growing with the task list.
            NSLayoutConstraint.activate([
                stack.topAnchor.constraint(equalTo: content.topAnchor),
                stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                stack.widthAnchor.constraint(equalToConstant: 640),
            ])
            dashboard = window
            updateDashboard()
            window.center()
        }
        dashboard?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        send("status")
        dashboardTimer?.invalidate()
        // Elapsed times tick locally; the Host is asked again only every few seconds.
        var ticks = 0
        dashboardTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            ticks += 1; if ticks % 5 == 0 { self?.send("status") }
            self?.updateDashboard()
        }
        updateMenu()
    }
    func windowWillClose(_ notification: Notification) {
        dashboardTimer?.invalidate(); dashboardTimer = nil
    }

    private func updateDashboard() {
        guard let dashboard, let taskList, let usageList else { return }
        dashboard.subtitle = connected ? "\(shortPhaseLabels[phase] ?? phase) · \(runningText)" : shortPhaseLabels[phase] ?? phase
        if let actionItem {
            actionItem.title = ["attached": "断开", "draining": "取消断开", "attaching": "接入中", "detaching": "断开中"][phase] ?? "接入"
            actionItem.isEnabled = phase != "attaching" && phase != "detaching"
            if #available(macOS 26.0, *) { actionItem.style = connected || !actionItem.isEnabled ? .plain : .prominent }
        }
        let error = state["error"] as? String ?? ""
        errorLabel?.stringValue = error; errorLabel?.isHidden = error.isEmpty

        let appPath = state["appPath"] as? String ?? "/Applications/ChatGPT.app"
        if let icon = appCard?.icon, icon.image == nil {
            // The bundled Codex icon is full-bleed; the system masks it only where it draws app icons.
            if let codex = NSImage(contentsOfFile: appPath + "/Contents/Resources/app.icns") {
                icon.image = codex; icon.wantsLayer = true
                icon.layer?.cornerRadius = 8; icon.layer?.cornerCurve = .continuous; icon.layer?.masksToBounds = true
            } else {
                icon.image = NSWorkspace.shared.icon(forFile: appPath)
            }
        }
        appCard?.version.stringValue = state["appVersion"] as? String ?? "未安装"
        let appRunning = state["appRunning"] as? Bool == true
        appCard?.pill.show(appRunning ? "运行中" : "未运行", tone: appRunning ? "ok" : "off")

        let claude = (state["harnesses"] as? [[String: Any]] ?? []).first { $0["harnessId"] as? String == "claude-code" }
        cliCard?.version.stringValue = claude?["version"] as? String ?? "—"
        cliCard?.version.toolTip = (claude?["executable"] as? String).map(displayPath)
        let processes = state["claudeProcesses"] as? Int ?? 0
        if let claude, claude["executable"] == nil || claude["executable"] is NSNull {
            cliCard?.pill.show("未安装", tone: "warn")
        } else {
            cliCard?.pill.show(processes > 0 ? "\(processes) 个进程" : "没有进程", tone: processes > 0 ? "ok" : "off")
        }
        let hostPill: [String: (String, String)] = ["attached": ("已接入", "ok"), "draining": ("等待断开", "warn"),
                                                   "attaching": ("接入中", "off"), "detaching": ("断开中", "off")]
        let (hostText, hostTone) = hostPill[phase] ?? ("未接入", "warn")
        hostCard?.pill.show(hostText, tone: hostTone)

        usageSummary?.stringValue = parseDate(state["usageObservedAt"]).map { "更新于 " + dateText("HH:mm", $0) } ?? ""
        if meters.isEmpty {
            setRows(usageList, [noteRow(connected ? "正在读取 Codex 和 Claude Code 的剩余额度…"
                                                  : "接入 Codex App 后显示 Codex 和 Claude Code 的剩余额度。")])
        } else {
            var previous: String?
            setRows(usageList, meters.map { meter in
                let source = meter["source"] as? String ?? ""
                defer { previous = source }
                return usageRow(meter, product: source == previous ? "" : productName(source, short: false))
            })
        }

        let running = activeTasks.count
        taskSummary?.stringValue = tasks.isEmpty ? "" : "\(running) 个运行中 · 共 \(tasks.count) 个会话"
        if tasks.isEmpty {
            setRows(taskList, [noteRow(connected ? "当前没有外部任务。在 Codex App 里选择 Claude 模型即可开始。"
                                                 : "接入 Codex App 后，这里会列出每个 Claude 会话所在的项目和正在做的事。")])
        } else {
            let order = ["running": 0, "background": 1, "idle": 2]
            let sorted = tasks.sorted { (order[$0["status"] as? String ?? ""] ?? 3) < (order[$1["status"] as? String ?? ""] ?? 3) }
            var rows = sorted.prefix(12).map(taskRow)
            if sorted.count > 12 { rows.append(noteRow("另外 \(sorted.count - 12) 个会话")) }
            setRows(taskList, rows)
        }
        fitDashboard()
    }

    /// Sizes the window to its content, keeping the top edge where the user left it.
    private func fitDashboard() {
        guard let dashboard, let content = dashboard.contentView, let stack = content.subviews.first else { return }
        let size = stack.fittingSize
        guard abs(content.frame.height - size.height) > 0.5 else { return }
        var frame = dashboard.frameRect(forContentRect: NSRect(origin: .zero, size: size))
        frame.origin = NSPoint(x: dashboard.frame.minX, y: dashboard.frame.maxY - frame.height)
        dashboard.setFrame(frame, display: true)
    }

    private func usageRow(_ meter: [String: Any], product: String) -> NSView {
        let productLabel = pin(label(product), width: 96)
        let windowLabel = label(meterWindowLabel(meter), color: .secondaryLabelColor)
        let reset = parseDate(meter["resetsAt"])
        let resetLabel = pin(tabular(label(resetText(reset), color: .tertiaryLabelColor)), width: 84)
        (resetLabel as? NSTextField)?.alignment = .right
        resetLabel.toolTip = reset.map { dateText("M月d日 EEE HH:mm", $0) + " 重置" }
        guard let left = meter["remainingPercent"] as? Int else {
            let text = label(meter["text"] as? String ?? "—", color: .secondaryLabelColor)
            text.alignment = .right; windowLabel.setContentHuggingPriority(.init(1), for: .horizontal)
            return hstack([productLabel, windowLabel, text, resetLabel])
        }
        pin(windowLabel, width: 84)
        let bar = UsageBar(); bar.remaining = left
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.heightAnchor.constraint(equalToConstant: 4).isActive = true
        bar.setContentHuggingPriority(.init(1), for: .horizontal)
        let value = pin(tabular(label("剩余 \(left)%", color: left <= lowRemaining ? .systemOrange : .labelColor)), width: 64)
        (value as? NSTextField)?.alignment = .right
        return hstack([productLabel, windowLabel, bar, value, resetLabel])
    }

    private func taskRow(_ task: [String: Any]) -> NSView {
        let status = task["status"] as? String ?? "idle"
        let activity = task["activity"] as? [String: Any]
        let cwd = task["cwd"] as? String ?? ""
        let project = URL(fileURLWithPath: cwd).lastPathComponent
        var title = task["title"] as? String ?? "未命名会话"
        if task["subagent"] as? Bool == true { title = "子代理 · " + title }
        let titleLabel = label(title)
        titleLabel.setContentHuggingPriority(.init(1), for: .horizontal)
        let projectLabel = pin(label(project.isEmpty ? "—" : project, color: .secondaryLabelColor), width: 136)
        var statusText: String
        switch status {
        case "running":
            statusText = activityText(activity)
            if let started = activity?["startedAtMs"] as? Double { statusText += " " + clockText(since: started) }
        case "background": statusText = "\(task["backgroundTasks"] as? Int ?? 0) 个后台任务"
        default: statusText = "空闲"
        }
        let statusLabel = tabular(label(statusText, color: status == "idle" ? .tertiaryLabelColor : .secondaryLabelColor))
        statusLabel.alignment = .right
        pin(statusLabel, width: 104)
        let row = hstack([titleLabel, projectLabel, statusLabel])
        row.toolTip = [displayPath(cwd), task["model"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
        return row
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showDashboard(); return true
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
