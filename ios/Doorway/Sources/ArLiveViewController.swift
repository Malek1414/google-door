import UIKit
import ARKit
import SceneKit
import CoreLocation
import ARCoreGARSession
import ARCoreGeospatial

/// The native Live View: camera full screen, ARCore Geospatial on top of ARKit, blue arrows
/// anchored on the street along the route, a large marker at the door, and a banner with
/// the next maneuver. Opened by the web app through ArBridge; at the door it closes and
/// hands back to the web app, whose arrival sheet leads into the last-10-metres engine.
///
/// Arrows only appear once Earth tracking is good enough to put them in the right place
/// (horizontal accuracy 5 m or better, heading 10 degrees or better). Until then the
/// screen asks the user to scan buildings and signs, which is what lets Google's visual
/// positioning lock on. An arrow in the wrong place is worse than none.
final class ArLiveViewController: UIViewController, ARSessionDelegate, CLLocationManagerDelegate {

    enum Event {
        case localizing, tracking, closed
        case arrived(via: String)
        case error(String)

        var body: [String: Any] {
            switch self {
            case .localizing: return ["type": "localizing"]
            case .tracking: return ["type": "tracking"]
            case .closed: return ["type": "closed"]
            case .arrived(let via): return ["type": "arrived", "via": via]
            case .error(let reason): return ["type": "error", "reason": reason]
            }
        }
    }

