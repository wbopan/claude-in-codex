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
    var title: String { self == .autoAttach ? "启动时自动接入 Codex App" : "启动时打开此窗口" }
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
                   "draining": "等待 Session 完成后断开…", "detaching": "正在断开…", "error": "接入未完成"]

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

/// Claude orange, the fill of every Claude glyph on the Dashboard.
let claudeOrange = rgb(0xD97757)

/// Claude Code's Clawd, the CLI's pixel mascot, in Claude orange with no tile: body, arms and legs on a
/// 16 by 10 pixel grid (y down), the eyes cut out.
func clawdImage(size: CGFloat) -> NSImage {
    let cells = [(2, 0, 12, 8), (0, 4, 2, 2), (14, 4, 2, 2), (3, 8, 1, 2), (5, 8, 1, 2), (10, 8, 1, 2), (12, 8, 1, 2)]
    let eyes = [(4, 2, 1, 2), (11, 2, 1, 2)]
    return NSImage(size: NSSize(width: size, height: size * 10 / 16), flipped: true) { rect in
        let unit = rect.width / 16
        let path = NSBezierPath()
        for (x, y, w, h) in cells + eyes {
            path.append(NSBezierPath(rect: NSRect(x: CGFloat(x) * unit, y: CGFloat(y) * unit, width: CGFloat(w) * unit, height: CGFloat(h) * unit)))
        }
        path.windingRule = .evenOdd; claudeOrange.setFill(); path.fill()
        return true
    }
}

/// The Claude cloud in Claude orange with no tile, the eyes cut out. The cloud is a fuller shape than the
/// Codex cloud, so it sits inset from the box to read as the same size.
func claudeCloudImage(size: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
        inMarkGrid(rect.insetBy(dx: size / 16, dy: size / 16)) {
            let cloud = cloudPath()
            cloudEyes.forEach { cloud.append(NSBezierPath(rect: $0)) }
            cloud.windingRule = .evenOdd; claudeOrange.setFill(); cloud.fill()
        }
        return true
    }
}

/// The App's icon drawn into a bitmap of known layout: 8-bit RGBA rows, premultiplied.
private func rgbaBitmap(_ path: String) -> NSBitmapImageRep? {
    guard let image = NSImage(contentsOfFile: path), let source = image.representations.first else { return nil }
    let width = source.pixelsWide, height = source.pixelsHigh
    guard width > 0, height > 0, let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                                                                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                                bytesPerRow: width * 4, bitsPerPixel: 32) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    image.draw(in: NSRect(x: 0, y: 0, width: width, height: height), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return bitmap
}

/// The Codex cloud lifted off its tile. The App ships its icon rendered on a light and on a dark tile; the
/// opaque pixels the two share are the cloud, the rest is tile and shadow. Nil when the App lacks either render.
func codexCloudImage(appPath: String) -> NSImage? {
    let resources = appPath + "/Contents/Resources/"
    guard let light = rgbaBitmap(resources + "icon-codex-light.png"), let dark = rgbaBitmap(resources + "icon-codex-dark-color.png"),
          light.pixelsWide == dark.pixelsWide, light.pixelsHigh == dark.pixelsHigh,
          let lightData = light.bitmapData, let darkData = dark.bitmapData else { return nil }
    let width = light.pixelsWide, height = light.pixelsHigh
    var minX = width, minY = height, maxX = -1, maxY = -1
    for y in 0..<height {
        for x in 0..<width {
            let i = y * light.bytesPerRow + x * 4
            let shared = lightData[i + 3] == 255 && (0..<4).allSatisfy { abs(Int(lightData[i + $0]) - Int(darkData[i + $0])) <= 8 }
            if shared {
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            } else {
                for c in 0..<4 { lightData[i + c] = 0 }
            }
        }
    }
    guard maxX >= minX, maxY >= minY else { return nil }
    let cloud = NSImage(size: NSSize(width: width, height: height)); cloud.addRepresentation(light)
    let crop = NSRect(x: minX, y: height - 1 - maxY, width: maxX - minX + 1, height: maxY - minY + 1)
    return NSImage(size: crop.size, flipped: false) { rect in
        cloud.draw(in: rect, from: crop, operation: .sourceOver, fraction: 1); return true
    }
}

