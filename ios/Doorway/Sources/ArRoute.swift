import CoreLocation

/// The route the web app hands the native Live View (web/src/ui/nativeAr.ts), validated,
/// plus the pure geometry the AR screen needs: where arrows go, how far along the path
/// the user is, and which maneuver comes next. No ARKit, no UIKit.
struct ArRoute {
    struct Door {
        let coordinate: CLLocationCoordinate2D
        let name: String
        /// Compass direction the user faces when walking in, if surveyed.
        let approachBearing: Double?
    }

    struct Step {
        let text: String
        let coordinate: CLLocationCoordinate2D
        let maneuver: String?
        /// Metres along the path where this instruction applies.
        let along: Double
    }

    /// Where one arrow stands and which way it points (degrees, true north, clockwise).
    struct Waypoint {
        let coordinate: CLLocationCoordinate2D
        let bearing: Double
        let along: Double
    }

    let path: [CLLocationCoordinate2D]
    let door: Door
    let steps: [Step]
    /// Metres along the path at each point.
    let cumulative: [Double]
    var length: Double { cumulative.last ?? 0 }

    // Bounds on what a page may send. A walking route in the demo is a few hundred points
    // at most; anything larger is a mistake, not a route.
    static let maxPoints = 2000
    static let maxSteps = 200
    static let maxText = 300

    /// Parses the message body. Nil for anything malformed, so the caller answers
    /// error(bad-route) and the web Live View takes over.
    init?(message body: [String: Any]) {
        guard let rawPath = body["route"] as? [Any], rawPath.count >= 2, rawPath.count <= Self.maxPoints else { return nil }
        var path: [CLLocationCoordinate2D] = []
        for p in rawPath {
            guard let pair = p as? [Any], pair.count == 2, let c = Self.coordinate(pair[0], pair[1]) else { return nil }
            path.append(c)
        }
        guard let d = body["door"] as? [String: Any], let dc = Self.coordinate(d["lat"], d["lng"]) else { return nil }
        let name = Self.text(d["name"]) ?? "Eingang"
        var bearing = (d["approachBearing"] as? NSNumber)?.doubleValue
        if let b = bearing, !b.isFinite { bearing = nil }
        let door = Door(coordinate: dc, name: name, approachBearing: bearing)

        let cumulative = Self.cumulative(path)
        var steps: [Step] = []
        if let rawSteps = body["steps"] as? [Any] {
            for s in rawSteps.prefix(Self.maxSteps) {
                guard let s = s as? [String: Any], let t = Self.text(s["text"]),
                      let c = Self.coordinate(s["lat"], s["lng"]) else { continue }
                let along = Self.along(c, path: path, cumulative: cumulative).along
                steps.append(Step(text: t, coordinate: c, maneuver: Self.text(s["maneuver"]), along: along))
            }
        }
        self.path = path
        self.door = door
        self.steps = steps.sorted { $0.along < $1.along }
        self.cumulative = cumulative
    }

    private static func coordinate(_ lat: Any?, _ lng: Any?) -> CLLocationCoordinate2D? {
        guard let la = (lat as? NSNumber)?.doubleValue, let lo = (lng as? NSNumber)?.doubleValue,
              la.isFinite, lo.isFinite, abs(la) <= 90, abs(lo) <= 180 else { return nil }
        return CLLocationCoordinate2D(latitude: la, longitude: lo)
    }