    /// ARKit world tracking on a real device. The simulator has no camera, so the web
    /// Live View runs there.
    static var isSupported: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return ARWorldTrackingConfiguration.isSupported
        #endif
    }

    // Good enough to place arrows, and (looser, so the prompt does not flicker) bad enough
    // to take them away again.
    static let goodHorizontalM = 5.0, goodYawDeg = 10.0
    static let lostHorizontalM = 10.0, lostYawDeg = 20.0
    /// Handoff to the web approach engine this close to the door.
    static let arrivalRadiusM = 15.0
    /// Arrows are anchored in this window around the user, so a long route never needs
    /// hundreds of anchors at once.
    static let anchorAheadM = 80.0, anchorBehindM = 15.0
    /// A "turn now" pulse this close to a maneuver.
    static let turnPulseM = 10.0
    static let temporaryAccuracyKey = "DoorwayLiveView"

    private let route: ArRoute
    private let page: URL?
    private let onEvent: (Event) -> Void

    private let sceneView = ARSCNView()
    private var garSession: GARSession?
    private let location = CLLocationManager()
    private var tokenTimer: Timer?
    private var finished = false
    private var started = false
    private var good = false
    private var vpsChecked = false

    private lazy var waypoints = route.waypoints()
    /// Waypoint index -> anchor id, for the arrows currently placed (or being resolved).
    private var placedArrows: [Int: UUID?] = [:]
    private var doorPlaced = false
    private var nodes: [UUID: (node: SCNNode, along: Double?)] = [:]
    private var futures: [GARFuture] = []
    private var userAlong = 0.0
    private var cameraAltitude: Double?

    private var lastStepKey: String?
    private var turnPulsed = false
    private let impact = UIImpactFeedbackGenerator(style: .heavy)
    private let notify = UINotificationFeedbackGenerator()

    // Views
    private let banner = UIView()
    private let bannerIcon = UIImageView()
    private let bannerText = UILabel()
    private let bannerDistance = UILabel()
    private let prompt = UIView()
    private let closeButton = UIButton(type: .system)
    private let doorButton = UIButton(type: .system)

    init(route: ArRoute, page: URL?, onEvent: @escaping (Event) -> Void) {
        self.route = route
        self.page = page
        self.onEvent = onEvent
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        sceneView.translatesAutoresizingMaskIntoConstraints = false
        sceneView.scene = SCNScene()
        sceneView.automaticallyUpdatesLighting = false
        sceneView.isAccessibilityElement = false
        sceneView.accessibilityElementsHidden = true
        view.addSubview(sceneView)
        buildBanner()
        buildPrompt()
        buildButtons()
        NSLayoutConstraint.activate([
            sceneView.topAnchor.constraint(equalTo: view.topAnchor),
            sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        setBanner(text: "Ziel: \(route.door.name)", metres: nil, maneuver: nil)
        accessibilityElements = [banner, prompt, doorButton, closeButton]
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        start()
    }

    // MARK: - Lifecycle

    private func start() {
        emit(.localizing)
        showPrompt(true)
        guard Self.isSupported else { return fail("unsupported") }

        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        switch location.authorizationStatus {
        case .denied, .restricted:
            return fail("location")
        case .notDetermined:
            location.requestWhenInUseAuthorization()
        default:
            break
        }
        // Geospatial needs precise location; ask for it for this walk if it is off.
        if location.accuracyAuthorization == .reducedAccuracy {
            location.requestTemporaryFullAccuracyAuthorization(withPurposeKey: Self.temporaryAccuracyKey)
        }
        location.startUpdatingLocation()

        Task { @MainActor [weak self] in
            guard let self else { return }
            let source = await ArAuth.resolve(page: self.page)
            guard !self.finished else { return }
            guard let source else { return self.fail("not-configured") }
            do {
                try self.beginSession(source)
            } catch {
                self.fail(Self.reason(for: error))
            }
        }
    }

    private enum StartError: Error { case unsupported }

    private func beginSession(_ source: ArAuth.Source) throws {
        let s: GARSession
        switch source {
        case .token(let token, let expiresIn):
            s = try GARSession.session()
            s.setAuthToken(token)
            scheduleTokenRefresh(after: expiresIn)
        case .apiKey(let key):
            s = try GARSession(apiKey: key, bundleIdentifier: nil)
        }
        guard s.isGeospatialModeSupported(.enabled) else { throw StartError.unsupported }
        let cfg = GARSessionConfiguration()
        cfg.geospatialMode = .enabled
        var err: NSError?
        s.setConfiguration(cfg, error: &err)
        if let err { throw err }
        garSession = s

        let ar = ARWorldTrackingConfiguration()
        ar.worldAlignment = .gravity   // ARCore Geospatial requires gravity alignment
        sceneView.session.delegate = self
        sceneView.session.run(ar)
        checkVPS()
    }

    private static func reason(for error: Error) -> String {
        if error is StartError { return "unsupported" }
        let e = error as NSError
        switch e.code {
        case -7: return "location"          // GARSessionErrorCodeLocationPermissionNotGranted
        case -8, -1: return "unsupported"   // ConfigurationNotSupported, DeviceNotCompatible
        case -6: return "quota"             // ResourceExhausted
        default: return "session"
        }
    }

    /// Tokens live about an hour. Fetch a new one two minutes before this one runs out;
    /// on failure try again in 30 seconds while the old one still works.
    private func scheduleTokenRefresh(after expiresIn: TimeInterval) {
        tokenTimer?.invalidate()
        let wait = max(30, expiresIn - 120)
        tokenTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.finished, let url = ArAuth.tokenURL(for: self.page) else { return }
                if let t = await ArAuth.fetchToken(from: url) {
                    self.garSession?.setAuthToken(t.token)
                    self.scheduleTokenRefresh(after: t.expiresIn)
                } else {
                    self.scheduleTokenRefresh(after: 150)
                }
            }
        }
    }

    /// Without Street View coverage there is no visual positioning, only GPS, and the
    /// arrows would never be placed well. Hand back to the web Live View instead.
    private func checkVPS() {
        guard !vpsChecked, let gs = garSession, let here = location.location?.coordinate else { return }
        vpsChecked = true
        gs.checkVPSAvailability(coordinate: here) { [weak self] availability in
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                if availability == .unavailable { self.fail("vps-unavailable") }
            }
        }
    }

    private func emit(_ e: Event) {
        onEvent(e)
    }

    private func fail(_ reason: String) {
        WebViewController.log.info("native Live View unavailable: \(reason, privacy: .public)")
        finish(.error(reason))
    }

    private func finish(_ e: Event) {
        guard !finished else { return }
        finished = true
        tokenTimer?.invalidate()
        tokenTimer = nil
        futures.forEach { _ = $0.cancel() }
        futures.removeAll()
        sceneView.session.pause()
        location.stopUpdatingLocation()
        emit(e)
        dismiss(animated: true)
    }

    @objc private func closeTapped() { finish(.closed) }
    @objc private func doorTapped() { finish(.arrived(via: "button")) }

    // MARK: - ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard let gs = garSession, !finished else { return }
        guard let gf = try? gs.update(frame) else { return }
        guard let earth = gf.earth else { return }
        switch earth.earthState {
        case .enabled: break
        case .errorNotAuthorized: return fail("not-authorized")
        case .errorResourceExhausted: return fail("quota")
        default: return fail("internal")
        }
        let pose = earth.trackingState == .tracking ? earth.cameraGeospatialTransform : nil
        updateTracking(pose)
        if let pose { cameraAltitude = pose.altitude }
        updateGuidance(pose)
        if finished { return }
        if good, pose != nil { placeAnchors() }
        updateNodes(gf)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        fail("camera")
    }

    func sessionWasInterrupted(_ session: ARSession) {
        setGood(false)
    }

    // MARK: - Tracking quality

    private func updateTracking(_ pose: GARGeospatialTransform?) {
        let h = pose?.horizontalAccuracy ?? .infinity
        let yaw = pose?.orientationYawAccuracy ?? .infinity
        if !good, h <= Self.goodHorizontalM, yaw <= Self.goodYawDeg {
            setGood(true)
        } else if good, h > Self.lostHorizontalM || yaw > Self.lostYawDeg {
            setGood(false)
        }
    }

    private func setGood(_ ok: Bool) {
        guard ok != good else { return }
        good = ok
        showPrompt(!ok)
        emit(ok ? .tracking : .localizing)
    }

    // MARK: - Anchors

    /// Places the door marker once, and the arrows in the window around the user; drops
    /// arrows that are far behind.
    private func placeAnchors() {
        guard let gs = garSession else { return }
        if !doorPlaced {
            doorPlaced = true
            place(gs, at: route.door.coordinate, bearing: 0, aboveTerrain: 0, node: ArNodes.destination(), along: nil)
            // One more arrow in front of the door, pointing the way in, when its direction is surveyed.
            if let b = route.door.approachBearing {
                let c = ArRoute.offset(route.door.coordinate, bearing: b + 180, metres: 3)
                place(gs, at: c, bearing: b, aboveTerrain: 0.3, node: ArNodes.arrow(), along: route.length)
            }
        }
        for (i, w) in waypoints.enumerated() where placedArrows[i] == nil {
            guard w.along >= userAlong - Self.anchorBehindM, w.along <= userAlong + Self.anchorAheadM else { continue }
            placedArrows[i] = .some(nil)
            place(gs, at: w.coordinate, bearing: w.bearing, aboveTerrain: 0.3, node: ArNodes.arrow(), along: w.along) { [weak self] id in
                self?.placedArrows[i] = id
            }
        }
        for (i, id) in placedArrows {
            guard let id, waypoints[i].along < userAlong - Self.anchorBehindM * 2 else { continue }
            removeAnchor(id)
            placedArrows[i] = nil
        }
    }

    /// Terrain anchor first (Google resolves the ground height); if that fails, a WGS84
    /// anchor at the camera's altitude less a standing phone height.
    private func place(_ gs: GARSession, at c: CLLocationCoordinate2D, bearing: Double, aboveTerrain: Double,
                       node: SCNNode, along: Double?, placed: ((UUID) -> Void)? = nil) {
        // Rotation about "up" in the east-up-south frame. The node's forward is -Z (north);
        // turning it clockwise seen from above by `bearing` is a negative angle about +Y.
        let q = simd_quatf(angle: Float(-bearing * .pi / 180), axis: SIMD3<Float>(0, 1, 0))
        let fallback = { [weak self] in
            guard let self, !self.finished, let alt = self.cameraAltitude,
                  let a = try? gs.createAnchor(coordinate: c, altitude: alt - 1.5 + aboveTerrain, eastUpSouthQAnchor: q) else { return }
            self.attach(node, to: a.identifier, along: along)
            placed?(a.identifier)
        }
        do {
            let future = try gs.createAnchorOnTerrain(coordinate: c, altitudeAboveTerrain: aboveTerrain,
                                                      eastUpSouthQAnchor: q) { [weak self] anchor, state in
                DispatchQueue.main.async {
                    guard let self, !self.finished else { return }
                    if state == .success, let anchor {
                        self.attach(node, to: anchor.identifier, along: along)
                        placed?(anchor.identifier)
                    } else {
                        fallback()
                    }
                }
            }
            futures.append(future)
        } catch {
            fallback()
        }
    }

    private func attach(_ node: SCNNode, to id: UUID, along: Double?) {
        node.isHidden = true
        sceneView.scene.rootNode.addChildNode(node)
        nodes[id] = (node, along)
    }

    private func removeAnchor(_ id: UUID) {
        guard let entry = nodes.removeValue(forKey: id) else { return }
        entry.node.removeFromParentNode()
        if let gs = garSession, let frame = gs.currentFramePair?.garFrame,
           let anchor = frame.anchors.first(where: { $0.identifier == id }) {
            gs.remove(anchor)
        }
    }

    /// Anchors move as ARCore refines them; nodes follow each frame. Arrows show only
    /// while tracking is good and they lie ahead of the user.
    private func updateNodes(_ gf: GARFrame) {
        for anchor in gf.anchors {
            guard let entry = nodes[anchor.identifier] else { continue }
            let valid = anchor.hasValidTransform && anchor.trackingState == .tracking
            if valid { entry.node.simdTransform = anchor.transform }
            let ahead = entry.along.map { $0 >= userAlong - 2 && $0 <= userAlong + Self.anchorAheadM } ?? true
            entry.node.isHidden = !(valid && good && ahead)
        }
    }

    // MARK: - Guidance: banner, arrival, haptics

    private func updateGuidance(_ pose: GARGeospatialTransform?) {
        let here: CLLocationCoordinate2D, accuracy: Double
        if let pose, pose.horizontalAccuracy <= Self.lostHorizontalM {
            (here, accuracy) = (pose.coordinate, pose.horizontalAccuracy)
        } else if let l = location.location, l.horizontalAccuracy >= 0, l.horizontalAccuracy <= 25 {
            (here, accuracy) = (l.coordinate, l.horizontalAccuracy)
        } else {
            return
        }
        userAlong = route.progress(at: here).along

        // The handoff needs a fix good enough to trust "15 m": a rough GPS fix alone would
        // hand over half a block early.
        let toDoor = ArRoute.distance(here, route.door.coordinate)
        if toDoor <= Self.arrivalRadiusM, accuracy <= Self.lostHorizontalM { return finish(.arrived(via: "distance")) }

        let next = route.nextStep(after: userAlong)
        let text = next?.step.text ?? "Ziel: \(route.door.name)"
        let metres = next?.metres ?? max(toDoor, route.length - userAlong)
        setBanner(text: text, metres: metres, maneuver: next?.step.maneuver)

        let key = next.map { "step-\($0.index)" } ?? "door"
        if key != lastStepKey {
            if lastStepKey != nil { notify.notificationOccurred(.success) }   // a turn was taken
            lastStepKey = key
            turnPulsed = false
            UIAccessibility.post(notification: .announcement,
                                 argument: "In \(ArRoute.distanceSpoken(metres)): \(text)")
        }
        if let n = next, n.metres <= Self.turnPulseM, !turnPulsed, Self.isTurn(n.step.maneuver) {
            turnPulsed = true
            impact.impactOccurred()
        }
    }

    private static func isTurn(_ maneuver: String?) -> Bool {
        guard let m = maneuver else { return false }
        return m.contains("LEFT") || m.contains("RIGHT") || m.contains("UTURN")
    }

    private static func symbol(for maneuver: String?) -> String {
        switch maneuver {
        case "TURN_LEFT", "TURN_SHARP_LEFT": return "arrow.turn.up.left"
        case "TURN_RIGHT", "TURN_SHARP_RIGHT": return "arrow.turn.up.right"
        case "TURN_SLIGHT_LEFT", "FORK_LEFT", "RAMP_LEFT": return "arrow.up.left"
        case "TURN_SLIGHT_RIGHT", "FORK_RIGHT", "RAMP_RIGHT": return "arrow.up.right"
        case "UTURN_LEFT": return "arrow.uturn.down"
        case "UTURN_RIGHT": return "arrow.uturn.down"
        case nil: return "mappin.and.ellipse"
        default: return "arrow.up"
        }
    }

    private func setBanner(text: String, metres: Double?, maneuver: String?) {
        bannerText.text = text
        bannerDistance.text = metres.map(ArRoute.distanceLabel)
        bannerDistance.isHidden = metres == nil
        bannerIcon.image = UIImage(systemName: Self.symbol(for: maneuver))
        banner.accessibilityLabel = metres.map { "In \(ArRoute.distanceSpoken($0)): \(text)" } ?? text
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        checkVPS()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .denied, .restricted: fail("location")
        default: break
        }
    }

    // MARK: - Views

    /// Google-style maneuver banner: dark blue, white text (contrast about 7:1), icon left.
    private func buildBanner() {
        banner.translatesAutoresizingMaskIntoConstraints = false
        banner.backgroundColor = UIColor(red: 0x0B / 255, green: 0x57 / 255, blue: 0xD0 / 255, alpha: 1) // #0B57D0
        banner.layer.cornerRadius = 20
        banner.layer.borderWidth = 2
        banner.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        banner.isAccessibilityElement = true
        banner.accessibilityTraits = [.header, .updatesFrequently]

        bannerIcon.translatesAutoresizingMaskIntoConstraints = false
        bannerIcon.tintColor = .white
        bannerIcon.contentMode = .scaleAspectFit
        bannerIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 34, weight: .bold)

        bannerDistance.translatesAutoresizingMaskIntoConstraints = false
        bannerDistance.font = UIFontMetrics(forTextStyle: .title1).scaledFont(for: .systemFont(ofSize: 28, weight: .bold))
        bannerDistance.adjustsFontForContentSizeCategory = true
        bannerDistance.textColor = .white

        bannerText.translatesAutoresizingMaskIntoConstraints = false
        bannerText.font = UIFontMetrics(forTextStyle: .title3).scaledFont(for: .systemFont(ofSize: 20, weight: .semibold))
        bannerText.adjustsFontForContentSizeCategory = true
        bannerText.textColor = .white
        bannerText.numberOfLines = 3

        let texts = UIStackView(arrangedSubviews: [bannerDistance, bannerText])
        texts.axis = .vertical
        texts.spacing = 2
        texts.translatesAutoresizingMaskIntoConstraints = false
        banner.addSubview(bannerIcon)
        banner.addSubview(texts)
        view.addSubview(banner)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            banner.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            banner.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            banner.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bannerIcon.leadingAnchor.constraint(equalTo: banner.leadingAnchor, constant: 16),
            bannerIcon.centerYAnchor.constraint(equalTo: banner.centerYAnchor),
            bannerIcon.widthAnchor.constraint(equalToConstant: 44),
            bannerIcon.heightAnchor.constraint(equalToConstant: 44),
            texts.leadingAnchor.constraint(equalTo: bannerIcon.trailingAnchor, constant: 14),
            texts.trailingAnchor.constraint(equalTo: banner.trailingAnchor, constant: -16),
            texts.topAnchor.constraint(equalTo: banner.topAnchor, constant: 14),
            texts.bottomAnchor.constraint(equalTo: banner.bottomAnchor, constant: -14),
        ])
    }

    private func buildPrompt() {
        prompt.translatesAutoresizingMaskIntoConstraints = false
        prompt.backgroundColor = UIColor(white: 0.08, alpha: 0.88)
        prompt.layer.cornerRadius = 20
        prompt.isAccessibilityElement = true

        let icon = UIImageView(image: UIImage(systemName: "building.2"))
        icon.tintColor = .white
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 36, weight: .semibold)
        icon.contentMode = .scaleAspectFit

        let title = UILabel()
        title.text = "Scanne Gebäude und Schilder in der Umgebung"
        title.font = UIFontMetrics(forTextStyle: .title3).scaledFont(for: .systemFont(ofSize: 20, weight: .bold))
        title.adjustsFontForContentSizeCategory = true
        title.textColor = .white
        title.textAlignment = .center
        title.numberOfLines = 0

        let sub = UILabel()
        sub.text = "Halte das Handy aufrecht und schwenke es langsam."
        sub.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16, weight: .regular))
        sub.adjustsFontForContentSizeCategory = true
        sub.textColor = UIColor(white: 0.9, alpha: 1)
        sub.textAlignment = .center
        sub.numberOfLines = 0

        prompt.accessibilityLabel = "\(title.text!) \(sub.text!)"
        let stack = UIStackView(arrangedSubviews: [icon, title, sub])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        prompt.addSubview(stack)
        view.addSubview(prompt)
        NSLayoutConstraint.activate([
            prompt.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            prompt.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            prompt.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: prompt.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: prompt.bottomAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: prompt.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: prompt.trailingAnchor, constant: -20),
        ])
    }

    private func showPrompt(_ show: Bool) {
        guard prompt.isHidden == show else { return }
        prompt.isHidden = !show
        if show { UIAccessibility.post(notification: .announcement, argument: prompt.accessibilityLabel) }
    }

    private func buildButtons() {
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setImage(UIImage(systemName: "xmark",
                                     withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .bold)), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor(white: 0.08, alpha: 0.85)
        closeButton.layer.cornerRadius = 28
        closeButton.layer.borderWidth = 2
        closeButton.layer.borderColor = UIColor.white.cgColor
        closeButton.accessibilityLabel = "Live View schließen"
        closeButton.accessibilityHint = "Zurück zur Karte"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        doorButton.translatesAutoresizingMaskIntoConstraints = false
        let blue = UIColor(red: 0x0B / 255, green: 0x57 / 255, blue: 0xD0 / 255, alpha: 1)
        var conf = UIButton.Configuration.filled()
        conf.title = "Zum Eingang"
        conf.image = UIImage(systemName: "door.left.hand.open")
        conf.imagePadding = 8
        conf.baseBackgroundColor = .white
        conf.baseForegroundColor = blue
        conf.cornerStyle = .capsule
        conf.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 24, bottom: 14, trailing: 24)
        conf.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in
            var a = a
            a.font = UIFontMetrics(forTextStyle: .headline).scaledFont(for: .systemFont(ofSize: 18, weight: .bold))
            return a
        }
        doorButton.configuration = conf
        doorButton.accessibilityLabel = "Zum Eingang"
        doorButton.accessibilityHint = "Beendet die Kamera-Ansicht und führt dich die letzten Meter bis zur Tür."
        doorButton.addTarget(self, action: #selector(doorTapped), for: .touchUpInside)

        view.addSubview(closeButton)
        view.addSubview(doorButton)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            closeButton.widthAnchor.constraint(equalToConstant: 56),
            closeButton.heightAnchor.constraint(equalToConstant: 56),
            closeButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            closeButton.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
            doorButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
            doorButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            doorButton.trailingAnchor.constraint(lessThanOrEqualTo: closeButton.leadingAnchor, constant: -12),
            doorButton.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
        ])
    }
}
