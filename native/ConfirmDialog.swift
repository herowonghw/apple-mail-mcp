// Native confirmation window for apple-mail-mcp (see src/utils/confirmationGate.ts).
//
// Reads a JSON payload on stdin, shows what is about to happen, and waits for a
// person to fill six boxes with any letters or digits. Prints and exits with:
//   APPROVED (0), CANCELLED (1), TIMEOUT (2), ERROR (3).
//
// CONFIRM_DIALOG_SNAPSHOT=<path> renders the window to a PNG instead (debugging aid).
import AppKit

struct Field: Decodable {
    let label: String
    let value: String
}

struct Payload: Decodable {
    let title: String
    let action: String
    let question: String
    let kind: String?
    let confirmLabel: String?
    let highlights: [Field]?
    let fields: [Field]
    let draftAvailable: Bool?
    let summary: String?
    let imagePath: String?
    let imageCaption: String?
    let timeoutSeconds: Double?
}

func finish(_ word: String, _ code: Int32) -> Never {
    print(word)
    fflush(stdout)
    exit(code)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let payload = try? JSONDecoder().decode(Payload.self, from: input) else {
    finish("ERROR", 3)
}

let snapshotPath = ProcessInfo.processInfo.environment["CONFIRM_DIALOG_SNAPSHOT"]

// MARK: - Layout constants

let windowWidth: CGFloat = 500
let sidePadding: CGFloat = 28
let contentWidth = windowWidth - sidePadding * 2
let cardPadding: CGFloat = 14
let labelColumn: CGFloat = 64
let accent = NSColor.systemRed

// MARK: - Small views

/** Rounded card drawn in draw(_:) so it follows light/dark mode and renders offscreen. */
final class CardView: NSView {
    var fill: NSColor = .controlBackgroundColor
    var stroke: NSColor = .separatorColor
    var radius: CGFloat = 10

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                                xRadius: radius, yRadius: radius)
        fill.setFill()
        path.fill()
        stroke.setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}

/** Red circle with a white SF Symbol. */
final class IconBadge: NSView {
    let symbol: String
    init(symbol: String) {
        self.symbol = symbol
        super.init(frame: NSRect(x: 0, y: 0, width: 44, height: 44))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 44).isActive = true
        heightAnchor.constraint(equalToConstant: 44).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        accent.setFill()
        NSBezierPath(ovalIn: bounds).fill()
        let config = NSImage.SymbolConfiguration(pointSize: 19, weight: .semibold)
            .applying(.init(paletteColors: [.white]))
        guard let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(config) else { return }
        let size = image.size
        image.draw(in: NSRect(x: (bounds.width - size.width) / 2,
                              y: (bounds.height - size.height) / 2,
                              width: size.width, height: size.height))
    }
}

/** An image clipped to rounded corners, drawn without layers. */
final class RoundedImage: NSView {
    let image: NSImage
    init(image: NSImage) {
        self.image = image
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).addClip()
        image.draw(in: bounds)
        NSGraphicsContext.restoreGraphicsState()
    }
}

/** Thin horizontal rule. */
final class Rule: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill()
        bounds.fill()
    }
}

final class CodeField: NSTextField {
    var onFocus: (() -> Void)?
    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocus?() }
        return ok
    }
}

/** One code box: a rounded frame that highlights while its field has focus. */
final class CodeBox: NSView {
    let field = CodeField()
    var active = false { didSet { needsDisplay = true } }

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 52).isActive = true
        heightAnchor.constraint(equalToConstant: 60).isActive = true
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.alignment = .center
        field.font = .monospacedSystemFont(ofSize: 26, weight: .semibold)
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(field)
        NSLayoutConstraint.activate([
            field.centerYAnchor.constraint(equalTo: centerYAnchor),
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 10, yRadius: 10)
        NSColor.controlBackgroundColor.setFill()
        path.fill()
        let filled = !field.stringValue.isEmpty
        (active ? accent : filled ? NSColor.secondaryLabelColor : NSColor.separatorColor).setStroke()
        path.lineWidth = active ? 2 : 1
        path.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(field)
    }
}

func text(_ string: String, size: CGFloat = 13, weight: NSFont.Weight = .regular,
          color: NSColor = .labelColor, width: CGFloat? = nil) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: string)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.isSelectable = false
    if let width {
        field.preferredMaxLayoutWidth = width
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: width).isActive = true
    }
    return field
}

