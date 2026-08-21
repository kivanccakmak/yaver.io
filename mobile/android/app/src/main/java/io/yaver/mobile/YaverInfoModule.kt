package io.yaver.mobile

// YaverInfoModule — Android counterpart to mobile/ios/Yaver/YaverInfo.swift.
//
// Exposes:
//   - constants: isYaver, version, build, sdkVersion, guestSafeMode,
//     and the inheritedAuthToken / inheritedAgentUrl / inheritedDeviceId
//     a guest bundle's bundled feedback SDK reads to skip its own login
//     and inherit Yaver's session.
//   - setInheritedAuth(token, agentUrl, deviceId) — host JS calls this on
//     sign-in; we persist into SharedPreferences. Constants are recomputed
//     at every bundle load, so guest reload picks up fresh values.
//   - clearInheritedAuth — wipe on logout.
//
// Same JS surface as iOS so mobile/src/lib/auth.ts's saveToken /
// clearToken paths just work cross-platform via NativeModules.YaverInfo.

import android.content.Context
import android.content.SharedPreferences
import android.Manifest
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.nio.charset.StandardCharsets
import java.util.UUID

class YaverInfoModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "YaverInfo"

  private fun prefs(): SharedPreferences =
      ctx.getSharedPreferences(YaverNativePrefs.NAME, Context.MODE_PRIVATE)

  override fun getConstants(): Map<String, Any> {
    val p = prefs()
    val pkg = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
    return mapOf(
        "isYaver" to true,
        "version" to (pkg.versionName ?: ""),
        @Suppress("DEPRECATION")
        "build" to pkg.versionCode.toString(),
        "guestSafeMode" to true,
        "suppressPushNotifications" to true,
        "suppressLocalizationProbe" to true,
        "inheritedAuthToken" to (p.getString(YaverNativePrefs.INHERITED_AUTH_TOKEN, "") ?: ""),
        "inheritedAgentUrl" to (p.getString(YaverNativePrefs.AGENT_BASE_URL, "") ?: ""),
        "inheritedDeviceId" to (p.getString(YaverNativePrefs.INHERITED_DEVICE_ID, "") ?: ""),
        // The pinned guest project (setInheritedGuestProject, below). Native
        // panes have always read these straight from prefs; the guest's own
        // bundled feedback SDK could not, because they were never exported.
        // It needs them: inside this container every ambient identity lookup
        // (expo-constants, PlatformConstants) answers "Yaver" /
        // io.yaver.mobile, so a guest report would be filed against Yaver's
        // repo and the fix task would edit the SDK instead of the app under
        // test. iOS counterpart: YaverInfo.swift constantsToExport.
        "inheritedGuestProjectName" to (p.getString(YaverNativePrefs.GUEST_PROJECT_NAME, "") ?: ""),
        "inheritedGuestProjectPath" to (p.getString(YaverNativePrefs.GUEST_PROJECT_PATH, "") ?: ""),
    )
  }

  @ReactMethod
  fun setInheritedAuth(token: String, agentUrl: String, deviceId: String) {
    val edit = prefs().edit()
    if (token.isNotEmpty()) edit.putString(YaverNativePrefs.INHERITED_AUTH_TOKEN, token)
    if (agentUrl.isNotEmpty()) edit.putString(YaverNativePrefs.AGENT_BASE_URL, agentUrl)
    if (deviceId.isNotEmpty()) edit.putString(YaverNativePrefs.INHERITED_DEVICE_ID, deviceId)
    edit.apply()
  }

  @ReactMethod
  fun clearInheritedAuth() {
    prefs().edit()
        .remove(YaverNativePrefs.INHERITED_AUTH_TOKEN)
        .remove(YaverNativePrefs.INHERITED_DEVICE_ID)
        .apply()
  }

  @ReactMethod
  fun consumePendingFeedbackLaunch(promise: com.facebook.react.bridge.Promise) {
    val p = prefs()
    val pending = p.getBoolean(YaverNativePrefs.PENDING_FEEDBACK_LAUNCH, false)
    if (pending) {
      p.edit().remove(YaverNativePrefs.PENDING_FEEDBACK_LAUNCH).apply()
    }
    promise.resolve(pending)
  }

  /// Mirror of mobile/ios/Yaver/YaverInfo.swift's setInheritedPrimaryRunner.
  /// DeviceContext (host JS) calls this whenever the active device's
  /// primary runner / model changes. The native feedback pane reads the
  /// stored values when constructing its POST /tasks payload so the
  /// feedback drawer routes to the same runner the user picked in the
  /// Tasks tab. Empty values clear (e.g. the user removed their pick).
  @ReactMethod
  fun setInheritedPrimaryRunner(runner: String, model: String) {
    val edit = prefs().edit()
    val r = runner.trim()
    val m = model.trim()
    if (r.isEmpty()) edit.remove(YaverNativePrefs.PREFERRED_RUNNER)
    else edit.putString(YaverNativePrefs.PREFERRED_RUNNER, r)
    if (m.isEmpty()) edit.remove(YaverNativePrefs.PREFERRED_MODEL)
    else edit.putString(YaverNativePrefs.PREFERRED_MODEL, m)
    edit.apply()
  }

  /// Mirror of mobile/ios/Yaver/YaverInfo.swift's setInheritedRelayPassword.
  /// Required so the Android feedback pane can attach X-Relay-Password
  /// to its POST /tasks request. Without this header, relay-routed
  /// agents reject with "invalid relay password" / 401.
  @ReactMethod
  fun setInheritedRelayPassword(password: String) {
    val edit = prefs().edit()
    val p = password.trim()
    if (p.isEmpty()) edit.remove(YaverNativePrefs.RELAY_PASSWORD)
    else edit.putString(YaverNativePrefs.RELAY_PASSWORD, p)
    edit.apply()
  }

  /// Mirror of mobile/ios/Yaver/YaverInfo.swift's setInheritedGuestProject.
  /// Lets the host JS push the active Hot-Reload project's name + path
  /// so the feedback pane can prepend a project banner to the user's
  /// prompt — same as iOS — letting the AI on the remote know which
  /// app the feedback applies to.
  @ReactMethod
  fun setInheritedGuestProject(name: String, path: String) {
    val edit = prefs().edit()
    val n = name.trim()
    val p = path.trim()
    if (n.isEmpty()) edit.remove(YaverNativePrefs.GUEST_PROJECT_NAME)
    else edit.putString(YaverNativePrefs.GUEST_PROJECT_NAME, n)
    if (p.isEmpty()) edit.remove(YaverNativePrefs.GUEST_PROJECT_PATH)
    else edit.putString(YaverNativePrefs.GUEST_PROJECT_PATH, p)
    edit.apply()
  }
}

