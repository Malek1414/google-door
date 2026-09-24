import UIKit
import WebKit
import AVFoundation
import CoreLocation
import os

/// Doorway wrapped in a WKWebView.
///
/// This wrapper exists for one reason beyond the app icon:
///
///   Since iOS 15, WKWebView only delivers deviceorientation events when the host app
///   implements the WKUIDelegate permission callback. Without it WebKit denies outright —
///   no prompt, requestPermission() resolves to "denied", and the compass never fires.
///   That is why the web app has to be opened in Safari and never from inside another app.
///
/// Implementing that callback here is what makes the arrow work inside a webview at all.
/// The same goes for camera capture, which a webview also denies by default.
///
/// Every one of those grants (camera, microphone, compass, location) goes only to Doorway's
/// own origins, see `Origins`. The main frame can never leave them either: any other
/// http(s) page opens in Safari, where the app's grants do not apply.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate,
                                WKScriptMessageHandler, CLLocationManagerDelegate {

    static let log = Logger(subsystem: "com.malek.doorway", category: "web")

    /// Tried in order until one answers. Override at launch with -DoorwayURL <url>.
    ///
    /// The tunnel leads because it is the only address that survives leaving the flat.
    /// Its hostname is fixed (serveo grants a named host under serveousercontent.com
    /// without registration), so it is pinned here instead of being learned at runtime:
    /// the old LAN probe (/api/live-url) let anyone on the network name the page this app
    /// loads and hands camera and location to.
    ///
    /// The LAN entry is the one plain-http address left, for dev on the home network only.
    /// A page served over http is not a secure context, so WebKit keeps camera, compass and
    /// location away from it anyway; the map and search still work.
    private static let candidates: [String] = [
        "https://\(Origins.tunnelHost)/",
        "http://\(Origins.lanHost):8090/",
    ]

    private var urls: [URL] {
        if let u = Origins.override { return [u] }
        return Self.candidates.compactMap(URL.init(string:))
    }

    private var attempt = 0
    private var webView: WKWebView!
    private let location = CLLocationManager()
    private lazy var status: UILabel = makeStatus()
    private lazy var retry: UIButton = makeRetry()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.075, green: 0.078, blue: 0.078, alpha: 1) // #131314

        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []   // the beacon unlocks on the Start tap
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.ignoresViewportScaleLimits = true                // pinch zoom always allowed (WCAG 1.4.4)
        GeoBridge.install(on: cfg.userContentController, handler: self)

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }  // Safari > Develop
        #endif
        // No rubber band. Pinch zoom stays (low vision). The page lays itself out under the
        // status bar and home indicator with env(safe-area-inset-*), so no native insets.
        let sv = webView.scrollView
        sv.contentInsetAdjustmentBehavior = .never
        sv.bounces = false
        sv.alwaysBounceVertical = false
        sv.alwaysBounceHorizontal = false
        sv.showsHorizontalScrollIndicator = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        sv.backgroundColor = view.backgroundColor
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(status)
        view.addSubview(retry)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -30),
            status.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            status.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            retry.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            retry.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 18),
        ])

        // When the keyboard closes, WebKit sometimes leaves the document scrolled up by the
        // keyboard height, and the map with its bottom nav hangs half off screen.
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardDidHide),
                                               name: UIResponder.keyboardDidHideNotification, object: nil)

        // One native prompt; the page's geolocation calls go through GeoBridge, so WebKit's
        // second "localhost would like to use your location" alert never appears.
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }

        load(from: 0)
    }

    // MARK: - Screen and sound stay on while Doorway is in front

    /// The phone is held up and walked with; auto-lock mid-approach would cut the camera,
    /// the compass and the voice. Only while this screen is visible (iOS itself ignores
    /// the flag in the background).
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        Self.playThroughSilentSwitch()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// Spoken guidance is the product for a blind user: like a navigation app it plays
    /// with the ring/silent switch on. WKWebView's audio follows the host app's session.
    private static func playThroughSilentSwitch() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
        } catch {
            log.error("audio session: \(error.localizedDescription, privacy: .public)")
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    private func load(from index: Int) {
        guard index < urls.count else {
            status.text = "Kein Server erreichbar.\nLäuft Doorway auf dem Mac?"
            retry.isHidden = false
            webView.isHidden = true
            return
        }
        attempt = index
        retry.isHidden = true
        status.text = "Verbinde …"
        webView.load(URLRequest(url: urls[index], cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12))
    }

    @objc private func retryTapped() { load(from: 0) }

    @objc private func keyboardDidHide() {
        let sv = webView.scrollView
        // Only when the page itself does not scroll (the map screens); onboarding may.
        if sv.contentSize.height <= sv.bounds.height + 1, sv.contentOffset != .zero {
            sv.setContentOffset(.zero, animated: true)
        }
    }

    // MARK: - WKUIDelegate: the permissions that make Doorway work in a webview

    /// Camera and microphone. Denied by default in WKWebView; Live View is dead without it.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(Origins.decide(origin, frame, "media"))
    }

    /// DeviceOrientation. THE reason this wrapper exists: without this callback WebKit
    /// resolves requestPermission() to "denied" with no prompt and the arrow never moves.
    func webView(_ webView: WKWebView,
                 requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(Origins.decide(origin, frame, "orientation"))
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    /// target=_blank / window.open: never a second webview. Doorway's own pages load here,
    /// everything else goes to Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if Origins.isTrusted(url) { webView.load(URLRequest(url: url)) } else { openOutside(url) }
        }
        return nil
    }

    // MARK: - WKNavigationDelegate

    /// The main frame stays on Doorway's origins. Links elsewhere (Google Maps, a venue's
    /// site, tel:) open outside the app, where none of the grants above follow them.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "data", "blob"].contains(scheme) { return decisionHandler(.allow) }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if !mainFrame && (scheme == "https" || scheme == "http") { return decisionHandler(.allow) }
        if Origins.isTrusted(url) { return decisionHandler(.allow) }
        Self.log.info("main frame kept off \(url.absoluteString, privacy: .public)")
        if navigationAction.navigationType == .linkActivated || !(scheme == "https" || scheme == "http") {
            openOutside(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        status.text = nil
        retry.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        next(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        next(error)
    }

    /// iOS kills the page's process under memory pressure; without this the app is a black screen.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Self.log.error("web content process terminated, reloading")
        load(from: attempt)
    }

    /// Fall through to the next candidate rather than stopping at the first failure.
    private func next(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }   // our own policy cancel
        Self.log.error("\(self.urls[safe: self.attempt]?.absoluteString ?? "?", privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        load(from: attempt + 1)
    }

    private func openOutside(_ url: URL) {
        UIApplication.shared.open(url)
    }

    // MARK: - Geolocation bridge (see GeoBridge)

    private var watching = false
    private var pendingOnce = false

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        #if DEBUG
        if message.name == GeoBridge.logName {
            Self.log.debug("[page] \(String(describing: message.body), privacy: .public)")
            return
        }
        #endif
        guard message.name == GeoBridge.name, message.frameInfo.isMainFrame,
              Origins.isTrusted(message.frameInfo.securityOrigin) else {
            Self.log.error("geolocation refused for \(message.frameInfo.securityOrigin.host, privacy: .public)")
            return
        }
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        switch op {
        case "start":
            switch location.authorizationStatus {
            case .notDetermined:
                pendingOnce = true
                location.requestWhenInUseAuthorization()
            case .denied, .restricted:
                GeoBridge.fail(webView, code: 1, "Standortzugriff in den Einstellungen verweigert")
            default:
                beginUpdates()
            }
        case "stop":
            watching = false
            location.stopUpdatingLocation()
        default:
            break
        }
    }

    private func beginUpdates() {
        watching = true
        location.startUpdatingLocation()
        if let last = location.location { GeoBridge.push(webView, last) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if pendingOnce { pendingOnce = false; beginUpdates() }
        case .denied, .restricted:
            if pendingOnce { pendingOnce = false; GeoBridge.fail(webView, code: 1, "Standortzugriff verweigert") }
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard watching, let l = locations.last else { return }
        GeoBridge.push(webView, l)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard watching else { return }
        if (error as? CLError)?.code == .locationUnknown { return }   // transient, keeps trying
        GeoBridge.fail(webView, code: 2, error.localizedDescription)
    }

    // MARK: - Views

    private func makeStatus() -> UILabel {
        let l = UILabel()
        l.translatesAutoresizingMaskIntoConstraints = false
        l.textColor = UIColor(white: 0.78, alpha: 1)
        l.font = .systemFont(ofSize: 16, weight: .medium)
        l.numberOfLines = 0
        l.textAlignment = .center
        return l
    }

    private func makeRetry() -> UIButton {
        let b = UIButton(type: .system)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.setTitle("  Erneut versuchen  ", for: .normal)
        b.setTitleColor(UIColor(red: 0.659, green: 0.780, blue: 0.980, alpha: 1), for: .normal) // #a8c7fa
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        b.backgroundColor = UIColor(white: 0.14, alpha: 1)
        b.layer.cornerRadius = 22
        b.isHidden = true
        b.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        b.heightAnchor.constraint(equalToConstant: 44).isActive = true
        return b
    }
}

