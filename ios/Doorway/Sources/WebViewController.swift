import UIKit
import WebKit
import CoreLocation

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
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, CLLocationManagerDelegate {

    /// Tried in order until one answers.
    ///
    /// A public tunnel leads because it is the only address that survives leaving the
    /// flat: the phone's Tailscale has been offline for months and a LAN address only
    /// works on one network. Override at launch with -DoorwayURL <url>.
    private static let candidates: [String] = [
        "https://88ba75ad3a167d.lhr.life",
        "http://192.168.12.158:8090/",
    ]

    private var urls: [URL] {
        if let s = UserDefaults.standard.string(forKey: "DoorwayURL"), let u = URL(string: s) { return [u] }
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

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
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

        // The web layer's request is what gates the fix, but inside a webview the native
        // prompt has to have been answered first.
        location.delegate = self
        location.requestWhenInUseAuthorization()

        load(from: 0)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    private func load(from index: Int) {
        guard index < urls.count else {
            status.text = "Kein Server erreichbar.\nLäuft Doorway auf dem Mac?"
            retry.isHidden = false
            return
        }
        attempt = index
        retry.isHidden = true
        status.text = "Verbinde …"
        webView.load(URLRequest(url: urls[index], cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12))
    }

    @objc private func retryTapped() { load(from: 0) }

    // MARK: - WKUIDelegate: the permissions that make Doorway work in a webview

    /// Camera. Denied by default in WKWebView; Live View is dead without it.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    /// DeviceOrientation. THE reason this wrapper exists: without this callback WebKit
    /// resolves requestPermission() to "denied" with no prompt and the arrow never moves.
    func webView(_ webView: WKWebView,
                 requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        status.text = nil
        retry.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        next(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        next(error)
    }

    /// Fall through to the next candidate rather than stopping at the first failure.
    private func next(_ error: Error) {
        NSLog("[doorway] %@ failed: %@", urls[safe: attempt]?.absoluteString ?? "?", error.localizedDescription)
        load(from: attempt + 1)
    }

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

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