/** SharedPreferences keys shared across the Android native panes — must
 *  stay in sync with the iOS UserDefaults keys (YaverInfo.swift,
 *  YaverFeedbackPane.swift, YaverAgentsPane.swift) so the same JS surface
 *  drives both platforms identically. */
object YaverNativePrefs {
  const val NAME = "yaver_native_prefs"
  const val INHERITED_AUTH_TOKEN = "yaverInheritedAuthToken"
  const val AGENT_BASE_URL = "yaverAgentBaseURL"
  const val AGENT_AUTH = "yaverAgentAuth"
  const val INHERITED_DEVICE_ID = "yaverInheritedDeviceId"
  const val GUEST_BUNDLE_LOADED = "yaverGuestAppRunning"
  const val PENDING_FEEDBACK_LAUNCH = "yaverPendingFeedbackLaunch"
  // Preferred runner + model pushed by DeviceContext (Convex source of
  // truth: userSettings.primaryRunnerByDevice). Read by the feedback
  // pane so its POST /tasks routes to the same runner the user picked
  // in the Tasks tab. iOS counterparts: yaverPreferredRunner /
  // yaverPreferredModel UserDefaults keys.
  const val PREFERRED_RUNNER = "yaverPreferredRunner"
  const val PREFERRED_MODEL = "yaverPreferredModel"
  // Relay password for X-Relay-Password header on relay-routed agent
  // requests. Without this, the feedback POST fails 401 / "invalid
  // relay password" on relay-tunnelled agents.
  const val RELAY_PASSWORD = "yaverInheritedRelayPassword"
  // Active Hot-Reload project name + path. Prepended as a banner to
  // the prompt so the AI on the remote knows which app the user's
  // feedback applies to.
  const val GUEST_PROJECT_NAME = "yaverInheritedGuestProjectName"
  const val GUEST_PROJECT_PATH = "yaverInheritedGuestProjectPath"
  // YaverBundleLoader — Hermes-push guest bundle state. Mirrors the
  // iOS UserDefaults keys (see YaverBundleLoader.swift) so the JS
  // contract (loadedModuleName / loadedBundleMd5) is platform-symmetric.
  const val LOADED_MODULE_NAME = "yaverLoadedModuleName"
  const val LOADED_BUNDLE_MD5 = "yaverLoadedBundleMd5"
  const val SELECTED_RUNTIME_FAMILY_ID = "yaverSelectedRuntimeFamilyID"
  const val SELECTED_RUNTIME_FAMILY_LABEL = "yaverSelectedRuntimeFamilyLabel"
}

/**
 * Android GATT peripheral for Yaver Secure Handoff. It exposes only a short-
 * lived public request and accepts a framed encrypted envelope. Decryption and
 * secure-storage writes remain in shared JS; BLE is never the trust boundary.
 * Registered beside YaverInfo in YaverInfoPackage so this tracked native tree
 * cannot silently omit the module (mobile/android ignores new files by default).
 */
class YaverCredentialBleModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {

  companion object {
    val SERVICE_UUID: UUID = UUID.fromString("59415645-1001-4d65-7368-0000000000a0")
    val REQUEST_UUID: UUID = UUID.fromString("59415645-1002-4d65-7368-0000000000a0")
    val ENVELOPE_UUID: UUID = UUID.fromString("59415645-1003-4d65-7368-0000000000a0")
    const val HEADER_BYTES = 4
    const val MAX_ENVELOPE_BYTES = 16 * 1024
  }