func fixedWidth(_ view: NSView, _ width: CGFloat) -> NSView {
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalToConstant: width).isActive = true
    return view
}

func vstack(_ views: [NSView], spacing: CGFloat, insets: NSEdgeInsets = NSEdgeInsetsZero) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = spacing
    stack.edgeInsets = insets
    return stack
}

/** A card holding `content`, full content width. */
func card(_ content: NSView) -> NSView {
    let view = CardView()
    view.translatesAutoresizingMaskIntoConstraints = false
    content.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(content)
    NSLayoutConstraint.activate([
        view.widthAnchor.constraint(equalToConstant: contentWidth),
        content.topAnchor.constraint(equalTo: view.topAnchor, constant: cardPadding - 2),
        content.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -(cardPadding - 2)),
        content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: cardPadding),
        content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -cardPadding),
    ])
    return view
}

func sectionTitle(_ string: String) -> NSTextField {
    text(string, size: 11, weight: .semibold, color: .secondaryLabelColor)
}

// MARK: - Controller

final class Controller: NSObject, NSTextFieldDelegate {
    var boxes: [CodeBox] = []
    var okButton: NSButton!
    var countdown: NSTextField!
    var window: NSWindow!
    var remaining = 180

    var fields: [CodeField] { boxes.map(\.field) }

    func focus(_ index: Int) {
        window.makeFirstResponder(boxes[index].field)
    }

    func highlight(_ index: Int?) {
        for (i, box) in boxes.enumerated() { box.active = (i == index) }
    }

    func update() {
        okButton.isEnabled = fields.allSatisfy { $0.stringValue.count == 1 }
        boxes.forEach { $0.needsDisplay = true }
    }

    func controlTextDidChange(_ note: Notification) {
        guard let field = note.object as? CodeField,
              let index = fields.firstIndex(of: field) else { return }
        let chars = field.stringValue.uppercased().filter {
            $0.isASCII && ($0.isLetter || $0.isNumber)
        }
        if chars.isEmpty {
            field.stringValue = ""
            update()
            return
        }
        // One character per box; a paste fills the following boxes.
        var next = index
        for char in chars where next < boxes.count {
            fields[next].stringValue = String(char)
            next += 1
        }
        if next < boxes.count {
            focus(next)
        } else {
            window.makeFirstResponder(nil)
            highlight(nil)
        }
        update()
    }

    func control(_ control: NSControl, textView: NSTextView,
                 doCommandBy selector: Selector) -> Bool {
        guard let field = control as? CodeField,
              let index = fields.firstIndex(of: field) else { return false }
        if selector == #selector(NSResponder.deleteBackward(_:)), field.stringValue.isEmpty,
           index > 0 {
            fields[index - 1].stringValue = ""
            focus(index - 1)
            update()
            return true
        }
        if selector == #selector(NSResponder.insertNewline(_:)) {
            if okButton.isEnabled { approve() }
            return true
        }
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            cancel()
            return true
        }
        return false
    }

    @objc func approve() {
        guard fields.allSatisfy({ $0.stringValue.count == 1 }) else { return }
        finish("APPROVED", 0)
    }

    /** Asks the server to show the draft in Mail; the window stays open. */
    @objc func openDraft() {
        print("OPEN_DRAFT")
        fflush(stdout)
    }

    @objc func cancel() {
        finish("CANCELLED", 1)
    }

    func tick() {
        remaining -= 1
        if remaining <= 0 { finish("TIMEOUT", 2) }
        countdown.stringValue = "\(remaining) 秒后自动取消"
    }
}

// MARK: - Build the window

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let snapshotAppearance = NSAppearance(
    named: ProcessInfo.processInfo.environment["CONFIRM_DIALOG_APPEARANCE"] == "dark" ? .darkAqua : .aqua)
if snapshotPath != nil {
    // A fixed appearance, so offscreen rendering resolves every color the same way.
    app.appearance = snapshotAppearance
}
let controller = Controller()
controller.remaining = Int(payload.timeoutSeconds ?? 180)

let symbols = [
    "send": "paperplane.fill",
    "reply": "arrowshape.turn.up.left.fill",
    "replyAll": "arrowshape.turn.up.left.2.fill",
    "forward": "arrowshape.turn.up.right.fill",
    "delete": "trash.fill",
    "move": "folder.fill",
    "rule": "gearshape.fill",
    "settings": "person.crop.circle.badge.exclamationmark",
]