extension NSToolbarItem.Identifier {
    static let panes = NSToolbarItem.Identifier("panes")
    static let action = NSToolbarItem.Identifier("action")
}

/// The main window's panes, in the order of the toolbar's segmented control.
enum Pane: Int, CaseIterable {
    case overview, features, settings
    var title: String { ["概览", "功能", "设置"][rawValue] }
}

/// The Host's optional features as the 功能 pane groups them; ids match the Host's status.features.
let featureGroups: [(title: String, features: [(id: String, title: String, detail: String)])] = [
    ("工具", [("codexAppTools", "Codex App 工具", "让 Claude 新建、管理 Codex thread 并发消息"),
             ("computerUse", "Computer & Browser Use", "让 Claude 操作本机 App 和浏览器")]),
    ("记忆", [("codexMemory", "Codex 记忆注入", "把 Codex 的记忆摘要附加到 Claude 的 system prompt"),
             ("claudeMemorySync", "Claude Code 记忆同步", "把 Claude 的自动记忆同步到 Codex 的记忆")]),
    ("Session", [("idleRelease", "闲置释放", "闲置超过所选时间的 Session 释放 Claude 进程，发消息时再恢复")]),
]

/// A switch for a grouped row, sent to target when flipped.
func rowSwitch(_ target: AnyObject, _ action: Selector) -> NSSwitch {
    let toggle = NSSwitch(); toggle.target = target; toggle.action = action
    toggle.setContentHuggingPriority(.required, for: .horizontal)
    return toggle
}

/// A row's leading text: the title over a one-line note.
func titled(_ title: String, note: NSTextField) -> NSStackView {
    let text = vstack([label(title), note], spacing: 3)
    text.setContentHuggingPriority(.init(1), for: .horizontal)
    return text
}

/// The idle release choices: never, then how long a Session sits idle before release, tagged in minutes.
let idleReleaseChoices = [(0, "永不"), (5, "5 分钟"), (15, "15 分钟"), (30, "30 分钟"), (60, "1 小时"), (240, "4 小时")]

/// A popup of the idle release choices, sent to target when one is picked.
func idleReleasePopup(_ target: AnyObject, _ action: Selector) -> NSPopUpButton {
    let popup = NSPopUpButton(); popup.target = target; popup.action = action
    for (minutes, title) in idleReleaseChoices { popup.addItem(withTitle: title); popup.lastItem?.tag = minutes }
    popup.setContentHuggingPriority(.required, for: .horizontal)
    return popup
}

/// Selects the reported choice; a timeout set outside the list gets its own item.
func selectIdleRelease(_ popup: NSPopUpButton, _ feature: [String: Any]?) {
    let minutes = feature?["enabled"] as? Bool == true ? feature?["timeoutMinutes"] as? Int ?? 0 : 0
    if popup.indexOfItem(withTag: minutes) < 0 {
        let index = popup.itemArray.firstIndex { $0.tag > minutes } ?? popup.numberOfItems
        popup.insertItem(withTitle: minutes % 60 == 0 ? "\(minutes / 60) 小时" : "\(minutes) 分钟", at: index)
        popup.item(at: index)?.tag = minutes
    }
    popup.selectItem(withTag: minutes)
}