  private var server: BluetoothGattServer? = null
  private var requestBytes = ByteArray(0)
  private val chunks = sortedMapOf<Int, ByteArray>()
  private var messageId = -1
  private var lastSequence = -1
  private var advertiseCallback: AdvertiseCallback? = null

  init { context.addLifecycleEventListener(this) }

  override fun getName(): String = "YaverCredentialBle"

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  private fun hasPermission(permission: String): Boolean =
      ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  @ReactMethod
  fun startReceiver(request: String, promise: Promise) {
    stopInternal()
    if (request.toByteArray(StandardCharsets.UTF_8).size > 4 * 1024) {
      promise.reject("BLE_REQUEST_TOO_LARGE", "The secure-handoff request is too large.")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT) || !hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE))) {
      promise.reject("BLE_PERMISSION_REQUIRED", "Nearby devices permission is required to receive a secure handoff.")
      return
    }
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = manager?.adapter
    val advertiser = adapter?.bluetoothLeAdvertiser
    if (manager == null || adapter == null || !adapter.isEnabled || advertiser == null || !adapter.isMultipleAdvertisementSupported) {
      promise.reject("BLE_PERIPHERAL_UNAVAILABLE", "This Android device cannot advertise a BLE secure-handoff receiver.")
      return
    }

    requestBytes = request.toByteArray(StandardCharsets.UTF_8)
    val callback = object : BluetoothGattServerCallback() {
      override fun onCharacteristicReadRequest(
          device: BluetoothDevice,
          requestId: Int,
          offset: Int,
          characteristic: BluetoothGattCharacteristic,
      ) {
        if (characteristic.uuid != REQUEST_UUID || offset < 0 || offset > requestBytes.size) {
          server?.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
          return
        }
        server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, requestBytes.copyOfRange(offset, requestBytes.size))
      }

      override fun onCharacteristicWriteRequest(
          device: BluetoothDevice,
          requestId: Int,
          characteristic: BluetoothGattCharacteristic,
          preparedWrite: Boolean,
          responseNeeded: Boolean,
          offset: Int,
          value: ByteArray,
      ) {
        val ok = characteristic.uuid == ENVELOPE_UUID && !preparedWrite && acceptFrame(value)
        if (responseNeeded) server?.sendResponse(device, requestId, if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE, offset, null)
      }
    }
    server = manager.openGattServer(context, callback)
    if (server == null) {
      promise.reject("BLE_GATT_UNAVAILABLE", "Android could not open the secure-handoff GATT server.")
      return
    }
    val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(BluetoothGattCharacteristic(
        REQUEST_UUID,
        BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ,
    ))
    service.addCharacteristic(BluetoothGattCharacteristic(
        ENVELOPE_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE,
    ))
    if (!server!!.addService(service)) {
      stopInternal()
      promise.reject("BLE_GATT_UNAVAILABLE", "Android could not publish the secure-handoff GATT service.")
      return
    }

    val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setConnectable(true)
        .setTimeout(0)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
        .build()
    val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    val adCallback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) { promise.resolve(true) }
      override fun onStartFailure(errorCode: Int) {
        stopInternal()
        promise.reject("BLE_ADVERTISE_FAILED", "Android BLE advertising failed ($errorCode).")
      }
    }
    advertiseCallback = adCallback
    advertiser.startAdvertising(settings, data, adCallback)
  }

  @Synchronized
  private fun acceptFrame(frame: ByteArray): Boolean {
    if (frame.size < HEADER_BYTES) return false
    val id = frame[0].toInt() and 0xff
    val sequence = ((frame[1].toInt() and 0xff) shl 8) or (frame[2].toInt() and 0xff)
    val last = (frame[3].toInt() and 1) == 1
    if (messageId != id) {
      chunks.clear()
      messageId = id
      lastSequence = -1
    }
    if (sequence > 1024) return false
    chunks[sequence] = frame.copyOfRange(HEADER_BYTES, frame.size)
    val total = chunks.values.sumOf { it.size }
    if (total > MAX_ENVELOPE_BYTES) {
      chunks.clear()
      return false
    }
    if (last) lastSequence = sequence
    if (lastSequence >= 0 && (0..lastSequence).all { chunks.containsKey(it) }) {
      val joined = ByteArray(total)
      var cursor = 0
      for (index in 0..lastSequence) {
        val part = chunks[index] ?: return false
        part.copyInto(joined, cursor)
        cursor += part.size
      }
      chunks.clear()
      lastSequence = -1
      val map = Arguments.createMap().apply { putString("value", String(joined, StandardCharsets.UTF_8)) }
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("YaverCredentialBleEnvelope", map)
      stopAdvertisingOnly()
    }
    return true
  }

  @ReactMethod fun stopReceiver() { stopInternal() }

  private fun stopAdvertisingOnly() {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    advertiseCallback?.let { manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(it) }
    advertiseCallback = null
  }

  private fun stopInternal() {
    stopAdvertisingOnly()
    server?.close()
    server = null
    requestBytes = ByteArray(0)
    chunks.clear()
    messageId = -1
    lastSequence = -1
  }

  override fun onHostResume() {}
  override fun onHostPause() {}
  override fun onHostDestroy() { stopInternal() }
}
