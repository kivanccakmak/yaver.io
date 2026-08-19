package io.yaver.tv

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * TvApp — the Yaver Android TV application. Holds the app-wide [CoroutineScope]
 * and a lazily-created [TvStore] so the whole app shares one token/box/relay
 * state, mirroring how YaverStore is a single @StateObject in tvOS.
 */
class TvApp : Application() {
    val appScope: CoroutineScope by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }

    val store: TvStore by lazy { TvStore(this, appScope) }

    val speech: Speech by lazy { Speech(this) }
}
