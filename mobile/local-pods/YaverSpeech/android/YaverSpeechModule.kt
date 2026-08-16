package io.yaver.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale

/**
 * STT (SpeechRecognizer) + TTS (TextToSpeech) for Android / Android TV.
 * Mirrors the iOS/tvOS YaverSpeech module API: startListening/stopListening/speak/stopSpeaking.
 * Emits "onResult" / "onPartial" / "onError" events.
 */
class YaverSpeechModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), RecognitionListener, TextToSpeech.OnInitListener {

  private var speechRecognizer: SpeechRecognizer? = null
  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private var isListening = false

  override fun getName(): String = "YaverSpeech"

  @ReactMethod
  fun addListener(eventName: String?) { /* required for NativeEventEmitter */ }

  @ReactMethod
  fun removeListeners(count: Int) { /* required for NativeEventEmitter */ }

  private fun emit(event: String, body: Any) {
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, body)
  }

  // ── STT ────────────────────────────────────────────────────────────

  @ReactMethod
  fun startListening(locale: String?, promise: Promise) {
    if (isListening) {
      promise.resolve(true)
      return
    }
    val ctx = reactApplicationContext
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      promise.reject("denied", "RECORD_AUDIO permission not granted")
      return
    }
    val recognizer = SpeechRecognizer.createSpeechRecognizer(ctx)
    speechRecognizer = recognizer
    recognizer.setRecognitionListener(this)
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale ?: Locale.getDefault().toLanguageTag())
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    }
    isListening = true
    recognizer.startListening(intent)
    promise.resolve(true)
  }

  @ReactMethod
  fun stopListening(promise: Promise) {
    speechRecognizer?.stopListening()
    promise.resolve(true)
  }

  // ── TTS ────────────────────────────────────────────────────────────

  @ReactMethod
  fun speak(text: String, rate: Double, promise: Promise) {
    if (!ttsReady) {
      initTts()
    }
    if (!ttsReady) {
      promise.resolve(false)
      return
    }
    tts?.setSpeechRate(if (rate > 0) rate.toFloat() else 1.0f)
    tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "yaver")
    promise.resolve(true)
  }

  private fun initTts() {
    tts = TextToSpeech(reactApplicationContext) { status ->
      ttsReady = status == TextToSpeech.SUCCESS
    }
  }

  @ReactMethod
  fun stopSpeaking(promise: Promise) {
    tts?.stop()
    promise.resolve(true)
  }

  @ReactMethod
  fun isTtsSpeaking(promise: Promise) {
    promise.resolve(tts?.isSpeaking == true)
  }

  // ── RecognitionListener ────────────────────────────────────────────

  override fun onReadyForSpeech(params: Bundle?) {}
  override fun onBeginningOfSpeech() {}
  override fun onRmsChanged(rmsdB: Float) {}
  override fun onBufferReceived(buffer: ByteArray?) {}
  override fun onEndOfSpeech() {}

  override fun onError(error: Int) {
    isListening = false
    emit("onError", error.toString())
  }

  override fun onResults(results: Bundle?) {
    isListening = false
    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
    if (text.isNotBlank()) emit("onResult", text)
  }

  override fun onPartialResults(partialResults: Bundle?) {
    val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
    if (text.isNotBlank()) emit("onPartial", text)
  }

  override fun onEvent(eventType: Int, params: Bundle?) {}
}
