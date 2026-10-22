import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var port: UInt16 = 0
    var serverReady = false
    var retries = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        makeWindow()
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    // MARK: - Window

    func makeWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        let rect = NSRect(x: 0, y: 0, width: 1440, height: 920)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "技能锻造台 · Skill Forge"
        window.minSize = NSSize(width: 1080, height: 720)
        window.backgroundColor = NSColor(calibratedRed: 0.02, green: 0.03, blue: 0.06, alpha: 1)
        window.contentView = webView
        window.setFrameAutosaveName("SkillForgeMainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Server

    func findNode() -> String? {
        let home = NSHomeDirectory()
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.local/bin/node",
            "/usr/bin/node",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        // 兜底：通过登录 shell 解析 PATH（用户的 .zshrc 通常会在这里生效）
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) { return path }
        } catch {
            return nil
        }
        return nil
    }

    func freePort() -> UInt16 {
        for _ in 0..<80 {
            let candidate = UInt16.random(in: 43400...43999)
            if isPortFree(candidate) { return candidate }
        }
        return 4318
    }

    func isPortFree(_ port: UInt16) -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        if descriptor < 0 { return false }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    func logFileHandle() -> FileHandle? {
        let directory = NSHomeDirectory() + "/Library/Logs/SkillForge"
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = directory + "/server.log"
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        return FileHandle(forWritingAtPath: path)
    }

    func startServer() {
        guard let node = findNode() else {
            showFatal("没有找到 Node.js", "技能锻造台需要 Node.js 20+。请先安装 Node.js，或把 node 加入 PATH 后重新打开应用。")
            return
        }
        guard let resources = Bundle.main.resourceURL else {
            showFatal("应用资源缺失", "无法定位应用内置资源目录。")
            return
        }
        let appDirectory = resources.appendingPathComponent("app")
        let serverScript = appDirectory.appendingPathComponent("server.mjs")
        guard FileManager.default.fileExists(atPath: serverScript.path) else {
            showFatal("应用资源缺失", "内置服务文件不存在：\(serverScript.path)")
            return
        }
        port = freePort()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["server.mjs"]
        process.currentDirectoryURL = appDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["SKILL_FORGE_PORT"] = String(port)
        environment["SKILL_FORGE_HOST"] = "127.0.0.1"
        let nodeDirectory = URL(fileURLWithPath: node).deletingLastPathComponent().path
        let inheritedPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = "\(nodeDirectory):/opt/homebrew/bin:/usr/local/bin:\(inheritedPath)"
        process.environment = environment
        if let handle = logFileHandle() {
            process.standardOutput = handle
            process.standardError = handle
        }
        process.terminationHandler = { [weak self] finished in
            guard let self else { return }
            if self.serverReady && finished.terminationStatus != 0 {
                DispatchQueue.main.async {
                    self.showFatal("本地服务已退出", "服务进程异常退出（code \(finished.terminationStatus)）。日志：~/Library/Logs/SkillForge/server.log")
                }
            }
        }
        do {
            try process.run()
            server = process
            pollHealth()
        } catch {
            showFatal("启动本地服务失败", error.localizedDescription)
        }
    }

    func stopServer() {
        server?.terminate()
        server = nil
    }

    func pollHealth() {
        guard retries < 120 else {
            showFatal("本地服务启动超时", "服务在 20 秒内没有响应。日志：~/Library/Logs/SkillForge/server.log")
            return
        }
        retries += 1
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async {
                    self.serverReady = true
                    self.loadApp()
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.pollHealth() }
            }
        }.resume()
    }

    func loadApp() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/?desktop=1") else { return }
        webView.load(URLRequest(url: url))
    }

    func showFatal(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "退出")
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: - Menus

    func buildMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 技能锻造台", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 技能锻造台", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 技能锻造台", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "进入全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewMenuItem.submenu = viewMenu

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc func reloadPage() {
        webView.reload()
    }

    // MARK: - WKWebView delegation

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let isLocal = url.host == "127.0.0.1" || url.host == "localhost"
        if !isLocal, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.message = "选择资料文件，或选择技能目录"
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "技能锻造台"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "技能锻造台"
        alert.informativeText = message
        alert.addButton(withTitle: "继续")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "技能锻造台"
        alert.informativeText = prompt
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, navigationAction.targetFrame == nil {
            if url.host == "127.0.0.1" || url.host == "localhost" {
                webView.load(URLRequest(url: url))
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
