import UIKit

/// Window setup lives in SceneDelegate: iOS 27 kills an app at launch that has no
/// UIScene manifest (UIKit NoSceneLifecycleAdoption), so the app delegate only hands
/// every connecting scene to the one scene configuration in Info.plist.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    }
}
