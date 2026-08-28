package io.yaver.feedback;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.Window;
import android.view.accessibility.AccessibilityManager;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;

/** Passive three-finger hold observer for the Dogfood two-action card. */
public final class YaverDogfoodGestureModule extends ReactContextBaseJavaModule
        implements LifecycleEventListener,
        AccessibilityManager.TouchExplorationStateChangeListener {

    private static final String MODULE_NAME = "YaverDogfoodGesture";
    private static final String TRIGGER_EVENT = "yaverDogfoodControlGesture";
    private static final String CAPABILITY_EVENT = "yaverDogfoodControlCapability";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AccessibilityManager accessibilityManager;
    private final Map<Integer, float[]> initialPoints = new HashMap<>();
    private boolean requestedEnabled = false;
    private long durationMs = 900;
    private boolean fired = false;
    private float touchSlop = 16f;
    private Activity attachedActivity;
    private Window attachedWindow;
    private Window.Callback originalCallback;
    private Window.Callback observingCallback;

    private final Runnable fireGesture = () -> {
        if (!requestedEnabled || fired || initialPoints.size() < 3 || accessibilityConflict()) return;
        fired = true;
        if (attachedWindow != null) {
            View decor = attachedWindow.getDecorView();
            decor.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
        }
        WritableMap event = Arguments.createMap();
        event.putString("source", "three-finger-hold");
        emit(TRIGGER_EVENT, event);
    };

    public YaverDogfoodGestureModule(ReactApplicationContext context) {
        super(context);
        accessibilityManager = (AccessibilityManager) context.getSystemService(Context.ACCESSIBILITY_SERVICE);
        context.addLifecycleEventListener(this);
        if (accessibilityManager != null) {
            accessibilityManager.addTouchExplorationStateChangeListener(this);
        }
    }

    @Override
    @NonNull
    public String getName() {
        return MODULE_NAME;
    }

    @ReactMethod
    public void getCapability(Promise promise) {
        mainHandler.post(() -> promise.resolve(status()));
    }

    @ReactMethod
    public void setEnabled(boolean enabled, double requestedDurationMs, Promise promise) {
        mainHandler.post(() -> {
            requestedEnabled = enabled;
            durationMs = Math.max(650L, Math.min(2000L, Math.round(requestedDurationMs)));
            reconcile();
            promise.resolve(status());
        });
    }

    private boolean accessibilityConflict() {
        return accessibilityManager != null && accessibilityManager.isTouchExplorationEnabled();
    }

    private WritableMap status() {
        WritableMap result = Arguments.createMap();
        boolean supported = !accessibilityConflict();
        result.putBoolean("supported", supported);
        result.putBoolean("enabled", requestedEnabled && supported && observingCallback != null);
        result.putString("reason", !supported
                ? "accessibility-touch-exploration"
                : (getCurrentActivity() == null ? "window-unavailable" : "supported"));
        result.putString("platform", "android");
        return result;
    }

    private void reconcile() {
        Activity current = getCurrentActivity();
        if (!requestedEnabled || accessibilityConflict() || current == null) {
            detach();
            return;
        }
        Window window = current.getWindow();
        if (attachedActivity == current && attachedWindow == window
                && window.getCallback() == observingCallback) return;
        detach();
        Window.Callback callback = window.getCallback();
        if (callback == null) return;
        touchSlop = ViewConfiguration.get(current).getScaledTouchSlop();
        Window.Callback proxy = (Window.Callback) Proxy.newProxyInstance(
                YaverDogfoodGestureModule.class.getClassLoader(),
                new Class<?>[]{Window.Callback.class},
                (ignored, method, args) -> {
                    if ("dispatchTouchEvent".equals(method.getName())
                            && args != null && args.length == 1 && args[0] instanceof MotionEvent) {
                        observe((MotionEvent) args[0]);
                    }
                    try {
                        return method.invoke(callback, args);
                    } catch (InvocationTargetException error) {
                        throw error.getCause();
                    }
                });
        attachedActivity = current;
        attachedWindow = window;
        originalCallback = callback;
        observingCallback = proxy;
        window.setCallback(proxy);
    }

    private void detach() {
        cancelGesture();
        if (attachedWindow != null && attachedWindow.getCallback() == observingCallback
                && originalCallback != null) {
            attachedWindow.setCallback(originalCallback);
        }
        attachedActivity = null;
        attachedWindow = null;
        originalCallback = null;
        observingCallback = null;
    }

    /** Observe without consuming: the original Window.Callback always receives the event. */
    private void observe(MotionEvent event) {
        if (!requestedEnabled || accessibilityConflict()) return;
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                cancelGesture();
                rememberPointers(event);
                break;
            case MotionEvent.ACTION_POINTER_DOWN:
                rememberPointers(event);
                if (event.getPointerCount() >= 3 && !fired) {
                    mainHandler.removeCallbacks(fireGesture);
                    mainHandler.postDelayed(fireGesture, durationMs);
                }
                break;
            case MotionEvent.ACTION_MOVE:
                if (movedTooFar(event)) cancelGesture();
                break;
            case MotionEvent.ACTION_POINTER_UP:
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                cancelGesture();
                break;
            default:
                break;
        }
    }

    private void rememberPointers(MotionEvent event) {
        for (int index = 0; index < event.getPointerCount(); index++) {
            int id = event.getPointerId(index);
            if (!initialPoints.containsKey(id)) {
                initialPoints.put(id, new float[]{event.getX(index), event.getY(index)});
            }
        }
    }

    private boolean movedTooFar(MotionEvent event) {
        for (int index = 0; index < event.getPointerCount(); index++) {
            float[] start = initialPoints.get(event.getPointerId(index));
            if (start == null) continue;
            if (Math.abs(event.getX(index) - start[0]) > touchSlop
                    || Math.abs(event.getY(index) - start[1]) > touchSlop) return true;
        }
        return false;
    }

    private void cancelGesture() {
        mainHandler.removeCallbacks(fireGesture);
        initialPoints.clear();
        fired = false;
    }

    private void emit(String name, WritableMap body) {
        try {
            getReactApplicationContext()
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(name, body);
        } catch (RuntimeException ignored) {
            // No JS bridge/listener yet; a trigger must never break the host app.
        }
    }

    private void emitCapability() {
        emit(CAPABILITY_EVENT, status());
    }

    @Override
    public void onHostResume() {
        mainHandler.post(() -> {
            reconcile();
            emitCapability();
        });
    }

    @Override public void onHostPause() { cancelGesture(); }

    @Override public void onHostDestroy() { detach(); }

    @Override
    public void onTouchExplorationStateChanged(boolean enabled) {
        mainHandler.post(() -> {
            reconcile();
            emitCapability();
        });
    }
}