/// One row on the 功能 pane: a switch, or for idle release the popup of never and durations. The
/// description gives way to a problem the Host reports.
final class FeatureRow {
    let control: NSControl
    let view: NSStackView
    private let note: NSTextField
    private let detail: String
    private let reflect: (NSControl, [String: Any]?) -> Void
    init(id: String, title: String, detail: String, control: NSControl, reflect: @escaping (NSControl, [String: Any]?) -> Void) {
        self.detail = detail; self.control = control; self.reflect = reflect
        note = label(detail, size: 11, color: .secondaryLabelColor)
        control.identifier = NSUserInterfaceItemIdentifier(id)
        view = hstack([titled(title, note: note), control], spacing: 12)
    }
    /// Without a status entry (a Host that predates features, or none running) the control is inert.
    func show(_ feature: [String: Any]?) {
        control.isEnabled = feature != nil
        reflect(control, feature)
        if let problem = feature?["problem"] as? String, !problem.isEmpty {
            note.stringValue = problem; note.textColor = Palette.warnInk
        } else {
            note.stringValue = detail; note.textColor = .secondaryLabelColor
        }
        note.toolTip = note.stringValue
    }
}

/// A glyph fitted to glyphSize and centered in a box, so every card's icon reads as one size.
func framed(_ glyph: NSImage, box: CGFloat = 36, glyphSize: CGFloat = 26) -> NSImage {
    NSImage(size: NSSize(width: box, height: box), flipped: false) { rect in
        let scale = glyphSize / max(glyph.size.width, glyph.size.height)
        let width = glyph.size.width * scale, height = glyph.size.height * scale
        glyph.draw(in: NSRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height),
                   from: .zero, operation: .sourceOver, fraction: 1)
        return true
    }
}

/// One Dashboard component card: icon and health pill on top, name below. Every icon is a bare glyph
/// with no tile, framed at the same size.
final class ComponentCard {
    let view = FillView(Palette.group, radius: 12)
    let pill = Pill()
    let icon = NSImageView()
    func show(glyph: NSImage) { icon.image = framed(glyph) }
    init(name: String) {
        icon.imageScaling = .scaleProportionallyUpOrDown
        pin(icon, width: 36, height: 36)
        let top = hstack([icon, spacer(), pill]); top.alignment = .top
        let nameLabel = label(name, weight: .semibold)
        let content = vstack([top, nameLabel], spacing: 12)
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
    /// The main window: status, features and settings, one pane at a time.
    private var dashboard: NSWindow?
    private var dashboardTimer: Timer?
    private var pane = Pane.overview
    private var panes: [Pane: NSView] = [:]
    private var paneControl: NSSegmentedControl?
    private var actionItem: NSToolbarItem?
    private var errorLabel: NSTextField?
    private var appCard: ComponentCard?
    private var cliCard: ComponentCard?
    private var hostCard: ComponentCard?
    private var usageList: NSStackView?
    private var taskSummary: NSTextField?
    private var taskList: NSStackView?
    private var featureRows: [String: FeatureRow] = [:]
    private var loginToggle: NSSwitch?
    private var loginApproval: [NSView] = []
    private var loginRowHeight: NSLayoutConstraint?
    private var appPathLabel: NSTextField?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let running = earlierInstance() { handOff(to: running); return }
        NSApp.setActivationPolicy(.accessory)
        // The About panel is AppKit's own window, so every close is watched rather than only the Dashboard's.
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.async { self?.leaveDockIfIdle() }
        }
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
        if environment["CLAUDE_IN_CODEX_SHOW_FEATURES"] == "1" { showFeatures() }
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
    private func send(_ command: String, _ fields: [String: Any] = [:]) {
        let frame = fields.merging(["id": UUID().uuidString, "command": command]) { $1 }
        guard let control, let data = try? JSONSerialization.data(withJSONObject: frame) else { return }
        do { try control.write(contentsOf: data + Data([10])) }
        catch { state = ["phase": "error", "error": error.localizedDescription]; updateMenu() }
    }

