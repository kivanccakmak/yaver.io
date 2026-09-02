package io.yaver.feedback;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.AtomicFile;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.ReactApplication;
import com.facebook.react.ReactInstanceManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.Collections;

/**
 * Hot reload native module for the Yaver Feedback SDK (Android).
 *
 * Downloads a Hermes bytecode bundle from the agent, saves it to the app's
 * files directory, and recreates the React Native context to load the new bundle.
 *
 * Supports N reloads — each reload recreates the ReactContext with the updated bundle.
 */
public class YaverHotReloadModule extends ReactContextBaseJavaModule {

    private static final String TAG = "YaverHotReload";
    private static final String MODULE_NAME = "YaverHotReload";
    private static final String BUNDLE_DIR = "yaver-hot-reload";
    private static final String BUNDLE_FILE = "index.android.bundle";
    private static final String PREFS_NAME = "yaver_hot_reload";
    private static final String PREFS_KEY_BUNDLE = "bundle_path";
    private static final String PREFS_KEY_BOOT_ATTEMPTS = "boot_attempts";
    private static final String PREFS_KEY_BUNDLE_MTIME = "bundle_mtime";
    private static final int MAX_BOOT_ATTEMPTS = 3;
    private static final String DOGFOOD_SHORTCUT_ID = "io.yaver.feedback.dogfood";
    private static final String DOGFOOD_SHORTCUT_EXTRA = "io.yaver.feedback.DOGFOOD";
    // Reuse one bounded worker. Creating a fresh single-thread executor for
    // every reload leaves every executor/thread alive for the process lifetime.
    private static final ExecutorService RELOAD_EXECUTOR = Executors.newSingleThreadExecutor();

    public YaverHotReloadModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    @NonNull
    public String getName() {
        return MODULE_NAME;
    }

