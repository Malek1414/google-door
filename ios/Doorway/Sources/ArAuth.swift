import Foundation
import os

/// How the native Live View authenticates against the ARCore API.
///
/// 1. Keyless, the primary path: our own server mints a short-lived OAuth token from a
///    service account (server/arcore.py, GET /api/arcore-token). Nothing long-lived is in
///    the app. The token is refreshed before it expires.
/// 2. Only when the server has no service account: an API key from the gitignored
///    ios/Secrets.xcconfig, substituted into Info.plist (ARCoreAPIKey) at build time.
///    Such a key ships inside the app bundle, so it must be restricted in Google Cloud to
///    the iOS bundle id com.malek.doorway and to the ARCore API.
/// 3. Neither: ARCore is unavailable and the web Live View takes over.
enum ArAuth {
    private static let log = Logger(subsystem: "com.malek.doorway", category: "arcore")

    enum Source {
        case token(String, expiresIn: TimeInterval)
        case apiKey(String)
    }

    /// Our origin's token endpoint, only for a page the app trusts.
    static func tokenURL(for page: URL?) -> URL? {
        guard let page, Origins.isTrusted(page),
              var c = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return nil }
        c.path = "/api/arcore-token"
        c.query = nil
        c.fragment = nil
        return c.url
    }

    /// Fetches a token. Nil on any failure (503 not set up, network, bad JSON); the
    /// reason is logged without the response body.
    static func fetchToken(from url: URL) async -> (token: String, expiresIn: TimeInterval)? {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        // Same tunnel interstitial the web view skips (WebViewController.serveoSkip).
        req.setValue("true", forHTTPHeaderField: "serveo-skip-browser-warning")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                log.info("arcore token: HTTP \(status, privacy: .public)")
                return nil
            }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = obj["token"] as? String, !token.isEmpty,
                  let exp = (obj["expiresIn"] as? NSNumber)?.doubleValue, exp > 0 else {
                log.error("arcore token: unexpected answer")
                return nil
            }
            return (token, exp)
        } catch {
            log.error("arcore token: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// The build-time API key, if a real one was configured.
    static var bundledAPIKey: String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "ARCoreAPIKey") as? String else { return nil }
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Unset build setting, or the placeholder from Secrets.example.xcconfig.
        if key.isEmpty || key.contains("$(") || key.hasPrefix("DEIN_") { return nil }
        return key
    }

    static func resolve(page: URL?) async -> Source? {
        if let url = tokenURL(for: page), let t = await fetchToken(from: url) {
            return .token(t.token, expiresIn: t.expiresIn)
        }
        if let key = bundledAPIKey { return .apiKey(key) }
        return nil
    }
}