// Header: icon, red headline, question.
let header = NSStackView()
header.orientation = .horizontal
header.alignment = .top
header.spacing = 14
header.addArrangedSubview(IconBadge(symbol: symbols[payload.kind ?? ""] ?? "exclamationmark.triangle.fill"))
header.addArrangedSubview(vstack([
    text(payload.action, size: 19, weight: .bold, color: accent, width: contentWidth - 58),
    text(payload.question, size: 13, color: .secondaryLabelColor, width: contentWidth - 58),
], spacing: 4))

var sections: [NSView] = [header]

// Sender and recipients: tinted, bold, before everything else.
if let highlights = payload.highlights, !highlights.isEmpty {
    var rows: [NSView] = []
    for field in highlights {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 10
        let isFrom = field.label == "发件邮箱"
        row.addArrangedSubview(text(field.label, size: 12, weight: .semibold,
                                    color: accent, width: labelColumn))
        let value = text(field.value, size: isFrom ? 15 : 14, weight: isFrom ? .bold : .semibold,
                         width: contentWidth - cardPadding * 2 - labelColumn - 10)
        value.isSelectable = true
        row.addArrangedSubview(value)
        rows.append(row)
    }
    let routeCard = CardView()
    routeCard.fill = accent.withAlphaComponent(0.08)
    routeCard.stroke = accent.withAlphaComponent(0.45)
    let content = vstack(rows, spacing: 9)
    routeCard.translatesAutoresizingMaskIntoConstraints = false
    content.translatesAutoresizingMaskIntoConstraints = false
    routeCard.addSubview(content)
    NSLayoutConstraint.activate([
        routeCard.widthAnchor.constraint(equalToConstant: contentWidth),
        content.topAnchor.constraint(equalTo: routeCard.topAnchor, constant: cardPadding),
        content.bottomAnchor.constraint(equalTo: routeCard.bottomAnchor, constant: -cardPadding),
        content.leadingAnchor.constraint(equalTo: routeCard.leadingAnchor, constant: cardPadding),
        content.trailingAnchor.constraint(equalTo: routeCard.trailingAnchor, constant: -cardPadding),
    ])
    var block: [NSView] = [sectionTitle("从哪个邮箱发 · 发给谁"), routeCard]
    if payload.draftAvailable == true {
        let button = NSButton(title: " 在 Mail 中查看草稿", target: controller,
                              action: #selector(Controller.openDraft))
        button.image = NSImage(systemSymbolName: "doc.text.magnifyingglass",
                               accessibilityDescription: nil)
        button.imagePosition = .imageLeading
        button.bezelStyle = .rounded
        let note = text("草稿已存在 Mail 草稿箱。你也可以在 Mail 里自己发送，这里不会再重复发送。",
                        size: 11, color: .tertiaryLabelColor,
                        width: contentWidth - 170)
        let row = NSStackView(views: [button, note])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        block.append(row)
    }
    sections.append(vstack(block, spacing: 6))
}

// Message details.
if !payload.fields.isEmpty {
    var rows: [NSView] = []
    for (i, field) in payload.fields.enumerated() {
        if i > 0 {
            let rule = Rule()
            rule.translatesAutoresizingMaskIntoConstraints = false
            rule.heightAnchor.constraint(equalToConstant: 1).isActive = true
            rows.append(fixedWidth(rule, contentWidth - cardPadding * 2))
        }
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 10
        row.addArrangedSubview(text(field.label, size: 12, weight: .medium,
                                    color: .secondaryLabelColor, width: labelColumn))
        let value = text(field.value, size: 13,
                         width: contentWidth - cardPadding * 2 - labelColumn - 10)
        value.isSelectable = true
        row.addArrangedSubview(value)
        rows.append(row)
    }
    sections.append(vstack([sectionTitle("邮件信息"), card(vstack(rows, spacing: 8))], spacing: 6))
}

// Body summary, with an accent bar like a quotation.
if let summary = payload.summary, !summary.isEmpty {
    let bar = CardView()
    bar.fill = accent.withAlphaComponent(0.55)
    bar.stroke = .clear
    bar.radius = 1.5
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.widthAnchor.constraint(equalToConstant: 3).isActive = true
    let quote = text(summary, size: 13, color: .labelColor,
                     width: contentWidth - cardPadding * 2 - 13)
    let row = NSStackView(views: [bar, quote])
    row.orientation = .horizontal
    row.alignment = .top
    row.spacing = 10
    bar.heightAnchor.constraint(equalTo: quote.heightAnchor).isActive = true
    sections.append(vstack([sectionTitle("正文摘要（前 30 字 …… 后 30 字）"), card(row)], spacing: 6))
}

// One scaled-down image.
if let path = payload.imagePath, let image = NSImage(contentsOfFile: path),
   image.size.width > 0, image.size.height > 0 {
    let scale = min(1, (contentWidth - cardPadding * 2) / image.size.width, 160 / image.size.height)
    let view = RoundedImage(image: image)
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalToConstant: image.size.width * scale).isActive = true
    view.heightAnchor.constraint(equalToConstant: image.size.height * scale).isActive = true
    let caption = text(payload.imageCaption ?? "", size: 11, color: .tertiaryLabelColor)
    sections.append(vstack([sectionTitle("图片预览"), card(vstack([view, caption], spacing: 6))],
                           spacing: 6))
}

