import AppKit
import DSStore
import Darwin

// Finder uses logical points. The TIFF carries 1x and 2x representations for Retina displays.
let width = 640, height = 320
let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    fputs("Usage: dmg-layout <mounted-volume> <app-name.app>\n", stderr)
    exit(1)
}
let volume = URL(fileURLWithPath: arguments[1], isDirectory: true)
let appName = arguments[2]
let background = volume.appendingPathComponent(".background.tiff")

func color(_ hex: Int) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: 1)
}

func drawBackground() {
    let bounds = NSRect(x: 0, y: 0, width: width, height: height)
    NSGradient(starting: color(0xFCFAF6), ending: color(0xF2ECE2))!.draw(in: bounds, angle: 90)
    func text(_ value: String, y: CGFloat, size: CGFloat, weight: NSFont.Weight, ink: Int) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        (value as NSString).draw(in: NSRect(x: 30, y: y, width: 580, height: 42), withAttributes: [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color(ink), .paragraphStyle: paragraph
        ])
    }

    // The real Finder icons sit over these soft wells; only the connecting arrow is drawn here.
    color(0xEDE5D9).withAlphaComponent(0.45).setFill()
    for x in [CGFloat(176), CGFloat(464)] {
        NSBezierPath(ovalIn: NSRect(x: x - 75, y: 70, width: 150, height: 150)).fill()
    }
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 297, y: 145))
    arrow.line(to: NSPoint(x: 343, y: 145))
    arrow.move(to: NSPoint(x: 333, y: 135))
    arrow.line(to: NSPoint(x: 343, y: 145))
    arrow.line(to: NSPoint(x: 333, y: 155))
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    color(0xC67B58).setStroke()
    arrow.stroke()

    text("拖入应用程序即可安装", y: 258, size: 14, weight: .regular, ink: 0x8D8173)
}

var representations: [NSBitmapImageRep] = []
for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * scale,
        pixelsHigh: height * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(scale))
    transform.concat()
    let drawing = NSImage(size: NSSize(width: width, height: height), flipped: true) { _ in
        drawBackground()
        return true
    }
    drawing.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    NSGraphicsContext.restoreGraphicsState()
    bitmap.size = NSSize(width: width, height: height)
    representations.append(bitmap)
}
try NSBitmapImageRep.representationOfImageReps(in: representations, using: .tiff, properties: [:])!.write(to: background)

var store = DSStore()
store.setViewStyle(.icon)
store.add(.init(filename: ".", type: .custom(.literal("icvl")), value: .fourCC(.iconView)))
store.setWindowSettings(.init(windowBounds: "{{200, 160}, {640, 352}}", sidebarWidth: 0,
    containerShowSidebar: false, showSidebar: false, showTabView: false,
    showToolbar: false, showStatusBar: false, showPathBar: false))
store.setIconViewSettings(.init(showIconPreview: true, showItemInfo: false, labelOnBottom: true,
    scrollPositionX: 0, scrollPositionY: 0, gridOffsetX: 0, gridOffsetY: 0,
    textSize: 13, iconSize: 104, gridSpacing: 100, viewOptionsVersion: 1, arrangeBy: "none"))
// Carbon aliases must be made on the actual volume, so the background resolves on other Macs.
try store.setBackgroundPicture(imageURL: background, relativeTo: volume)
try store.setIconPosition(for: appName, x: 176, y: 145)
try store.setIconPosition(for: "Applications", x: 464, y: 145)
try store.write(to: volume.appendingPathComponent(".DS_Store"))

// HFS+ Finder info word 2 identifies the folder opened when DiskImageMounter mounts the volume.
// Set only that word; `bless --openfolder` is unavailable on Apple silicon.
var rootInfo = stat()
guard lstat(volume.path, &rootInfo) == 0, rootInfo.st_ino == 2 else {
    fatalError("Expected the root of the mounted HFS+ disk image")
}
var attributes = attrlist()
attributes.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
attributes.commonattr = attrgroup_t(ATTR_CMN_FNDRINFO)
attributes.volattr = attrgroup_t(ATTR_VOL_INFO)
var info = [UInt32](repeating: 0, count: 9)
let readResult = info.withUnsafeMutableBytes {
    getattrlist(volume.path, &attributes, $0.baseAddress, $0.count, 0)
}
guard readResult == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
var finderInfo = Array(info.dropFirst())
finderInfo[2] = UInt32(2).bigEndian
let writeResult = finderInfo.withUnsafeMutableBytes {
    setattrlist(volume.path, &attributes, $0.baseAddress, $0.count, 0)
}
guard writeResult == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
