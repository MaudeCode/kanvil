// Diagnostic builds only. Capture native geometry, never labels, text, URLs or account data.
@MainActor
private final class KanvilStartupDiagnostics {
  private static let shared = KanvilStartupDiagnostics()
  private let process = UUID().uuidString
  private let started = ProcessInfo.processInfo.systemUptime
  private let file = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("kanvil-native-startup.json")
  private var observers: [NSObjectProtocol] = []
  private var timer: Timer?
  private var remaining = 0
  private var lastSample: Data?
  private var records: [[String: Any]] = []
  private let maximumBytes = 1_048_576

  static func startIfEnabled() {
    guard Bundle.main.object(forInfoDictionaryKey: "KanvilStartupDiagnostics") as? Bool == true
    else { return }
    shared.start()
  }

  private func start() {
    guard observers.isEmpty else { return }
    if let saved = try? Data(contentsOf: file), saved.count <= maximumBytes,
      let history = try? JSONSerialization.jsonObject(with: saved) as? [[String: Any]]
    {
      records = history
    }
    let events: [(Notification.Name, String)] = [
      (UIApplication.didBecomeActiveNotification, "active"),
      (UIApplication.willResignActiveNotification, "resign-active"),
      (UIApplication.didEnterBackgroundNotification, "background"),
      (UIApplication.willEnterForegroundNotification, "foreground"),
    ]
    for (name, event) in events {
      observers.append(
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
          [weak self] _ in
          Task { @MainActor [weak self] in
            if event == "active" { self?.burst(event) } else { self?.capture(event) }
          }
        })
    }
    burst("launch")
  }

  private func burst(_ event: String) {
    timer?.invalidate()
    capture(event)
    remaining = 15
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.capture("sample")
        self.remaining -= 1
        if self.remaining == 0 {
          self.timer?.invalidate()
          self.timer = nil
        }
      }
    }
  }

  private func number(_ value: CGFloat) -> Double { value.isFinite ? Double(value) : 0 }
  private func rect(_ value: CGRect) -> [Double] {
    [number(value.origin.x), number(value.origin.y), number(value.width), number(value.height)]
  }
  private func view(_ value: UIView) -> [String: Any] {
    var result: [String: Any] = [
      "class": NSStringFromClass(type(of: value)), "frame": rect(value.frame),
      "bounds": rect(value.bounds), "hidden": value.isHidden, "alpha": number(value.alpha),
      "windowAttached": value.window != nil,
      "horizontalSizeClass": value.traitCollection.horizontalSizeClass.rawValue,
      "verticalSizeClass": value.traitCollection.verticalSizeClass.rawValue,
    ]
    if let tabs = value as? UITabBar { result["items"] = tabs.items?.count ?? 0 }
    if let navigation = value as? UINavigationBar {
      result["leftItems"] = navigation.topItem?.leftBarButtonItems?.count ?? 0
      result["rightItems"] = navigation.topItem?.rightBarButtonItems?.count ?? 0
    }
    return result
  }
  private func bar(_ value: UIView, limit: Int = 64) -> [String: Any] {
    var result = view(value)
    var nodes: [[String: Any]] = []
    var queue: [(UIView, Int)] = [(value, 0)]
    var cursor = 0
    // Breadth-first traversal reaches scene chrome before deep React list subtrees.
    while cursor < queue.count, cursor < limit, nodes.count < 128 {
      let (child, depth) = queue[cursor]
      cursor += 1
      let name = NSStringFromClass(type(of: child))
      if ["Bar", "Button", "Floating", "Rail", "Platter", "Chrome", "Tab", "Container", "Host"]
        .contains(where: name.contains)
      {
        var node = view(child)
        node["depth"] = depth
        node["parentClass"] = child.superview.map { NSStringFromClass(type(of: $0)) } ?? ""
        nodes.append(node)
      }
      if depth < 32 { queue.append(contentsOf: child.subviews.map { ($0, depth + 1) }) }
    }
    result["nativeViews"] = nodes
    return result
  }
  private func controllers(_ root: UIViewController?) -> [[String: Any]] {
    var result: [[String: Any]] = []
    func visit(_ controller: UIViewController, _ depth: Int) {
      guard depth < 10, result.count < 32 else { return }
      var item: [String: Any] = [
        "class": NSStringFromClass(type(of: controller)), "depth": depth,
        "viewLoaded": controller.isViewLoaded, "children": controller.children.count,
      ]
      if let loaded = controller.viewIfLoaded { item["view"] = view(loaded) }
      if controller.isViewLoaded, let tabs = controller as? UITabBarController {
        item["tabCount"] = tabs.children.count
        item["selectedIndex"] = tabs.selectedIndex
      }
      if controller.isViewLoaded, let navigation = controller as? UINavigationController {
        item["navigationBarHidden"] = navigation.isNavigationBarHidden
      }
      result.append(item)
      for child in controller.children { visit(child, depth + 1) }
      if let presented = controller.presentedViewController { visit(presented, depth + 1) }
    }
    if let root { visit(root, 0) }
    return result
  }
  private func capture(_ event: String) {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.map {
      scene in
      [
        "activation": scene.activationState.rawValue,
        "orientation": scene.interfaceOrientation.rawValue,
        "screenBounds": rect(scene.screen.bounds),
        "screenNativeBounds": rect(scene.screen.nativeBounds),
        "windows": scene.windows.map { window in
          [
            "view": view(window), "key": window.isKeyWindow,
            "controllers": controllers(window.rootViewController),
            "nativeChrome": bar(window, limit: 1024)["nativeViews"] ?? [],
          ] as [String: Any]
        },
      ] as [String: Any]
    }
    guard let snapshot = try? JSONSerialization.data(withJSONObject: scenes, options: [.sortedKeys])
    else { return }
    if event == "sample", snapshot == lastSample { return }
    lastSample = snapshot
    let record: [String: Any] = [
      "event": event, "process": process,
      "elapsed": ProcessInfo.processInfo.systemUptime - started,
      "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") ?? "",
      "os": ProcessInfo.processInfo.operatingSystemVersionString, "scenes": scenes,
    ]
    guard let encoded = try? JSONSerialization.data(withJSONObject: record),
      encoded.count <= maximumBytes
    else { return }
    records.append(record)
    do {
      var output = try JSONSerialization.data(withJSONObject: records, options: [.sortedKeys])
      while output.count > maximumBytes, records.count > 1 {
        records.removeFirst()
        output = try JSONSerialization.data(withJSONObject: records, options: [.sortedKeys])
      }
      // Atomic replacement lets Share read a complete snapshot while sampling continues.
      try output.write(to: file, options: [.atomic])
    } catch {
      // Diagnostics must never interrupt startup or user actions.
    }
  }
}