/// The only origins that get camera, microphone, compass and location, and the only ones
/// the main frame may show.
enum Origins {
    /// Fixed serveo host (ops/tunnel.sh asks for exactly this name).
    static let tunnelHost = "doorway.serveousercontent.com"
    /// The Mac on the home network, dev only (plain http, see `candidates`).
    static let lanHost = "192.168.12.158"
    /// The Vite dev server in the simulator (https, self-signed cert trusted in its keychain).
    static let devHosts: Set<String> = ["localhost", "127.0.0.1"]

    /// -DoorwayURL from the launch arguments: set by whoever runs the build, so trusted.
    static let override: URL? = {
        guard let s = UserDefaults.standard.string(forKey: "DoorwayURL"),
              let u = URL(string: s), u.user == nil, u.password == nil,
              let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return u
    }()

    static func isTrusted(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil else { return false }
        return isTrusted(scheme: url.scheme, host: url.host)
    }

    static func isTrusted(_ origin: WKSecurityOrigin) -> Bool {
        isTrusted(scheme: origin.protocol, host: origin.host)
    }

    static func isTrusted(scheme rawScheme: String?, host rawHost: String?) -> Bool {
        guard let scheme = rawScheme?.lowercased(), var host = rawHost?.lowercased(), !host.isEmpty else { return false }
        if host.hasSuffix(".") { host.removeLast() }
        let local = devHosts.contains(host) || host == lanHost
        let overrideHost = override?.host?.lowercased()
        switch scheme {
        case "https": return host == tunnelHost || local || host == overrideHost
        case "http":  return local || (host == overrideHost && override?.scheme?.lowercased() == "http")
        default:      return false
        }
    }

