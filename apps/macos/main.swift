import AppKit
import ServiceManagement

// MARK: Identity

// The App's name, identifier and data locations; tools/app/build.mjs writes the first two into Info.plist.
let defaultAppName = "Claude in Codex"
let defaultBundleIdentifier = "ai.bytepioneer.claude-in-codex"
let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? defaultAppName
let bundleIdentifier = Bundle.main.bundleIdentifier ?? defaultBundleIdentifier
let environment = ProcessInfo.processInfo.environment
/// Bundle identifier of the menu bar App before the rename; it must quit before this one takes over its data.
let legacyBundleIdentifier = "dev.codexhost.menubar"
/// A development override of the data folder; the legacy variable name still works.
let dataDirectoryOverride = environment["CLAUDE_IN_CODEX_DATA_DIR"] ?? environment["CODEXHOST_DATA_DIR"]
/// The Host's data folder. Without an override the node Host resolves the same folder and moves
/// data left in ~/.codexhost by the pre-rename App into it.
let dataDirectory = URL(fileURLWithPath: dataDirectoryOverride
    ?? NSHomeDirectory() + "/Library/Application Support/" + defaultAppName)
/// ~/Library/Logs/Claude in Codex, or a logs folder inside an overridden data folder.
let logDirectory = dataDirectoryOverride != nil
    ? dataDirectory.appendingPathComponent("logs")
    : URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/" + defaultAppName)
let logFile = logDirectory.appendingPathComponent("host.log")
let defaultDesktopApp = environment["CLAUDE_IN_CODEX_DESKTOP_APP"] ?? "/Applications/ChatGPT.app"

/// Launch preferences saved in UserDefaults; a matching environment variable overrides one for development.
enum LaunchPreference: String, CaseIterable {
    case autoAttach = "AutoAttachAtLaunch", showDashboard = "ShowDashboardAtLaunch"
    var title: String { self == .autoAttach ? "启动时自动接入 Codex App" : "启动时打开 Dashboard" }
    var variables: [String] { self == .autoAttach ? ["CLAUDE_IN_CODEX_AUTO_ATTACH"] : ["CLAUDE_IN_CODEX_SHOW_DASHBOARD", "CLAUDE_IN_CODEX_SHOW_STATUS_WINDOW"] }
    var override: String? { variables.first { environment[$0] != nil } }
    var enabled: Bool {
        if override != nil {
            return self == .autoAttach ? environment["CLAUDE_IN_CODEX_AUTO_ATTACH"] != "0" : variables.contains { environment[$0] == "1" }
        }
        return UserDefaults.standard.object(forKey: rawValue) as? Bool ?? (self == .autoAttach)
    }
}