// Code entry.
let codeRow = NSStackView()
codeRow.orientation = .horizontal
codeRow.spacing = 10
for index in 0..<6 {
    let box = CodeBox()
    box.field.delegate = controller
    box.field.onFocus = { controller.highlight(index) }
    controller.boxes.append(box)
    codeRow.addArrangedSubview(box)
}
let codeTitle = text("请输入任意 6 位字母或数字以确认", size: 13, weight: .semibold)
let codeHint = text("字母会自动转为大写。这个窗口由 Apple Mail MCP 弹出，AI 无法代填。",
                    size: 11, color: .tertiaryLabelColor)
let codeSection = vstack([codeTitle, codeHint, codeRow], spacing: 8)
codeSection.alignment = .centerX
codeSection.setCustomSpacing(14, after: codeHint)
sections.append(fixedWidth(codeSection, contentWidth))

// Buttons and countdown.
let countdown = text("\(controller.remaining) 秒后自动取消", size: 11, color: .tertiaryLabelColor)
controller.countdown = countdown
let cancelButton = NSButton(title: "取消", target: controller, action: #selector(Controller.cancel))
cancelButton.controlSize = .large
cancelButton.keyEquivalent = "\u{1b}"
let okButton = NSButton(title: payload.confirmLabel ?? "确认执行", target: controller,
                        action: #selector(Controller.approve))
okButton.controlSize = .large
okButton.bezelColor = accent
okButton.keyEquivalent = "\r"
okButton.isEnabled = false
controller.okButton = okButton
for button in [cancelButton, okButton] {
    button.translatesAutoresizingMaskIntoConstraints = false
    button.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
}
let spacer = NSView()
spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
let footer = NSStackView(views: [countdown, spacer, cancelButton, okButton])
footer.orientation = .horizontal
footer.alignment = .centerY
footer.spacing = 10
sections.append(fixedWidth(footer, contentWidth))

let root = vstack(sections, spacing: 18,
                  insets: NSEdgeInsets(top: 26, left: sidePadding, bottom: 22, right: sidePadding))
root.setCustomSpacing(22, after: sections[sections.count - 3])
root.setCustomSpacing(22, after: sections[sections.count - 2])

let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: windowWidth, height: 400),
                      styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
window.titlebarAppearsTransparent = true
window.titleVisibility = .hidden
window.title = payload.title
window.isMovableByWindowBackground = true
window.contentView = root
window.level = .floating
window.isReleasedWhenClosed = false
controller.window = window
root.layoutSubtreeIfNeeded()
window.setContentSize(NSSize(width: windowWidth, height: root.fittingSize.height))
window.center()

if let snapshot = snapshotPath {
    controller.boxes[0].field.stringValue = "A"
    controller.boxes[1].field.stringValue = "7"
    controller.highlight(2)
    window.appearance = snapshotAppearance
    let view = window.contentView!
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { finish("ERROR", 3) }
    let image = NSImage(size: view.bounds.size)
    view.effectiveAppearance.performAsCurrentDrawingAppearance {
        view.cacheDisplay(in: view.bounds, to: rep)
        // The window background is not part of the content view; paint it underneath.
        image.lockFocus()
        NSColor.windowBackgroundColor.setFill()
        view.bounds.fill()
        rep.draw(in: view.bounds)
        image.unlockFocus()
    }
    if let tiff = image.tiffRepresentation, let out = NSBitmapImageRep(data: tiff) {
        try? out.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: snapshot))
    }
    finish("SNAPSHOT", 3)
}

window.makeKeyAndOrderFront(nil)
controller.focus(0)
app.activate(ignoringOtherApps: true)
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in controller.tick() }
app.run()
