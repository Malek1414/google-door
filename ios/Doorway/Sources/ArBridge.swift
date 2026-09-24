import WebKit

/// The page's door to the native Live View (web/src/ui/nativeAr.ts).
///
///   page -> app:  window.webkit.messageHandlers.doorwayAr.postMessage({ op: 'open', route, door, steps })
///   app -> page:  window.__doorwayArEvent({ type: 'localizing' | 'tracking' | 'arrived' | 'closed' | 'error', ... })
///
/// window.doorwayNative.arLiveView tells the page whether to try at all: true only on a
/// device with ARKit world tracking. Like GeoBridge, messages count only from a trusted
/// main frame (WebViewController checks that before calling `open`).
enum ArBridge {
    static let name = "doorwayAr"

    static func install(on ucc: WKUserContentController, handler: WKScriptMessageHandler) {
        ucc.add(handler, name: name)
        let flag = ArLiveViewController.isSupported ? "true" : "false"
        ucc.addUserScript(WKUserScript(source: """
          (function(){var n=window.doorwayNative||{};var o={};for(var k in n)o[k]=n[k];o.arLiveView=\(flag);
          try{Object.defineProperty(window,'doorwayNative',{value:Object.freeze(o),configurable:false,writable:false})}catch(e){}})();
          """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    static func send(_ web: WKWebView?, _ event: ArLiveViewController.Event) {
        guard let data = try? JSONSerialization.data(withJSONObject: event.body),
              let json = String(data: data, encoding: .utf8) else { return }
        web?.evaluateJavaScript("window.__doorwayArEvent&&window.__doorwayArEvent(\(json))")
    }
}