/// Resources/build.json written by the build: revision, sourceDigest, node and builtAt.
func buildInfo() -> [String: Any]? {
    guard let url = Bundle.main.url(forResource: "build", withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

/// The Claude cloud from apps/macos/icon/Claude-Icon.svg (#cloud-silhouette): a 1024-point canvas, y down.
let cloudOutline = "M 703.082 701.419 C 689.910 756.413 643.947 798.291 590.713 812.172 C 538.628 825.753 479.582 812.533 441.906 771.661 C 387.566 788.081 328.005 769.397 289.273 730.083 C 251.424 691.666 233.463 633.550 249.703 580.541 C 208.833 542.220 195.046 481.817 209.468 429.237 C 223.763 377.124 265.771 332.696 319.496 319.496 C 332.806 265.403 377.944 223.058 430.539 209.072 C 482.841 195.163 542.518 209.298 580.425 250.146 C 633.986 233.565 692.455 251.878 731.108 290.166 C 769.756 328.448 788.593 386.698 772.493 440.462 C 812.285 478.967 826.544 538.576 812.909 590.940 C 799.234 643.455 757.502 688.682 703.082 701.419 Z"
/// The pixel eyes on the 18-point mark grid, widened from the icon's 1.3 points so they survive a 1x menu bar.
let cloudEyes = [NSRect(x: 5.5, y: 7, width: 2, height: 4), NSRect(x: 10.5, y: 7, width: 2, height: 4)]

/// The cloud fitted to the 18-point mark grid, y up; the source spans 195...827 on both axes.
func cloudPath() -> NSBezierPath {
    let numbers = cloudOutline.split(separator: " ").compactMap { Double($0) }.map { CGFloat($0) }
    func point(_ i: Int) -> NSPoint { NSPoint(x: 1 + (numbers[i] - 195) * 16 / 632, y: 17 - (numbers[i + 1] - 195) * 16 / 632) }
    let path = NSBezierPath()
    path.move(to: point(0))
    for i in stride(from: 2, to: numbers.count, by: 6) { path.curve(to: point(i + 4), controlPoint1: point(i), controlPoint2: point(i + 2)) }
    path.close()
    return path
}

/// Runs draw with rect mapped to the 18-point mark grid.
func inMarkGrid(_ rect: NSRect, _ draw: () -> Void) {
    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.translateX(by: rect.minX, yBy: rect.minY)
    transform.scaleX(by: rect.width / 18, yBy: rect.height / 18)
    transform.concat()
    draw()
    NSGraphicsContext.restoreGraphicsState()
}

/// The menu bar mark, whose eyes show the phase: open eyes cut from a solid cloud when attached, three dots
/// while attaching or draining, "!" on error, and closed eyes in an outlined cloud otherwise.
func drawMark(_ rect: NSRect, phase: String, color: NSColor) {
    inMarkGrid(rect) {
        color.setStroke(); color.setFill()
        let cloud = cloudPath()
        let holes: [NSBezierPath]
        switch phase {
        case "attached":
            holes = cloudEyes.map { NSBezierPath(rect: $0) }
        case "attaching", "draining", "detaching":
            holes = [6.0, 9.0, 12.0].map { NSBezierPath(ovalIn: NSRect(x: $0 - 0.9, y: 8.1, width: 1.8, height: 1.8)) }
        case "error":
            holes = [NSBezierPath(roundedRect: NSRect(x: 8.1, y: 8.3, width: 1.8, height: 4.4), xRadius: 0.9, yRadius: 0.9),
                     NSBezierPath(ovalIn: NSRect(x: 8.1, y: 5.3, width: 1.8, height: 1.8))]
        default:
            cloud.lineWidth = 1.3; cloud.stroke()
            for eye in cloudEyes { NSBezierPath(rect: NSRect(x: eye.minX, y: 8.35, width: eye.width, height: 1.3)).fill() }
            return
        }
        holes.forEach { cloud.append($0) }
        cloud.windingRule = .evenOdd; cloud.fill()
    }
}

func statusIcon(_ phase: String) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
        drawMark(rect, phase: phase, color: .black); return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "\(appName) \(phase)"
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

/// The Claude cloud in Claude orange with white pixel eyes, on Claude Code's dark tile.
func claudeCodeImage(size: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
        rgb(0x1F1E1D).setFill()
        NSBezierPath(roundedRect: rect, xRadius: rect.width / 4, yRadius: rect.width / 4).fill()
        inMarkGrid(rect.insetBy(dx: rect.width / 7, dy: rect.width / 7)) {
            rgb(0xD97757).setFill(); cloudPath().fill()
            NSColor.white.setFill(); cloudEyes.forEach { NSBezierPath(rect: $0).fill() }
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
    private var legacyObserver: NSObjectProtocol?
    private var launched = false
    private let menu = NSMenu()
    private var child: Process?
    private var control: FileHandle?
    private var readBuffer = Data()
    private var state: [String: Any] = ["phase": "detached"]
    private var quitting = false
    private var allowExit = false
    private var menuOpen = false
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
    private var settings: NSWindow?
    private var loginToggle: NSButton?
    private var loginApproval: NSStackView?
    private var appPathLabel: NSTextField?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let running = earlierInstance() { handOff(to: running); return }
        NSApp.setActivationPolicy(.accessory)
        if runningLegacyApp() != nil { waitForLegacyApp(); return }
        finishLaunching()
    }

    /// The pre-rename Codex Host, if it is still running. Both would attach to the same Desktop
    /// and write the same Mapping Store, so this App waits for it to quit.
    private func runningLegacyApp() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: legacyBundleIdentifier).first { !$0.isTerminated }
    }
    private func waitForLegacyApp() {
        let alert = NSAlert()
        alert.messageText = "旧版 Codex Host 正在运行"
        alert.informativeText = "\(appName) 会接管 Codex Host 的模型偏好和线程记录。请在 Codex Host 的菜单里选择「退出 Codex Host」，等它的任务完成后退出；\(appName) 会随后自动继续启动。"
        alert.addButton(withTitle: "等待 Codex Host 退出")
        alert.addButton(withTitle: "退出 \(appName)")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { exit(0) }
        legacyObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            guard app?.bundleIdentifier == legacyBundleIdentifier else { return }
            self?.finishLaunchingAfterLegacyApp()
        }
        finishLaunchingAfterLegacyApp()
    }
    private func finishLaunchingAfterLegacyApp() {
        guard runningLegacyApp() == nil, let observer = legacyObserver else { return }
        NSWorkspace.shared.notificationCenter.removeObserver(observer); legacyObserver = nil
        finishLaunching()
    }

    private func finishLaunching() {
        guard !launched else { return }
        launched = true
        let applicationMenu = NSMenu()
        let appItem = NSMenuItem()
        applicationMenu.addItem(appItem)
        let appSubmenu = NSMenu()
        appSubmenu.addItem(withTitle: "关于 \(appName)", action: #selector(showAbout), keyEquivalent: "").target = self
        appSubmenu.addItem(.separator())
        appSubmenu.addItem(withTitle: "设置…", action: #selector(showSettings), keyEquivalent: ",").target = self
        appSubmenu.addItem(.separator())
        appSubmenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appSubmenu.addItem(withTitle: "退出 \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appSubmenu; NSApp.mainMenu = applicationMenu
        statusItem = NSStatusBar.system.statusItem(withLength: 28)
        statusItem.menu = menu; menu.delegate = self
        updateMenu(); startHost(autoAttach: LaunchPreference.autoAttach.enabled)
        if LaunchPreference.showDashboard.enabled { showDashboard() }
        // Development: open these windows at launch for UI checks.
        if environment["CLAUDE_IN_CODEX_SHOW_SETTINGS"] == "1" { showSettings() }
        if environment["CLAUDE_IN_CODEX_SHOW_ABOUT"] == "1" { showAbout() }
    }

    /// The first running copy with this bundle identifier, whatever its path; the later launch defers to it.
    private func earlierInstance() -> NSRunningApplication? {
        let current = NSRunningApplication.current
        // launchDate is nil outside LaunchServices, e.g. when the binary is run directly.
        let order = { (app: NSRunningApplication) in
            (app.launchDate ?? (app.processIdentifier == current.processIdentifier ? Date() : .distantPast), app.processIdentifier)
        }
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .filter { $0.processIdentifier != current.processIdentifier && !$0.isTerminated && order($0) < order(current) }
            .min { order($0) < order($1) }
    }
    /// Reopening the running copy makes it show its Dashboard (applicationShouldHandleReopen); this one leaves without a Host.
    private func handOff(to running: NSRunningApplication) {
        guard let url = running.bundleURL else { running.activate(); exit(0) }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in
            DispatchQueue.main.async { exit(0) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) }
    }

    private func startHost(autoAttach: Bool) {
        guard child?.isRunning != true else { return }
        readBuffer.removeAll()
        let resources = Bundle.main.resourceURL!
        let process = Process()
        process.executableURL = resources.appendingPathComponent("runtime/node")
        process.arguments = [resources.appendingPathComponent("host.mjs").path, "--claude-in-codex-menubar"]
        var hostEnvironment = environment
        for key in ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CODEX_CLI_PATH",
                    "CLAUDE_IN_CODEX_THREAD_ID", "CLAUDE_IN_CODEX_PARENT_THREAD_ID", "CODEXHOST_THREAD_ID", "CODEXHOST_PARENT_THREAD_ID"] {
            hostEnvironment.removeValue(forKey: key)
        }
        if let dataDirectoryOverride { hostEnvironment["CLAUDE_IN_CODEX_DATA_DIR"] = dataDirectoryOverride }
        if autoAttach { hostEnvironment.removeValue(forKey: "CLAUDE_IN_CODEX_AUTO_ATTACH") } else { hostEnvironment["CLAUDE_IN_CODEX_AUTO_ATTACH"] = "0" }
        process.environment = hostEnvironment
        do {
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            if !FileManager.default.fileExists(atPath: logFile.path) {
                FileManager.default.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            let log = try FileHandle(forWritingTo: logFile); try log.seekToEnd()
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
        statusItem?.button?.toolTip = "\(appName) · " + (phaseLabels[phase] ?? phase)
        updateDashboard(); appPathLabel.map { showPath($0, appPath) }
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
        item("设置…", #selector(showSettings), key: ",")
        menu.addItem(.separator())
        item("关于 \(appName)", #selector(showAbout))
        item(quitting ? "正在退出…" : "退出 \(appName)", #selector(quitHost), key: "q", enabled: !quitting)
    }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = false; updateMenu(); menuOpen = true; send("status") }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; updateMenu() }

    // MARK: Actions

    @objc private func connect() { if child?.isRunning != true { startHost(autoAttach: true) } else { send("attach") } }
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
    private var appPath: String { state["appPath"] as? String ?? defaultDesktopApp }
    @objc private func openDesktop() {
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: appPath), configuration: NSWorkspace.OpenConfiguration())
    }
    @objc private func openLogs() { NSWorkspace.shared.open(logFile) }

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
            window.title = appName; window.isReleasedWhenClosed = false; window.delegate = self
            let toolbar = NSToolbar(identifier: "dashboard")
            toolbar.delegate = self; toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
            window.toolbar = toolbar; window.toolbarStyle = .unified

            let error = NSTextField(wrappingLabelWithString: "")
            error.textColor = .systemRed; error.font = .systemFont(ofSize: 12); errorLabel = error

            let app = ComponentCard(name: "Codex App"), cli = ComponentCard(name: "Claude Code CLI"), host = ComponentCard(name: appName)
            cli.icon.image = claudeCodeImage(size: 36)
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
        guard notification.object as? NSWindow === dashboard else { return }
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

    // MARK: Settings and About

    @objc private func showAbout() {
        var options: [NSApplication.AboutPanelOptionKey: Any] = [.applicationName: appName]
        if let build = buildInfo() {
            let revision = String((build["revision"] as? String ?? "").prefix(7))
            if !revision.isEmpty { options[.version] = revision }
            let lines = [parseDate(build["builtAt"]).map { "构建于 " + dateText("yyyy年M月d日 HH:mm", $0) },
                         (build["node"] as? String).map { "Node " + $0 }].compactMap { $0 }
            let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center
            options[.credits] = NSAttributedString(string: lines.joined(separator: "\n"), attributes: [
                .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph])
        }
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: options)
    }

    /// A path shown in full as a tooltip and shortened with ~ in the label.
    private func showPath(_ field: NSTextField, _ path: String) {
        field.stringValue = displayPath(path); field.toolTip = path
    }
    private func pathRow(_ path: String, _ buttons: [(String, Selector)]) -> (NSStackView, NSTextField) {
        let field = label("", color: .secondaryLabelColor)
        field.lineBreakMode = .byTruncatingMiddle; field.isSelectable = true; showPath(field, path)
        let actions = buttons.map { title, action -> NSView in
            let button = NSButton(title: title, target: self, action: action); button.controlSize = .small
            return button
        }
        return (vstack([field, hstack(actions, spacing: 8)], spacing: 6), field)
    }

    @objc private func showSettings() {
        if settings == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 320),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "设置"; window.isReleasedWhenClosed = false; window.delegate = self

            let login = NSButton(checkboxWithTitle: "登录时启动", target: self, action: #selector(toggleLogin(_:)))
            let approve = NSButton(title: "打开登录项设置…", target: self, action: #selector(openLoginItems)); approve.controlSize = .small
            let approval = vstack([label("需要在“系统设置 › 通用 › 登录项”中允许 \(appName)。", size: 11, color: .secondaryLabelColor), approve], spacing: 6)
            loginToggle = login; loginApproval = approval
            let options = LaunchPreference.allCases.map { preference -> NSView in
                let box = NSButton(checkboxWithTitle: preference.title, target: self, action: #selector(togglePreference(_:)))
                box.identifier = NSUserInterfaceItemIdentifier(preference.rawValue)
                box.state = preference.enabled ? .on : .off
                guard let variable = preference.override else { return box }
                box.isEnabled = false
                return vstack([box, label("当前由环境变量 \(variable) 决定", size: 11, color: .secondaryLabelColor)], spacing: 2)
            }
            let launch = vstack([login, approval] + options, spacing: 8)

            let (app, appField) = pathRow(appPath, [("在 Finder 中显示", #selector(revealDesktop))])
            appPathLabel = appField
            let (data, _) = pathRow(dataDirectory.path, [("在 Finder 中显示", #selector(revealData))])
            let (logs, _) = pathRow(logFile.path, [("打开日志", #selector(openLogs)), ("在 Finder 中显示", #selector(revealLogs))])

            let rows: [(String, NSView)] = [("启动：", launch), ("Codex App：", app), ("数据目录：", data), ("日志：", logs)]
            let grid = NSGridView(views: rows.map { title, content in [label(title), content] })
            grid.rowSpacing = 18; grid.columnSpacing = 10; grid.rowAlignment = .firstBaseline
            grid.column(at: 0).xPlacement = .trailing
            grid.column(at: 1).width = 380
            grid.translatesAutoresizingMaskIntoConstraints = false
            let content = window.contentView!
            content.addSubview(grid)
            NSLayoutConstraint.activate([
                grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
                grid.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
                grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
                grid.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            ])
            settings = window
            refreshLoginItem()
            window.center()
        }
        settings?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    /// Re-read whenever Settings comes forward, since approval happens in System Settings.
    func windowDidBecomeKey(_ notification: Notification) {
        if notification.object as? NSWindow === settings { refreshLoginItem() }
    }
    private func refreshLoginItem() {
        let status = SMAppService.mainApp.status
        loginToggle?.state = status == .enabled || status == .requiresApproval ? .on : .off
        loginApproval?.isHidden = status != .requiresApproval
        // Fit the window to the rows now shown, keeping its top edge in place.
        guard let settings, let content = settings.contentView else { return }
        var frame = settings.frameRect(forContentRect: NSRect(origin: .zero, size: content.fittingSize))
        frame.origin = NSPoint(x: settings.frame.minX, y: settings.frame.maxY - frame.height)
        settings.setFrame(frame, display: true)
    }
    @objc private func toggleLogin(_ sender: NSButton) {
        do {
            if sender.state == .on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            let alert = NSAlert(); alert.messageText = sender.state == .on ? "无法添加登录项" : "无法移除登录项"
            alert.informativeText = error.localizedDescription
            if let settings { alert.beginSheetModal(for: settings) } else { alert.runModal() }
        }
        refreshLoginItem()
    }
    @objc private func openLoginItems() { SMAppService.openSystemSettingsLoginItems() }
    @objc private func togglePreference(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue else { return }
        UserDefaults.standard.set(sender.state == .on, forKey: key)
    }
    /// Selects the item in Finder, or its nearest existing parent before the Host has created it.
    private func reveal(_ url: URL) {
        var target = url
        while !FileManager.default.fileExists(atPath: target.path) && target.path != "/" { target.deleteLastPathComponent() }
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }
    @objc private func revealDesktop() { reveal(URL(fileURLWithPath: appPath)) }
    @objc private func revealData() { reveal(dataDirectory) }
    @objc private func revealLogs() { reveal(logFile) }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Still waiting for the pre-rename App to quit: there is no Host or menu to show yet.
        if statusItem != nil { showDashboard() }
        return true
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
