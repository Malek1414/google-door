import UIKit
import WebKit
import CoreLocation

/// Doorway wrapped in a WKWebView.
///
/// This wrapper exists for one reason that matters more than the app icon:
///
///   Since iOS 15, WKWebView only delivers deviceorientation events when the host app
///   implements the WKUIDelegate permission callback. Without it WebKit denies outright —
///   no prompt, requestPermission() resolves to "denied", and the compass never fires.
///   That is why Doorway must be opened in Safari and not from inside another app.
///
/// Implementing that callback here is what makes the arrow work inside a webview at all.
/// The same goes for camera capture, which is denied by default in a webview.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, CLLocationManagerDelegate {

    /// The dev server. Override at launch with -DoorwayURL <url>.
    private var startURL: URL {
        if let s = UserDefaults.standard.string(forKey: "DoorwayURL"), let u = URL(string: s) { return u }
        return URL(string: "http://100.101.164.23:8090/")!
    }

    private var webView: WKWebView!
    private let location = CLLocationManager()
    private lazy var retryButton: UIButton = makeRetryButton()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.075, green: 0.078, blue: 0.078, alpha: 1) // #131314

        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []   // the beacon starts on the Start tap
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
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        view.addSubview(retryButton)
        NSLayoutConstraint.activate([
            retryButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            retryButton.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])

        // Ask for location up front: the web layer's request is what actually gates the
        // fix, but the native prompt has to have been answered first inside a webview.
        location.delegate = self
        location.requestWhenInUseAuthorization()

        load()
    }

    override var prefersStatusBarHidden: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    private func load() {
        retryButton.isHidden = true
        webView.load(URLRequest(url: startURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    @objc private func retry() { load() }

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
    /// resolves requestPermission() to "denied" with no prompt, and the arrow never moves.
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

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showRetry(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showRetry(error)
    }

    private func showRetry(_ error: Error) {
        retryButton.setTitle("  Server nicht erreichbar — erneut versuchen  ", for: .normal)
        retryButton.isHidden = false
        NSLog("[doorway] load failed: \(error.localizedDescription)")
    }

    private func makeRetryButton() -> UIButton {
        let b = UIButton(type: .system)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.setTitleColor(UIColor(red: 0.659, green: 0.780, blue: 0.980, alpha: 1), for: .normal) // #a8c7fa
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        b.backgroundColor = UIColor(white: 0.14, alpha: 1)
        b.layer.cornerRadius = 22
        b.isHidden = true
        b.addTarget(self, action: #selector(retry), for: .touchUpInside)
        b.heightAnchor.constraint(equalToConstant: 44).isActive = true
        return b
    }
}
