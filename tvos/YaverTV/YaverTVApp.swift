// YaverTVApp.swift — @main entry. Gates on auth: email/password or phone-approved QR until a
// session token exists, then the lean-back dashboard.

import SwiftUI

@main
struct YaverTVApp: App {
    @StateObject private var store = YaverStore(appearanceSurface: "tvos")

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(store.appearanceTheme == "light" ? .light : .dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: YaverStore

    var body: some View {
        Group {
            if store.isAuthenticated {
                DashboardView()
            } else {
                SignInView()
            }
        }
        .task(id: store.token) { await store.refreshAppearanceSettings() }
    }
}