    static func decide(_ origin: WKSecurityOrigin, _ frame: WKFrameInfo, _ what: String) -> WKPermissionDecision {
        let ok = frame.isMainFrame && isTrusted(origin)
        if !ok {
            WebViewController.log.error("\(what, privacy: .public) denied for \(origin.protocol, privacy: .public)://\(origin.host, privacy: .public)")
        }
        return ok ? .grant : .deny
    }
}

/// navigator.geolocation backed by CoreLocation.
///
/// WKWebView's own geolocation asks a second time, per page load ("localhost would like to
/// use your current location"), on top of the iOS prompt, and has no delegate to limit it
/// to our origins. This replaces it in the main frame only; the native side answers only
/// messages from a trusted main frame.
enum GeoBridge {
    static let name = "doorwayGeo"
    static let logName = "doorwayLog"

    static func install(on ucc: WKUserContentController, handler: WKScriptMessageHandler) {
        ucc.add(handler, name: name)
        ucc.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG
        // Page errors into the unified log: xcrun simctl spawn <id> log stream --predicate 'subsystem=="com.malek.doorway"'
        ucc.add(handler, name: logName)
        ucc.addUserScript(WKUserScript(source: """
          (function(){var p=function(k,a){try{window.webkit.messageHandlers.\(logName).postMessage(k+': '+Array.prototype.map.call(a,String).join(' '))}catch(e){}};
          var e=console.error,w=console.warn;console.error=function(){p('error',arguments);e.apply(console,arguments)};
          console.warn=function(){p('warn',arguments);w.apply(console,arguments)};
          addEventListener('error',function(ev){p('uncaught',[ev.message])})})();
          """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
    }

    static func push(_ web: WKWebView?, _ l: CLLocation) {
        let c = l.coordinate
        let js = "window.__doorwayGeo&&window.__doorwayGeo.fix(\(c.latitude),\(c.longitude),\(l.horizontalAccuracy),"
            + "\(l.verticalAccuracy >= 0 ? String(l.altitude) : "null"),\(l.verticalAccuracy >= 0 ? String(l.verticalAccuracy) : "null"),"
            + "\(l.course >= 0 ? String(l.course) : "null"),\(l.speed >= 0 ? String(l.speed) : "null"),\(Int(l.timestamp.timeIntervalSince1970 * 1000)))"
        web?.evaluateJavaScript(js)
    }

    static func fail(_ web: WKWebView?, code: Int, _ msg: String) {
        let quoted = (try? String(data: JSONSerialization.data(withJSONObject: [msg]), encoding: .utf8)) ?? "[\"\"]"
        web?.evaluateJavaScript("window.__doorwayGeo&&window.__doorwayGeo.fail(\(code),\(quoted)[0])")
    }

    /// Same surface as the Geolocation API; watchers share one native stream.
    private static let script = """
    (function () {
      if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.\(name)) return;
      var post = function (op) { window.webkit.messageHandlers.\(name).postMessage({ op: op }); };
      var watchers = {}, nextId = 1, last = null, running = false;
      function each(fn) { Object.keys(watchers).forEach(function (k) { var w = watchers[k]; if (w) fn(w, +k); }); }
      function ensure() { if (!running) { running = true; post('start'); } }
      function maybeStop() { if (running && !Object.keys(watchers).length) { running = false; post('stop'); } }
      function remove(id) { var w = watchers[id]; if (w && w.timer) clearTimeout(w.timer); delete watchers[id]; maybeStop(); }
      function arm(w, id) {
        var t = w.opts && w.opts.timeout;
        if (t >= 0 && t !== Infinity && !w.timer) w.timer = setTimeout(function () {
          w.timer = null; if (!watchers[id]) return;
          if (w.error) w.error({ code: 3, message: 'Timeout', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
          if (w.once) remove(id);
        }, t);
      }
      window.__doorwayGeo = {
        fix: function (lat, lon, acc, alt, altAcc, heading, speed, ts) {
          last = { coords: { latitude: lat, longitude: lon, accuracy: acc, altitude: alt,
                             altitudeAccuracy: altAcc, heading: heading, speed: speed }, timestamp: ts };
          each(function (w, id) {
            if (w.timer) { clearTimeout(w.timer); w.timer = null; }
            try { w.success(last); } catch (e) { setTimeout(function () { throw e; }); }
            if (w.once) remove(id); else arm(w, id);
          });
        },
        fail: function (code, msg) {
          each(function (w, id) {
            if (w.error) try { w.error({ code: code, message: msg, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); } catch (e) {}
            if (w.once || code === 1) remove(id);
          });
        }
      };
      function add(success, error, opts, once) {
        var id = nextId++;
        var w = watchers[id] = { success: success, error: error, opts: opts || {}, once: once };
        var maxAge = w.opts.maximumAge || 0;
        if (last && Date.now() - last.timestamp <= maxAge) {
          setTimeout(function () { if (watchers[id]) { success(last); if (once) remove(id); } });
        }
        arm(w, id); ensure();
        return id;
      }
      var geo = {
        getCurrentPosition: function (s, e, o) { add(s, e, o, true); },
        watchPosition: function (s, e, o) { return add(s, e, o, false); },
        clearWatch: function (id) { remove(id); }
      };
      try { Object.defineProperty(Navigator.prototype, 'geolocation', { configurable: true, get: function () { return geo; } }); }
      catch (e) { try { Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geo }); } catch (e2) {} }
    })();
    """
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