    /**
     * Download a Hermes bundle from the agent and trigger a bridge reload.
     */
    @ReactMethod
    public void loadBundle(String urlString, ReadableMap headers, Promise promise) {
        RELOAD_EXECUTOR.execute(() -> {
            HttpURLConnection conn = null;
            File downloadFile = null;
            try {
                URL url = new URL(urlString);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(60000);
                conn.setReadTimeout(60000);

                // Set auth headers
                if (headers != null) {
                    if (headers.hasKey("Authorization")) {
                        conn.setRequestProperty("Authorization", headers.getString("Authorization"));
                    }
                }

                int responseCode = conn.getResponseCode();
                if (responseCode != 200) {
                    promise.reject("HTTP_ERROR", "Status " + responseCode);
                    return;
                }

                File dir = new File(getReactApplicationContext().getFilesDir(), BUNDLE_DIR);
                if (!dir.exists()) dir.mkdirs();
                File bundleFile = new File(dir, BUNDLE_FILE);

                downloadFile = new File(dir, BUNDLE_FILE + ".download");
                int totalBytes = 0;
                try (InputStream is = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(downloadFile)) {
                    byte[] buffer = new byte[8192];
                    int bytesRead;
                    while ((bytesRead = is.read(buffer)) != -1) {
                        fos.write(buffer, 0, bytesRead);
                        totalBytes += bytesRead;
                    }
                }

                Log.i(TAG, "downloaded " + totalBytes + " bytes for validation");

                // Validate the complete temporary download before touching the
                // last known-good executable bundle.
                if (totalBytes < 12) {
                    promise.reject("INVALID_HERMES_BUNDLE", "Downloaded bundle is too small to be Hermes bytecode");
                    return;
                }
                java.io.RandomAccessFile raf = new java.io.RandomAccessFile(downloadFile, "r");
                raf.seek(4);
                int magic = Integer.reverseBytes(raf.readInt());
                if (magic != 0x1F1903C1) {
                    raf.close();
                    promise.reject("INVALID_HERMES_BUNDLE", "Downloaded bundle is not Hermes bytecode (magic=0x" + Integer.toHexString(magic) + ")");
                    return;
                }
                int bcVersion = Integer.reverseBytes(raf.readInt());
                raf.close();
                Log.i(TAG, "Hermes bytecode BC" + bcVersion);

                AtomicFile atomicFile = new AtomicFile(bundleFile);
                FileOutputStream atomicOut = null;
                try {
                    atomicOut = atomicFile.startWrite();
                    try (java.io.FileInputStream validated = new java.io.FileInputStream(downloadFile)) {
                        byte[] copyBuffer = new byte[8192];
                        int copied;
                        while ((copied = validated.read(copyBuffer)) != -1) atomicOut.write(copyBuffer, 0, copied);
                    }
                    atomicFile.finishWrite(atomicOut);
                    atomicOut = null;
                } catch (Exception writeError) {
                    if (atomicOut != null) atomicFile.failWrite(atomicOut);
                    throw writeError;
                }
                Log.i(TAG, "saved " + totalBytes + " validated bytes to " + bundleFile.getAbsolutePath());

                // Save bundle path to SharedPreferences for next app launch
                SharedPreferences prefs = getReactApplicationContext()
                        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(PREFS_KEY_BUNDLE, bundleFile.getAbsolutePath()).apply();

                WritableMap result = Arguments.createMap();
                result.putBoolean("loaded", true);
                result.putInt("size", totalBytes);
                promise.resolve(result);

                // Reload the bridge on the main thread
                new Handler(Looper.getMainLooper()).post(() -> reloadBridge());

            } catch (Exception e) {
                Log.e(TAG, "download failed", e);
                promise.reject("DOWNLOAD_FAILED", e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
                if (downloadFile != null && downloadFile.exists()) downloadFile.delete();
            }
        });
    }

    @ReactMethod
    public void hasBundle(Promise promise) {
        File bundleFile = getSavedBundleFile(getReactApplicationContext());
        promise.resolve(bundleFile != null && bundleFile.exists());
    }

    @ReactMethod
    public void clearBundle(Promise promise) {
        clearStoredBundle();
        promise.resolve(true);
    }

    /** Clear the hot bundle and immediately recreate React Native so the
     * installed APK bundle becomes the running surface. */
    @ReactMethod
    public void clearBundleAndReload(Promise promise) {
        clearStoredBundle();
        promise.resolve(true);
        new Handler(Looper.getMainLooper()).post(() -> reloadBridge());
    }

    private void clearStoredBundle() {
        File dir = new File(getReactApplicationContext().getFilesDir(), BUNDLE_DIR);
        if (dir.exists()) {
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) f.delete();
            dir.delete();
        }
        SharedPreferences prefs = getReactApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
                .remove(PREFS_KEY_BUNDLE)
                .remove(PREFS_KEY_BOOT_ATTEMPTS)
                .remove(PREFS_KEY_BUNDLE_MTIME)
                .apply();
    }

