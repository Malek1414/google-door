import SceneKit
import UIKit

/// The 3D shapes of the native Live View: Google-style blue arrows lying on the ground
/// along the route, and a large marker at the door. Each node's own -Z axis is "forward",
/// which is north in ARCore's east-up-south anchor frame, so an anchor rotated by the
/// route bearing makes the arrow point along the street.
enum ArNodes {
    static let blue = UIColor(red: 0x1A / 255, green: 0x73 / 255, blue: 0xE8 / 255, alpha: 1)   // #1A73E8

    private static func material(_ color: UIColor) -> SCNMaterial {
        let m = SCNMaterial()
        m.diffuse.contents = color
        // Flat colour: in daylight a lit arrow goes dark on its shaded side and is lost.
        m.lightingModel = .constant
        m.isDoubleSided = true
        return m
    }

    /// Flat arrow outline in the XY plane, tip at +Y, `scale` metres long.
    private static func arrowPath(scale: CGFloat) -> UIBezierPath {
        let p = UIBezierPath()
        let w = 0.5 * scale, stem = 0.18 * scale, head = 0.45 * scale, len = scale
        p.move(to: CGPoint(x: 0, y: len / 2))
        p.addLine(to: CGPoint(x: w, y: len / 2 - head))
        p.addLine(to: CGPoint(x: stem, y: len / 2 - head))
        p.addLine(to: CGPoint(x: stem, y: -len / 2))
        p.addLine(to: CGPoint(x: -stem, y: -len / 2))
        p.addLine(to: CGPoint(x: -stem, y: len / 2 - head))
        p.addLine(to: CGPoint(x: -w, y: len / 2 - head))
        p.close()
        return p
    }

    /// A blue arrow with a white outline, lying flat, pointing along -Z.
    static func arrow(length: CGFloat = 1.3) -> SCNNode {
        let outline = SCNShape(path: arrowPath(scale: length * 1.18), extrusionDepth: 0.02)
        outline.materials = [material(.white)]
        let fill = SCNShape(path: arrowPath(scale: length), extrusionDepth: 0.04)
        fill.materials = [material(blue)]

        let o = SCNNode(geometry: outline)
        let f = SCNNode(geometry: fill)
        f.position.z = 0.015   // above the outline, so it reads as a border, not a halo behind
        let flat = SCNNode()
        flat.addChildNode(o)
        flat.addChildNode(f)
        // The shape's +Y (tip) becomes -Z (forward), and it lies in the ground plane.
        flat.eulerAngles.x = -.pi / 2

        let root = SCNNode()
        root.addChildNode(flat)
        root.name = "arrow"
        return root
    }

    /// The door: a big blue ball with a white ring on a thin pole, bobbing gently so it
    /// stands out from the street. The pole foot is the node origin.
    static func destination() -> SCNNode {
        let root = SCNNode()
        root.name = "destination"

        let pole = SCNNode(geometry: SCNCylinder(radius: 0.04, height: 1.6))
        pole.geometry?.materials = [material(.white)]
        pole.position.y = 0.8
        root.addChildNode(pole)

        let head = SCNNode()
        head.position.y = 2.0
        let ball = SCNNode(geometry: SCNSphere(radius: 0.45))
        ball.geometry?.materials = [material(blue)]
        let ring = SCNNode(geometry: SCNTorus(ringRadius: 0.5, pipeRadius: 0.06))
        ring.geometry?.materials = [material(.white)]
        ring.eulerAngles.x = .pi / 2   // into the XY plane, the plane the billboard turns to the camera
        let facing = SCNNode()
        facing.constraints = [SCNBillboardConstraint()]
        facing.addChildNode(ring)
        head.addChildNode(ball)
        head.addChildNode(facing)
        root.addChildNode(head)

        let up = SCNAction.moveBy(x: 0, y: 0.15, z: 0, duration: 0.9)
        up.timingMode = .easeInEaseOut
        head.runAction(.repeatForever(.sequence([up, up.reversed()])))
        return root
    }
}
