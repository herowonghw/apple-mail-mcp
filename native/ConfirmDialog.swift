// Native confirmation window for apple-mail-mcp (see src/utils/confirmationGate.ts).
//
// Reads a JSON payload on stdin, shows what is about to happen, and waits for a
// person to fill six boxes with any letters or digits. Prints and exits with:
//   APPROVED (0), CANCELLED (1), TIMEOUT (2), ERROR (3).
import AppKit

struct Field: Decodable {
    let label: String
    let value: String
}

struct Payload: Decodable {
    let title: String
    let action: String
    let question: String
    let fields: [Field]
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

let contentWidth: CGFloat = 480

func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular,
           color: NSColor = .labelColor) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.isSelectable = false
    field.preferredMaxLayoutWidth = contentWidth
    return field
}

/** Wrapping labels only wrap at a fixed width. */
func pinned(_ view: NSView, _ width: CGFloat) -> NSView {
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalToConstant: width).isActive = true
    return view
}

final class Controller: NSObject, NSTextFieldDelegate, NSWindowDelegate {
    var boxes: [NSTextField] = []
    var okButton: NSButton!
    var window: NSWindow!

    func update() {
        okButton.isEnabled = boxes.allSatisfy { $0.stringValue.count == 1 }
    }

    func controlTextDidChange(_ note: Notification) {
        guard let field = note.object as? NSTextField,
              let index = boxes.firstIndex(of: field) else { return }
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
            boxes[next].stringValue = String(char)
            next += 1
        }
        if next < boxes.count {
            window.makeFirstResponder(boxes[next])
        } else {
            window.makeFirstResponder(okButton)
        }
        update()
    }

    func control(_ control: NSControl, textView: NSTextView,
                 doCommandBy selector: Selector) -> Bool {
        guard let field = control as? NSTextField,
              let index = boxes.firstIndex(of: field) else { return false }
        if selector == #selector(NSResponder.deleteBackward(_:)), field.stringValue.isEmpty,
           index > 0 {
            boxes[index - 1].stringValue = ""
            window.makeFirstResponder(boxes[index - 1])
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
        guard boxes.allSatisfy({ $0.stringValue.count == 1 }) else { return }
        finish("APPROVED", 0)
    }

    @objc func cancel() {
        finish("CANCELLED", 1)
    }

    func windowWillClose(_ notification: Notification) {
        finish("CANCELLED", 1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let snapshotPath = ProcessInfo.processInfo.environment["CONFIRM_DIALOG_SNAPSHOT"]
if snapshotPath != nil {
    // Light appearance so the offscreen rendering is readable on a white background.
    app.appearance = NSAppearance(named: .aqua)
}
let controller = Controller()

let stack = NSStackView()
stack.orientation = .vertical
stack.alignment = .leading
stack.spacing = 10
stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)

stack.addArrangedSubview(label("⚠️ \(payload.action)", size: 22, weight: .bold, color: .systemRed))
stack.addArrangedSubview(pinned(label(payload.question, size: 14, weight: .medium), contentWidth))

let grid = NSGridView(numberOfColumns: 2, rows: 0)
grid.rowSpacing = 6
grid.columnSpacing = 12
for field in payload.fields {
    let name = label(field.label, weight: .semibold, color: .secondaryLabelColor)
    let value = label(field.value)
    value.preferredMaxLayoutWidth = contentWidth - 84
    value.isSelectable = true
    grid.addRow(with: [pinned(name, 72), pinned(value, contentWidth - 84)])
}
grid.rowAlignment = .firstBaseline
stack.addArrangedSubview(grid)

if let summary = payload.summary, !summary.isEmpty {
    stack.addArrangedSubview(label("内容摘要", weight: .semibold, color: .secondaryLabelColor))
    let text = label(summary)
    text.preferredMaxLayoutWidth = contentWidth
    stack.addArrangedSubview(pinned(text, contentWidth))
}

if let path = payload.imagePath, let image = NSImage(contentsOfFile: path),
   image.size.width > 0, image.size.height > 0 {
    let caption = payload.imageCaption ?? "图片预览"
    stack.addArrangedSubview(label(caption, weight: .semibold, color: .secondaryLabelColor))
    let scale = min(1, 280 / image.size.width, 180 / image.size.height)
    let view = NSImageView(image: image)
    view.imageScaling = .scaleProportionallyDown
    view.wantsLayer = true
    view.layer?.cornerRadius = 4
    view.layer?.borderWidth = 1
    view.layer?.borderColor = NSColor.separatorColor.cgColor
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalToConstant: image.size.width * scale).isActive = true
    view.heightAnchor.constraint(equalToConstant: image.size.height * scale).isActive = true
    stack.addArrangedSubview(view)
}

let divider = NSBox()
divider.boxType = .separator
divider.translatesAutoresizingMaskIntoConstraints = false
divider.widthAnchor.constraint(equalToConstant: contentWidth).isActive = true
stack.addArrangedSubview(divider)

stack.addArrangedSubview(pinned(label("请输入任意 6 位字母或数字确认（字母自动转为大写）",
                                      weight: .medium), contentWidth))

let row = NSStackView()
row.orientation = .horizontal
row.spacing = 10
for _ in 0..<6 {
    let box = NSTextField()
    box.font = .monospacedSystemFont(ofSize: 26, weight: .semibold)
    box.alignment = .center
    box.delegate = controller
    box.translatesAutoresizingMaskIntoConstraints = false
    box.widthAnchor.constraint(equalToConstant: 46).isActive = true
    box.heightAnchor.constraint(equalToConstant: 50).isActive = true
    controller.boxes.append(box)
    row.addArrangedSubview(box)
}
stack.addArrangedSubview(row)

let buttons = NSStackView()
buttons.orientation = .horizontal
buttons.spacing = 12
let cancelButton = NSButton(title: "取消", target: controller, action: #selector(Controller.cancel))
cancelButton.keyEquivalent = "\u{1b}"
let okButton = NSButton(title: "确定", target: controller, action: #selector(Controller.approve))
okButton.isEnabled = false
okButton.bezelColor = .systemRed
controller.okButton = okButton
let spacer = NSView()
spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
buttons.addArrangedSubview(spacer)
buttons.addArrangedSubview(cancelButton)
buttons.addArrangedSubview(okButton)
buttons.translatesAutoresizingMaskIntoConstraints = false
buttons.widthAnchor.constraint(equalToConstant: contentWidth).isActive = true
stack.addArrangedSubview(buttons)

let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: contentWidth + 48, height: 400),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = payload.title
window.contentView = stack
window.level = .floating
window.delegate = controller
window.isReleasedWhenClosed = false
controller.window = window
stack.layoutSubtreeIfNeeded()
window.setContentSize(stack.fittingSize)
window.center()
// Debugging aid: render the window to a PNG instead of showing it.
if let snapshot = snapshotPath {
    controller.boxes[0].stringValue = "A"
    controller.boxes[1].stringValue = "7"
    let view = window.contentView!
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { finish("ERROR", 3) }
    view.cacheDisplay(in: view.bounds, to: rep)
    // The window background is not part of the content view; paint it underneath.
    let image = NSImage(size: view.bounds.size)
    image.lockFocus()
    view.effectiveAppearance.performAsCurrentDrawingAppearance {
        NSColor.windowBackgroundColor.setFill()
        view.bounds.fill()
        rep.draw(in: view.bounds)
    }
    image.unlockFocus()
    if let tiff = image.tiffRepresentation, let out = NSBitmapImageRep(data: tiff) {
        try? out.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: snapshot))
    }
    finish("SNAPSHOT", 3)
}
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(controller.boxes[0])
app.activate(ignoringOtherApps: true)

Timer.scheduledTimer(withTimeInterval: payload.timeoutSeconds ?? 180, repeats: false) { _ in
    finish("TIMEOUT", 2)
}

app.run()