    private var phase: String { state["phase"] as? String ?? "detached" }
    private var connected: Bool { phase == "attached" || phase == "draining" }
    private var tasks: [[String: Any]] { state["tasks"] as? [[String: Any]] ?? [] }
    private var activeTasks: [[String: Any]] { tasks.filter { $0["status"] as? String != "idle" } }
    private var meters: [[String: Any]] { state["usage"] as? [[String: Any]] ?? [] }
    private var features: [String: [String: Any]] {
        var byId: [String: [String: Any]] = [:]
        for feature in state["features"] as? [[String: Any]] ?? [] { if let id = feature["id"] as? String { byId[id] = feature } }
        return byId
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
    /// The status line doubles as the way into the main window; an error rides along as its subtitle.
    private func statusMenuItem() -> NSMenuItem {
        let title = phaseLabels[phase] ?? phase
        let entry = NSMenuItem(title: title, action: #selector(showDashboard), keyEquivalent: "o")
        entry.target = self
        entry.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)])
        if let error = state["error"] as? String, !error.isEmpty {
            if #available(macOS 14.4, *) { entry.subtitle = error }
            entry.toolTip = error
        }
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
        if phase == "attached" { item("断开", #selector(disconnect)) }
        else if phase == "draining" {
            item("取消断开", #selector(cancelDisconnect))
            item("停止 Session 并断开…", #selector(stopAndDisconnect))
        } else { item("接入 Codex App", #selector(connect), enabled: phase == "detached" || phase == "error") }
        item("设置…", #selector(showSettings), key: ",")
        menu.addItem(.separator())
        item(quitting ? "正在退出…" : "退出 \(appName)", #selector(quitHost), key: "q", enabled: !quitting)
    }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = false; updateMenu(); menuOpen = true; send("status") }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; updateMenu() }

    // MARK: Actions

    @objc private func connect() { if child?.isRunning != true { startHost(autoAttach: true) } else { send("attach") } }
    @objc private func disconnect() { send("detach") }
    @objc private func cancelDisconnect() { quitting = false; send("cancel-drain") }
    @objc private func stopAndDisconnect() {
        let alert = NSAlert(); alert.messageText = "停止 Session 并断开？"
        alert.informativeText = "正在运行的 Claude Code Session 会被中断，已保存的历史会保留。Codex App 和 GPT 任务会继续运行。"
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
    private var appPath: String { state["appPath"] as? String ?? defaultDesktopApp }
    @objc private func openLogs() { NSWorkspace.shared.open(logFile) }
    @objc private func toggleFeature(_ sender: NSSwitch) {
        guard let id = sender.identifier?.rawValue else { return }
        send("set-feature", ["feature": id, "enabled": sender.state == .on])
    }
    @objc private func chooseIdleRelease(_ sender: NSPopUpButton) { send("set-idle-release", ["minutes": sender.selectedTag()]) }

    // MARK: Main window

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .panes, .flexibleSpace, .action] }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .panes, .action] }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch identifier {
        case .panes:
            let control = NSSegmentedControl(labels: Pane.allCases.map(\.title), trackingMode: .selectOne,
                                             target: self, action: #selector(pickPane(_:)))
            control.selectedSegment = pane.rawValue
            paneControl = control
            let item = NSToolbarItem(itemIdentifier: identifier)
            item.view = control; item.label = "页面"
            return item
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

    private func section(_ title: String, accessory: NSView? = nil, content: NSView) -> NSView {
        let heading = label(title, weight: .semibold)
        heading.setContentHuggingPriority(.init(1), for: .horizontal)
        let header = hstack(accessory.map { [heading, $0] } ?? [heading])
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
    /// Fills list with rows; height pins each row, or nil leaves rows that pin their own.
    private func setRows(_ list: NSStackView, _ rows: [NSView], height: CGFloat? = 36) {
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (index, row) in rows.enumerated() {
            if index > 0 {
                let line = pin(FillView(Palette.separator), height: 1)
                list.addArrangedSubview(line)
                line.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
            }
            if let height { pin(row, height: height) }
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
    }
    /// A grouped panel holding rows fixed once, each at its own height; nil leaves a row to pin itself.
    private func group(_ rows: [(NSView, CGFloat?)]) -> FillView {
        let (box, list) = panel()
        setRows(list, rows.map { row, height in pin(row, height: height) }, height: nil)
        return box
    }
    private func noteRow(_ text: String) -> NSView { hstack([label(text, color: .secondaryLabelColor)]) }
    /// A pane's sections stacked at the window's width; the window takes its height from it.
    private func paneStack(_ sections: [NSView]) -> NSStackView {
        let stack = vstack(sections, spacing: 20)
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in sections { view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true }
        return stack
    }

    private func overviewPane() -> NSView {
        let error = NSTextField(wrappingLabelWithString: "")
        error.textColor = .systemRed; error.font = .systemFont(ofSize: 12); errorLabel = error

        let app = ComponentCard(name: "Codex App"), cli = ComponentCard(name: "Claude Code CLI"), host = ComponentCard(name: appName)
        cli.show(glyph: clawdImage(size: 36))
        host.show(glyph: claudeCloudImage(size: 36))
        appCard = app; cliCard = cli; hostCard = host
        let cards = NSStackView(views: [app.view, cli.view, host.view])
        cards.orientation = .horizontal; cards.distribution = .fillEqually; cards.spacing = 10; cards.alignment = .top

        let (usageBox, usageRows) = panel(); usageList = usageRows
        let taskSummary = label("", size: 11, color: .secondaryLabelColor); self.taskSummary = taskSummary
        let (taskBox, taskRows) = panel(); taskList = taskRows
        return paneStack([error, section("组件", content: cards), section("用量", content: usageBox),
                          section("Claude Code Session", accessory: taskSummary, content: taskBox)])
    }

    private func featuresPane() -> NSView {
        let sections = featureGroups.map { entry -> NSView in
            let rows = entry.features.map { feature -> (NSView, CGFloat?) in
                let row = feature.id == "idleRelease"
                    ? FeatureRow(id: feature.id, title: feature.title, detail: feature.detail,
                                 control: idleReleasePopup(self, #selector(chooseIdleRelease(_:)))) { control, feature in
                        (control as? NSPopUpButton).map { selectIdleRelease($0, feature) }
                    }
                    : FeatureRow(id: feature.id, title: feature.title, detail: feature.detail,
                                 control: rowSwitch(self, #selector(toggleFeature(_:)))) { control, feature in
                        (control as? NSSwitch)?.state = feature?["enabled"] as? Bool == true ? .on : .off
                    }
                featureRows[feature.id] = row
                return (row.view, 56)
            }
            return section(entry.title, content: group(rows))
        }
        return paneStack(sections)
    }

    private func settingsPane() -> NSView {
        let login = rowSwitch(self, #selector(toggleLogin(_:)))
        let approvalNote = label("需要在“系统设置 › 通用 › 登录项”中允许", size: 11, color: Palette.warnInk)
        let approve = NSButton(title: "打开登录项设置…", target: self, action: #selector(openLoginItems)); approve.controlSize = .small
        loginToggle = login; loginApproval = [approvalNote, approve]
        let loginRow = pin(hstack([titled("登录时启动", note: approvalNote), approve, login], spacing: 12))
        // The login row alone changes height, growing when approval is pending.
        loginRowHeight = loginRow.heightAnchor.constraint(equalToConstant: 40); loginRowHeight?.isActive = true
        var launch: [(NSView, CGFloat?)] = [(loginRow, nil)]
        for preference in LaunchPreference.allCases {
            let toggle = rowSwitch(self, #selector(togglePreference(_:)))
            toggle.identifier = NSUserInterfaceItemIdentifier(preference.rawValue)
            toggle.state = preference.enabled ? .on : .off
            guard let variable = preference.override else {
                let title = label(preference.title); title.setContentHuggingPriority(.init(1), for: .horizontal)
                launch.append((hstack([title, toggle], spacing: 12), 40))
                continue
            }
            toggle.isEnabled = false
            let note = label("当前由环境变量 \(variable) 决定", size: 11, color: .secondaryLabelColor)
            launch.append((hstack([titled(preference.title, note: note), toggle], spacing: 12), 56))
        }
        let launchBox = group(launch)

        let (app, appField) = pathRow("Codex App", appPath, [("在 Finder 中显示", #selector(revealDesktop))])
        appPathLabel = appField
        let (data, _) = pathRow("数据", dataDirectory.path, [("在 Finder 中显示", #selector(revealData))])
        let (logs, _) = pathRow("诊断日志", logFile.path, [("打开", #selector(openLogs)), ("在 Finder 中显示", #selector(revealLogs))])
        return paneStack([section("启动", content: launchBox), section("位置", content: group([(app, 56), (data, 56), (logs, 56)]))])
    }

    /// The App lives in the menu bar (LSUIElement) and joins the Dock only while it has a window open,
    /// so the icon appears with the window and leaves with it.
    private func comeForward() {
        if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        NSApp.activate(ignoringOtherApps: true)
    }
    private func leaveDockIfIdle() {
        let open = NSApp.windows.contains { $0.styleMask.contains(.titled) && ($0.isVisible || $0.isMiniaturized) }
        if !open, NSApp.activationPolicy() == .regular { NSApp.setActivationPolicy(.accessory) }
    }

    @objc private func showDashboard() { showWindow(pane) }
    @objc private func showFeatures() { showWindow(.features) }
    @objc private func showSettings() { showWindow(.settings) }
    @objc private func pickPane(_ sender: NSSegmentedControl) { Pane(rawValue: sender.selectedSegment).map(showPane) }

    private func showWindow(_ pane: Pane) {
        if dashboard == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
                                  styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = appName; window.isReleasedWhenClosed = false; window.delegate = self
            let toolbar = NSToolbar(identifier: "main")
            toolbar.delegate = self; toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
            toolbar.centeredItemIdentifiers = [.panes]
            window.toolbar = toolbar; window.toolbarStyle = .unified
            panes = [.overview: overviewPane(), .features: featuresPane(), .settings: settingsPane()]
            dashboard = window
            showPane(pane)
            updateDashboard()
            window.center()
        } else {
            showPane(pane)
        }
        comeForward(); dashboard?.makeKeyAndOrderFront(nil)
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
    /// Puts pane in the window, which then takes the pane's height.
    private func showPane(_ pane: Pane) {
        self.pane = pane; paneControl?.selectedSegment = pane.rawValue
        guard let content = dashboard?.contentView, let view = panes[pane] else { return }
        if view.superview !== content {
            content.subviews.forEach { $0.removeFromSuperview() }
            content.addSubview(view)
            NSLayoutConstraint.activate([
                view.topAnchor.constraint(equalTo: content.topAnchor),
                view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                view.widthAnchor.constraint(equalToConstant: 640),
            ])
        }
        if pane == .settings { refreshLoginItem() }
        fitDashboard()
    }
    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === dashboard else { return }
        dashboardTimer?.invalidate(); dashboardTimer = nil
    }

    private func updateDashboard() {
        guard dashboard != nil, let taskList, let usageList else { return }
        if let actionItem {
            actionItem.title = ["attached": "断开", "draining": "取消断开", "attaching": "接入中", "detaching": "断开中"][phase] ?? "接入"
            actionItem.isEnabled = phase != "attaching" && phase != "detaching"
            if #available(macOS 26.0, *) { actionItem.style = connected || !actionItem.isEnabled ? .plain : .prominent }
        }
        let error = state["error"] as? String ?? ""
        errorLabel?.stringValue = error; errorLabel?.isHidden = error.isEmpty

        if let card = appCard, card.icon.image == nil {
            card.show(glyph: codexCloudImage(appPath: appPath) ?? NSWorkspace.shared.icon(forFile: appPath))
        }
        let appRunning = state["appRunning"] as? Bool == true
        appCard?.pill.show(appRunning ? "运行中" : "未运行", tone: appRunning ? "ok" : "off")

        let claude = (state["harnesses"] as? [[String: Any]] ?? []).first { $0["harnessId"] as? String == "claude-code" }
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
        taskSummary?.stringValue = tasks.isEmpty ? "" : "\(running) 个运行中 · 共 \(tasks.count) 个 Session"
        if tasks.isEmpty {
            setRows(taskList, [noteRow(connected ? "当前没有 Claude Code Session。在 Codex App 里选择 Claude 模型即可开始。"
                                                 : "接入 Codex App 后，这里会列出每个 Claude Code Session 和它正在做的事。")])
        } else {
            let order = ["running": 0, "background": 1, "idle": 2]
            let sorted = tasks.sorted { (order[$0["status"] as? String ?? ""] ?? 3) < (order[$1["status"] as? String ?? ""] ?? 3) }
            var rows = sorted.prefix(12).map(taskRow)
            if sorted.count > 12 { rows.append(noteRow("另外 \(sorted.count - 12) 个 Session")) }
            setRows(taskList, rows)
        }

        let reported = features
        for (id, row) in featureRows { row.show(reported[id]) }
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
        let value = pin(tabular(label("\(left)%", color: left <= lowRemaining ? .systemOrange : .labelColor)), width: 48)
        (value as? NSTextField)?.alignment = .right
        value.toolTip = "剩余 \(left)%"
        return hstack([productLabel, windowLabel, bar, value, resetLabel])
    }

    private func taskRow(_ task: [String: Any]) -> NSView {
        let status = task["status"] as? String ?? "idle"
        let activity = task["activity"] as? [String: Any]
        let cwd = task["cwd"] as? String ?? ""
        var title = task["title"] as? String ?? "未命名 Session"
        if task["subagent"] as? Bool == true { title = "子代理 · " + title }
        let titleLabel = label(title)
        titleLabel.setContentHuggingPriority(.init(1), for: .horizontal)
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
        let row = hstack([titleLabel, statusLabel])
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
        comeForward()
        NSApp.orderFrontStandardAboutPanel(options: options)
    }

    /// A path shown in full as a tooltip and shortened with ~ in the label.
    private func showPath(_ field: NSTextField, _ path: String) {
        field.stringValue = displayPath(path); field.toolTip = path
    }
    /// A 位置 row: the name over its path, with the row's buttons on the trailing side.
    private func pathRow(_ title: String, _ path: String, _ buttons: [(String, Selector)]) -> (NSStackView, NSTextField) {
        let field = label("", size: 11, color: .secondaryLabelColor)
        field.lineBreakMode = .byTruncatingMiddle; field.isSelectable = true; showPath(field, path)
        let actions = buttons.map { title, action -> NSView in
            let button = NSButton(title: title, target: self, action: action); button.controlSize = .small
            return button
        }
        return (hstack([titled(title, note: field)] + actions, spacing: 8), field)
    }

    /// Re-read whenever the window comes forward on 设置, since approval happens in System Settings.
    func windowDidBecomeKey(_ notification: Notification) {
        if notification.object as? NSWindow === dashboard, pane == .settings { refreshLoginItem() }
    }
    private func refreshLoginItem() {
        let status = SMAppService.mainApp.status
        loginToggle?.state = status == .enabled || status == .requiresApproval ? .on : .off
        let approval = status == .requiresApproval
        loginApproval.forEach { $0.isHidden = !approval }
        loginRowHeight?.constant = approval ? 56 : 40
        fitDashboard()
    }
    @objc private func toggleLogin(_ sender: NSSwitch) {
        do {
            if sender.state == .on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            let alert = NSAlert(); alert.messageText = sender.state == .on ? "无法添加登录项" : "无法移除登录项"
            alert.informativeText = error.localizedDescription
            if let dashboard { alert.beginSheetModal(for: dashboard) } else { alert.runModal() }
        }
        refreshLoginItem()
    }
    @objc private func openLoginItems() { SMAppService.openSystemSettingsLoginItems() }
    @objc private func togglePreference(_ sender: NSSwitch) {
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