    /** Dynamic shortcut: only JS, after backend ACL resolution, may add it. */
    @ReactMethod
    public void setDogfoodShortcut(boolean enabled, String label, Promise promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) {
                promise.resolve(false);
                return;
            }
            Context context = getReactApplicationContext();
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager == null) {
                promise.resolve(false);
                return;
            }
            manager.removeDynamicShortcuts(Collections.singletonList(DOGFOOD_SHORTCUT_ID));
            if (enabled) {
                Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                if (intent == null) throw new IllegalStateException("App launch intent unavailable");
                intent.setAction(DOGFOOD_SHORTCUT_EXTRA);
                intent.putExtra(DOGFOOD_SHORTCUT_EXTRA, true);
                ShortcutInfo shortcut = new ShortcutInfo.Builder(context, DOGFOOD_SHORTCUT_ID)
                        .setShortLabel(label == null || label.trim().isEmpty() ? "Dogfood" : label)
                        .setLongLabel(label == null || label.trim().isEmpty() ? "Dogfood" : label)
                        .setIcon(Icon.createWithResource(context, android.R.drawable.ic_media_play))
                        .setIntent(intent)
                        .build();
                manager.addDynamicShortcuts(Collections.singletonList(shortcut));
            }
            promise.resolve(enabled);
        } catch (Exception error) {
            promise.reject("DOGFOOD_SHORTCUT_FAILED", error.getMessage(), error);
        }
    }

    @ReactMethod
    public void consumeDogfoodShortcut(Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null || activity.getIntent() == null) {
            promise.resolve(false);
            return;
        }
        Intent intent = activity.getIntent();
        boolean pending = DOGFOOD_SHORTCUT_EXTRA.equals(intent.getAction())
                || intent.getBooleanExtra(DOGFOOD_SHORTCUT_EXTRA, false);
        if (pending) {
            intent.removeExtra(DOGFOOD_SHORTCUT_EXTRA);
            intent.setAction(Intent.ACTION_MAIN);
        }
        promise.resolve(pending);
    }

    /**
     * Recreate the React Native context with the new bundle.
     */
    private void reloadBridge() {
        Activity activity = getCurrentActivity();
        if (activity == null) {
            Log.e(TAG, "no current activity");
            return;
        }

        if (activity.getApplication() instanceof ReactApplication) {
            ReactApplication app = (ReactApplication) activity.getApplication();
            ReactInstanceManager manager = app.getReactNativeHost().getReactInstanceManager();
            Log.i(TAG, "recreating React context with new bundle");
            manager.recreateReactContextInBackground();
        } else {
            Log.e(TAG, "Application does not implement ReactApplication");
        }
    }

    // MARK: - Static helpers for Application/MainApplication

    /**
     * Returns the hot-reloaded bundle file if it exists AND has not
     * crashed on boot {@link #MAX_BOOT_ATTEMPTS} times in a row.
     * Call from MainApplication.getJSBundleFile() to load the hot bundle
     * on startup.
     *
     * Safety net for the vibe-coding loop: if a pushed bundle crashes
     * on boot, without this guard the saved bundle persists across
     * cold starts and bricks the app. Counter increments on each cold
     * start, resets on {@link #markBootSuccessful(Context)} (called
     * from MainApplication's ReactInstanceEventListener after JS
     * context init, and a 10-s fallback timer). If the counter hits
     * {@link #MAX_BOOT_ATTEMPTS}, delete the saved bundle and return
     * null so MainApplication falls back to the APK-bundled bundle.
     * See YaverHotReload.swift for the matching iOS implementation.
     */
    public static File getSavedBundleFile(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String path = prefs.getString(PREFS_KEY_BUNDLE, null);
        if (path == null) return null;
        File f = new File(path);
        if (!f.exists()) return null;

        long currentMtime = f.lastModified();
        long lastMtime = prefs.getLong(PREFS_KEY_BUNDLE_MTIME, 0);
        SharedPreferences.Editor editor = prefs.edit();

        // Fresh bundle since the counter was last reset → start over.
        if (currentMtime != lastMtime) {
            editor.putInt(PREFS_KEY_BOOT_ATTEMPTS, 0);
            editor.putLong(PREFS_KEY_BUNDLE_MTIME, currentMtime);
        }

        int attempts = prefs.getInt(PREFS_KEY_BOOT_ATTEMPTS, 0);
        if (attempts >= MAX_BOOT_ATTEMPTS) {
            Log.w(TAG, "hot bundle failed " + attempts + " consecutive boot attempts — reverting to APK-bundled bundle.");
            File dir = new File(context.getFilesDir(), BUNDLE_DIR);
            if (dir.exists()) {
                File[] list = dir.listFiles();
                if (list != null) for (File child : list) child.delete();
                dir.delete();
            }
            editor.remove(PREFS_KEY_BOOT_ATTEMPTS)
                  .remove(PREFS_KEY_BUNDLE_MTIME)
                  .remove(PREFS_KEY_BUNDLE)
                  .apply();
            return null;
        }

        // Pre-increment: this boot counts as a failure unless the JS
        // side reaches context-initialized and calls markBootSuccessful.
        editor.putInt(PREFS_KEY_BOOT_ATTEMPTS, attempts + 1).apply();
        Log.i(TAG, "loading hot bundle (boot attempt " + (attempts + 1) + "/" + MAX_BOOT_ATTEMPTS + ")");
        return f;
    }

    /**
     * Clear the boot-attempt counter. MainApplication should call this
     * from a ReactInstanceEventListener after JS context init, AND via
     * a 10-s fallback Handler in case the listener never fires.
     */
    public static void markBootSuccessful(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int attempts = prefs.getInt(PREFS_KEY_BOOT_ATTEMPTS, 0);
        if (attempts > 0) {
            Log.i(TAG, "boot confirmed successful — reset boot-attempt counter.");
        }
        prefs.edit().putInt(PREFS_KEY_BOOT_ATTEMPTS, 0).apply();
    }
}