    private static func text(_ v: Any?) -> String? {
        guard let s = (v as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return String(s.prefix(maxText))
    }

    // MARK: - Geometry

    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let r = 6_371_000.0
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let la1 = a.latitude * .pi / 180, la2 = b.latitude * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(la1) * cos(la2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(min(1, sqrt(h)))
    }

    static func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let la1 = a.latitude * .pi / 180, la2 = b.latitude * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let y = sin(dLon) * cos(la2)
        let x = cos(la1) * sin(la2) - sin(la1) * cos(la2) * cos(dLon)
        return (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
    }

    static func interpolate(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D, _ t: Double) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: a.latitude + (b.latitude - a.latitude) * t,
                               longitude: a.longitude + (b.longitude - a.longitude) * t)
    }

    static func cumulative(_ path: [CLLocationCoordinate2D]) -> [Double] {
        var out = [0.0]
        for i in 1..<max(1, path.count) { out.append(out[i - 1] + distance(path[i - 1], path[i])) }
        return out
    }

    /// Projects a point onto the path: metres along it, and metres off it.
    /// Local flat-earth per segment, which is exact enough over a walking route.
    static func along(_ p: CLLocationCoordinate2D, path: [CLLocationCoordinate2D], cumulative: [Double]) -> (along: Double, off: Double) {
        var best = (along: 0.0, off: Double.infinity)
        let mPerDegLat = 111_320.0
        for i in 0..<(path.count - 1) {
            let a = path[i], b = path[i + 1]
            let mPerDegLon = mPerDegLat * cos(a.latitude * .pi / 180)
            let bx = (b.longitude - a.longitude) * mPerDegLon, by = (b.latitude - a.latitude) * mPerDegLat
            let px = (p.longitude - a.longitude) * mPerDegLon, py = (p.latitude - a.latitude) * mPerDegLat
            let len2 = bx * bx + by * by
            let t = len2 > 0 ? max(0, min(1, (px * bx + py * by) / len2)) : 0
            let dx = px - t * bx, dy = py - t * by
            let off = sqrt(dx * dx + dy * dy)
            if off < best.off { best = (cumulative[i] + t * (cumulative[i + 1] - cumulative[i]), off) }
        }
        return best
    }

    func progress(at p: CLLocationCoordinate2D) -> (along: Double, off: Double) {
        Self.along(p, path: path, cumulative: cumulative)
    }

    /// Arrows every `spacing` metres along the path, each pointing along it, none in the
    /// last few metres before the door (the destination marker stands there).
    func waypoints(spacing: Double = 10, max count: Int = 60) -> [Waypoint] {
        guard length > 0 else { return [] }
        var out: [Waypoint] = []
        var d = spacing / 2
        var seg = 0
        let stop = length - 4
        while d < stop, out.count < count {
            while seg < path.count - 2, cumulative[seg + 1] < d { seg += 1 }
            let a = path[seg], b = path[seg + 1]
            let segLen = cumulative[seg + 1] - cumulative[seg]
            let t = segLen > 0 ? (d - cumulative[seg]) / segLen : 0
            out.append(Waypoint(coordinate: Self.interpolate(a, b, t), bearing: Self.bearing(a, b), along: d))
            d += spacing
        }
        return out
    }

    /// The next instruction ahead of `along`, and the metres to it. Nil once only the door
    /// is left. A step counts as passed a few metres before its point, so the banner has
    /// already moved on when the turn is taken.
    func nextStep(after along: Double) -> (index: Int, step: Step, metres: Double)? {
        for (i, s) in steps.enumerated() where s.along > along + 3 {
            return (i, s, s.along - along)
        }
        return nil
    }
}

extension ArRoute {
    /// The point `metres` from `origin` towards `bearing` (degrees, true north).
    static func offset(_ origin: CLLocationCoordinate2D, bearing: Double, metres: Double) -> CLLocationCoordinate2D {
        let r = 6_371_000.0, d = metres / r, b = bearing * .pi / 180
        let la1 = origin.latitude * .pi / 180, lo1 = origin.longitude * .pi / 180
        let la2 = asin(sin(la1) * cos(d) + cos(la1) * sin(d) * cos(b))
        let lo2 = lo1 + atan2(sin(b) * sin(d) * cos(la1), cos(d) - sin(la1) * sin(la2))
        return CLLocationCoordinate2D(latitude: la2 * 180 / .pi, longitude: lo2 * 180 / .pi)
    }

    /// "40 m", "1,2 km": what the banner shows.
    static func distanceLabel(_ m: Double) -> String {
        if m >= 1000 { return String(format: "%.1f km", m / 1000).replacingOccurrences(of: ".", with: ",") }
        if m >= 100 { return "\(Int((m / 10).rounded()) * 10) m" }
        return "\(max(1, Int((m / 5).rounded()) * 5)) m"
    }

    /// "40 Metern", "1,2 Kilometern": what VoiceOver says after "In".
    static func distanceSpoken(_ m: Double) -> String {
        if m >= 1000 { return String(format: "%.1f Kilometern", m / 1000).replacingOccurrences(of: ".", with: ",") }
        let n = m >= 100 ? Int((m / 10).rounded()) * 10 : max(1, Int((m / 5).rounded()) * 5)
        return n == 1 ? "einem Meter" : "\(n) Metern"
    }
}
