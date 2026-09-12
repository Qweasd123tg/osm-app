package app.sloi.map;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class MainActivity extends Activity {
    private static final String TAG = "SloiMap";
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = APP_ORIGIN + "/assets/index.html";
    private static final int LOCATION_PERMISSION_REQUEST = 1001;
    private static final int GEOJSON_IMPORT_REQUEST = 1002;
    private static final int MAX_GEOJSON_BYTES = 2 * 1024 * 1024;

    private WebView webView;
    private OnDeviceSceneEngine sceneEngine;
    private CityPackStore cityPackStore;
    private ExecutorService engineExecutor;
    private ExecutorService packExecutor;
    private ExecutorService viewportExecutor;
    private ExecutorService importExecutor;
    private final Object taskLock = new Object();
    private Future<?> sceneFuture;
    private Future<?> frameFuture;
    private Future<?> searchFuture;
    private Future<?> packFuture;
    private Future<?> packCatalogFuture;
    private Future<?> viewportFuture;
    private Future<?> importFuture;
    private long sceneGeneration;
    private long frameGeneration;
    private long searchGeneration;
    private long packGeneration;
    private long packCatalogGeneration;
    private long viewportGeneration;
    private long importGeneration;
    private String sceneRequestId;
    private boolean geoJsonChooserPending;
    private volatile boolean destroyed;
    private Object backInvokedCallback;
    private GeolocationPermissions.Callback pendingLocationCallback;
    private String pendingLocationOrigin;

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.rgb(246, 245, 240));
        getWindow().setNavigationBarColor(Color.rgb(246, 245, 240));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(235, 238, 235));
        setContentView(webView);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backInvokedCallback = Api33Back.register(this, this::handleBackPressed);
        }

        File generatedDir = new File(getFilesDir(), "generated-scenes");
        File viewportDir = new File(getFilesDir(), "viewport-tiles");
        cityPackStore = new CityPackStore(getFilesDir());
        sceneEngine = new OnDeviceSceneEngine(
            new File(getFilesDir(), "scene-cache"),
            generatedDir,
            viewportDir,
            cityPackStore
        );
        engineExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "sloi-on-device-engine");
            thread.setPriority(Thread.NORM_PRIORITY - 1);
            return thread;
        });
        packExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "sloi-city-pack-store");
            thread.setPriority(Thread.NORM_PRIORITY - 1);
            return thread;
        });
        viewportExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "sloi-viewport-buildings");
            thread.setPriority(Thread.NORM_PRIORITY - 1);
            return thread;
        });
        importExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "sloi-geojson-import");
            thread.setPriority(Thread.NORM_PRIORITY - 1);
            return thread;
        });
        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler(
                "/generated/",
                new WebViewAssetLoader.InternalStoragePathHandler(this, generatedDir)
            )
            .addPathHandler(
                "/viewport/",
                new WebViewAssetLoader.InternalStoragePathHandler(this, viewportDir)
            )
            .build();

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSafeBrowsingEnabled(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidHost");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(
                    TAG,
                    message.message() + " @" + message.lineNumber() + ":" + message.sourceId()
                );
                return true;
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(
                String origin,
                GeolocationPermissions.Callback callback
            ) {
                if (!APP_ORIGIN.equals(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                    return;
                }

                clearPendingLocationRequest(false);
                pendingLocationOrigin = origin;
                pendingLocationCallback = callback;
                requestPermissions(
                    new String[] {Manifest.permission.ACCESS_COARSE_LOCATION},
                    LOCATION_PERMISSION_REQUEST
                );
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                WebView view,
                WebResourceRequest request
            ) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                WebView view,
                WebResourceRequest request
            ) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("https".equals(scheme) && APP_HOST.equals(uri.getHost())) {
                    return false;
                }
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                }
                return true;
            }

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
            ) {
                if (request.isForMainFrame()) {
                    view.evaluateJavascript(
                        "window.SloiApp && window.SloiApp.showFatal(" +
                            "'Не удалось открыть локальную карту')",
                        null
                    );
                }
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        String[] permissions,
        int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != LOCATION_PERMISSION_REQUEST) {
            return;
        }
        boolean granted = grantResults.length > 0
            && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        clearPendingLocationRequest(granted);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != GEOJSON_IMPORT_REQUEST) return;
        final long generation;
        synchronized (taskLock) {
            if (destroyed || !geoJsonChooserPending) return;
            geoJsonChooserPending = false;
            generation = importGeneration;
        }
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            dispatchJavascriptIfCurrent(
                () -> generation == importGeneration,
                "window.SloiApp&&window.SloiApp.onGeoJsonImportCancelled()"
            );
            return;
        }
        Uri uri = data.getData();
        if (!"content".equals(uri.getScheme())) {
            dispatchJavascriptIfCurrent(
                () -> generation == importGeneration,
                "window.SloiApp&&window.SloiApp.onGeoJsonImportError(" +
                    quoted("Можно импортировать только файл, выбранный через системный диалог") + ")"
            );
            return;
        }
        synchronized (taskLock) {
            if (generation != importGeneration || destroyed) return;
            cancel(importFuture);
            importFuture = importExecutor.submit(() -> importGeoJson(uri, generation));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    @SuppressLint("GestureBackNavigation")
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBackPressed();
    }

    private void handleBackPressed() {
        webView.evaluateJavascript(
            "Boolean(window.SloiApp && window.SloiApp.closeTransientUi())",
            result -> {
                if ("true".equals(result)) {
                    return;
                }
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finishAfterTransition();
                }
            }
        );
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && backInvokedCallback != null) {
            Api33Back.unregister(this, backInvokedCallback);
            backInvokedCallback = null;
        }
        clearPendingLocationRequest(false);
        sceneEngine.cancelActiveRequests();
        cityPackStore.cancelActiveRequests();
        synchronized (taskLock) {
            importGeneration++;
            geoJsonChooserPending = false;
            cancel(sceneFuture);
            cancel(frameFuture);
            cancel(searchFuture);
            cancel(packFuture);
            cancel(packCatalogFuture);
            cancel(viewportFuture);
            cancel(importFuture);
        }
        engineExecutor.shutdownNow();
        packExecutor.shutdownNow();
        viewportExecutor.shutdownNow();
        importExecutor.shutdownNow();
        sceneEngine.clearMemory();
        webView.removeJavascriptInterface("AndroidHost");
        webView.destroy();
        super.onDestroy();
    }

    private void clearPendingLocationRequest(boolean allowed) {
        if (pendingLocationCallback != null && pendingLocationOrigin != null) {
            pendingLocationCallback.invoke(pendingLocationOrigin, allowed, false);
        }
        pendingLocationCallback = null;
        pendingLocationOrigin = null;
    }

    private static void cancel(Future<?> future) {
        if (future != null) {
            future.cancel(true);
        }
    }

    private void dispatchJavascript(String script) {
        if (destroyed || webView == null) {
            return;
        }
        webView.post(() -> {
            if (!destroyed && webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private interface DispatchGuard { boolean isCurrent(); }

    /** Re-checks ownership on the WebView thread immediately before enqueueing JavaScript. */
    private void dispatchJavascriptIfCurrent(DispatchGuard guard, String script) {
        if (destroyed || webView == null) return;
        webView.post(() -> {
            synchronized (taskLock) {
                if (!destroyed && webView != null && guard.isCurrent()) {
                    webView.evaluateJavascript(script, null);
                }
            }
        });
    }

    private void invalidatePackCatalogLocked() {
        packCatalogGeneration++;
        cancel(packCatalogFuture);
    }

    private void importGeoJson(Uri uri, long generation) {
        try {
            String displayName = geoJsonDisplayName(uri);
            String text;
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) throw new java.io.IOException("Не удалось открыть выбранный файл");
                text = OnDeviceSceneEngine.readUtf8Limited(input, MAX_GEOJSON_BYTES);
            }
            validateGeoJson(text);
            dispatchJavascriptIfCurrent(
                () -> generation == importGeneration,
                "window.SloiApp&&window.SloiApp.onGeoJsonImported(" + quoted(displayName) +
                    "," + quoted(text) + ")"
            );
        } catch (Throwable error) {
            dispatchJavascriptIfCurrent(
                () -> generation == importGeneration,
                "window.SloiApp&&window.SloiApp.onGeoJsonImportError(" +
                    quoted(messageOf(error)) + ")"
            );
        }
    }

    private static void validateGeoJson(String text) throws java.io.IOException {
        try {
            String type = new JSONObject(text).optString("type", "");
            switch (type) {
                case "FeatureCollection": case "Feature": case "GeometryCollection":
                case "Point": case "MultiPoint": case "LineString": case "MultiLineString":
                case "Polygon": case "MultiPolygon": return;
                default: throw new java.io.IOException("Файл не содержит объект GeoJSON");
            }
        } catch (org.json.JSONException error) {
            throw new java.io.IOException("Файл не содержит корректный JSON", error);
        }
    }

    private String geoJsonDisplayName(Uri uri) {
        String name = null;
        try (Cursor cursor = getContentResolver().query(
            uri,
            new String[] {OpenableColumns.DISPLAY_NAME},
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0);
        } catch (RuntimeException ignored) {
            // Providers are allowed to omit or reject metadata queries; reading may still work.
        }
        if (name == null || name.trim().isEmpty()) name = "import.geojson";
        name = name.trim();
        return name.length() <= 200 ? name : name.substring(0, 200);
    }

    private static String quoted(String value) {
        return JSONObject.quote(value == null ? "" : value);
    }

    private static String messageOf(Throwable error) {
        Throwable current = error;
        String message = null;
        while (current != null) {
            String currentMessage = current.getMessage();
            if (currentMessage != null && !currentMessage.trim().isEmpty()) {
                message = currentMessage;
            }
            current = current.getCause();
        }
        return message != null
            ? message
            : error == null ? "Неизвестная ошибка" : error.getClass().getSimpleName();
    }

    private boolean isViewportCurrent(long generation) {
        synchronized (taskLock) {
            return !destroyed && generation == viewportGeneration;
        }
    }

    /** Cancels tile streaming only when the pack operation still owns delivery. */
    private boolean invalidateViewportForPack(long generation) {
        synchronized (taskLock) {
            if (destroyed || generation != packGeneration) return false;
            viewportGeneration++;
            cancel(viewportFuture);
        }
        dispatchJavascript("window.SloiApp&&window.SloiApp.onViewportInvalidated()");
        return true;
    }

    private void dispatchViewportJavascript(long generation, String script) {
        if (!isViewportCurrent(generation) || webView == null) return;
        webView.post(() -> {
            if (isViewportCurrent(generation) && webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private static String viewportErrorCode(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (current instanceof OnDeviceSceneEngine.ViewportException) {
                return ((OnDeviceSceneEngine.ViewportException) current).code;
            }
            if (current instanceof CityPackStore.ViewportTooDenseException) return "TOO_DENSE";
            current = current.getCause();
        }
        return error instanceof IllegalArgumentException ? "INVALID_REQUEST" : "BUILD_FAILED";
    }

    @android.annotation.TargetApi(33)
    private static final class Api33Back {
        static Object register(Activity activity, Runnable action) {
            OnBackInvokedCallback callback = action::run;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                callback
            );
            return callback;
        }

        static void unregister(Activity activity, Object callback) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                (OnBackInvokedCallback) callback
            );
        }
    }

    public final class AndroidBridge {
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public void haptic() {
            webView.post(
                () -> webView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            );
        }

        @JavascriptInterface
        public void listCityPacks() {
            final long generation;
            synchronized (taskLock) {
                generation = ++packCatalogGeneration;
                cancel(packCatalogFuture);
                // Keep catalog reads on the pack executor so their filesystem snapshot cannot
                // race an atomic install/delete, but do not cancel or invalidate that operation.
                packCatalogFuture = packExecutor.submit(() -> {
                    try {
                        String payload = cityPackStore.listPacksJson(false);
                        dispatchJavascriptIfCurrent(
                            () -> generation == packCatalogGeneration,
                            "window.SloiApp&&window.SloiApp.onCityPacks(" +
                                quoted(payload) + ")"
                        );
                    } catch (Throwable error) {
                        dispatchJavascriptIfCurrent(
                            () -> generation == packCatalogGeneration,
                            "window.SloiApp&&window.SloiApp.onCityPackError(" +
                                quoted("") + "," + quoted(messageOf(error)) + ")"
                        );
                    }
                });
            }
        }

        @JavascriptInterface
        public void downloadCityPack(String id) {
            final long generation;
            synchronized (taskLock) {
                invalidatePackCatalogLocked();
                generation = ++packGeneration;
                cityPackStore.cancelActiveRequests();
                cancel(packFuture);
                packFuture = packExecutor.submit(() -> {
                    try {
                        cityPackStore.download(id, (phase, current, total) -> {
                            dispatchJavascriptIfCurrent(
                                () -> generation == packGeneration,
                                "window.SloiApp&&window.SloiApp.onCityPackProgress(" +
                                    quoted(id) + "," + quoted(phase) + "," +
                                    current + "," + total + ")"
                            );
                        });
                        // download() returns only after the validated .ready file has been atomically installed.
                        if (!invalidateViewportForPack(generation)) return;
                        dispatchJavascriptIfCurrent(
                            () -> generation == packGeneration,
                            "window.SloiApp&&window.SloiApp.onCityPackChanged(" +
                                quoted(cityPackStore.listPacksJson(false)) + ")"
                        );
                    } catch (Throwable error) {
                        dispatchJavascriptIfCurrent(
                            () -> generation == packGeneration,
                            "window.SloiApp&&window.SloiApp.onCityPackError(" +
                                quoted(id) + "," + quoted(messageOf(error)) + ")"
                        );
                    }
                });
            }
        }

        @JavascriptInterface
        public void cancelCityPack(String id) {
            final long generation;
            synchronized (taskLock) {
                invalidatePackCatalogLocked();
                generation = ++packGeneration;
                cityPackStore.cancelActiveRequests();
                cancel(packFuture);
                packFuture = packExecutor.submit(() -> {
                    String payload = cityPackStore.listPacksJson(false);
                    dispatchJavascriptIfCurrent(
                        () -> generation == packGeneration,
                        "window.SloiApp&&window.SloiApp.onCityPackChanged(" +
                            quoted(payload) + ")"
                    );
                });
            }
        }

        @JavascriptInterface
        public void deleteCityPack(String id) {
            final long generation;
            synchronized (taskLock) {
                invalidatePackCatalogLocked();
                generation = ++packGeneration;
                cityPackStore.cancelActiveRequests();
                cancel(packFuture);
                packFuture = packExecutor.submit(() -> {
                    try {
                        cityPackStore.delete(id);
                        if (!invalidateViewportForPack(generation)) return;
                        dispatchJavascriptIfCurrent(
                            () -> generation == packGeneration,
                            "window.SloiApp&&window.SloiApp.onCityPackChanged(" +
                                quoted(cityPackStore.listPacksJson(false)) + ")"
                        );
                    } catch (Throwable error) {
                        dispatchJavascriptIfCurrent(
                            () -> generation == packGeneration,
                            "window.SloiApp&&window.SloiApp.onCityPackError(" +
                                quoted(id) + "," + quoted(messageOf(error)) + ")"
                        );
                    }
                });
            }
        }

        @JavascriptInterface
        public void acceptScene(String sceneId) {
            sceneEngine.acceptScene(sceneId);
        }

        @JavascriptInterface
        public void cancelScene(String requestId) {
            synchronized (taskLock) {
                if (requestId == null || !requestId.equals(sceneRequestId)) return;
                sceneGeneration++;
                frameGeneration++;
                sceneRequestId = null;
                sceneEngine.cancelActiveRequests();
                cancel(sceneFuture);
                cancel(frameFuture);
            }
        }

        @JavascriptInterface
        public void importGeoJson() {
            runOnUiThread(() -> {
                final long generation;
                synchronized (taskLock) {
                    if (destroyed) return;
                    if (geoJsonChooserPending) {
                        dispatchJavascript(
                            "window.SloiApp&&window.SloiApp.onGeoJsonImportError(" +
                                quoted("Выбор файла уже открыт") + ")"
                        );
                        return;
                    }
                    generation = ++importGeneration;
                    geoJsonChooserPending = true;
                    cancel(importFuture);
                }
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(intent, GEOJSON_IMPORT_REQUEST);
                } catch (ActivityNotFoundException error) {
                    synchronized (taskLock) {
                        if (generation == importGeneration) geoJsonChooserPending = false;
                    }
                    dispatchJavascriptIfCurrent(
                        () -> generation == importGeneration,
                        "window.SloiApp&&window.SloiApp.onGeoJsonImportError(" +
                            quoted("В системе нет доступного выбора файлов") + ")"
                    );
                }
            });
        }

        @JavascriptInterface
        public void requestScene(String requestJson) {
            String parsedRequestId = "";
            final OnDeviceSceneEngine.SceneRequest request;
            try {
                parsedRequestId = new JSONObject(requestJson).optString("requestId", "");
                request = OnDeviceSceneEngine.SceneRequest.fromJson(requestJson);
            } catch (Exception error) {
                dispatchJavascript(
                    "window.SloiApp&&window.SloiApp.onSceneError(" +
                        quoted(parsedRequestId) + "," + quoted(messageOf(error)) + ")"
                );
                return;
            }

            final long generation;
            synchronized (taskLock) {
                generation = ++sceneGeneration;
                sceneRequestId = request.requestId;
                frameGeneration++;
                searchGeneration++;
                sceneEngine.cancelActiveRequests();
                cancel(sceneFuture);
                cancel(frameFuture);
                cancel(searchFuture);
                sceneFuture = engineExecutor.submit(() -> {
                    try {
                        OnDeviceSceneEngine.SceneBuildResult result = sceneEngine.buildScene(
                            request,
                            (stage, current, total) -> {
                                dispatchJavascriptIfCurrent(
                                    () -> generation == sceneGeneration && request.requestId.equals(sceneRequestId),
                                    "window.SloiApp&&window.SloiApp.onSceneProgress(" +
                                        quoted(request.requestId) + "," + quoted(stage) + "," +
                                        current + "," + total + ")"
                                );
                            }
                        );
                        String url = APP_ORIGIN + "/generated/" + result.file;
                        dispatchJavascriptIfCurrent(
                            () -> generation == sceneGeneration && request.requestId.equals(sceneRequestId),
                            "window.SloiApp&&window.SloiApp.onSceneReady(" +
                                quoted(request.requestId) + "," + quoted(url) + ")"
                        );
                    } catch (Throwable error) {
                        dispatchJavascriptIfCurrent(
                            () -> generation == sceneGeneration && request.requestId.equals(sceneRequestId),
                            "window.SloiApp&&window.SloiApp.onSceneError(" +
                                quoted(request.requestId) + "," + quoted(messageOf(error)) + ")"
                        );
                    }
                });
            }
        }

        @JavascriptInterface
        public void requestViewportBuildings(String requestJson) {
            String parsedRequestId = "";
            final OnDeviceSceneEngine.ViewportRequest request;
            try {
                parsedRequestId = new JSONObject(requestJson).optString("requestId", "");
                request = OnDeviceSceneEngine.ViewportRequest.fromJson(requestJson);
            } catch (Throwable error) {
                dispatchJavascript(
                    "window.SloiApp&&window.SloiApp.onViewportTileError(" + quoted(parsedRequestId)
                        + "," + quoted("") + "," + quoted("INVALID_REQUEST") + ","
                        + quoted(messageOf(error)) + ")"
                );
                return;
            }
            final long generation;
            synchronized (taskLock) {
                generation = ++viewportGeneration;
                cancel(viewportFuture);
                viewportFuture = viewportExecutor.submit(() -> {
                    if (!isViewportCurrent(generation)) return;
                    sceneEngine.prepareViewportBatch();
                    if (!isViewportCurrent(generation)) return;
                    for (OnDeviceSceneEngine.ViewportTile tile : request.tiles) {
                        if (!isViewportCurrent(generation)) return;
                        try {
                            OnDeviceSceneEngine.ViewportTileBuildResult result = sceneEngine.buildViewportTile(tile);
                            if (!isViewportCurrent(generation)) return;
                            String url = APP_ORIGIN + "/viewport/" + result.file;
                            dispatchViewportJavascript(generation,
                                "window.SloiApp&&window.SloiApp.onViewportTileReady("
                                    + quoted(request.requestId) + "," + quoted(result.tileId) + ","
                                    + quoted(url) + ")"
                            );
                        } catch (Throwable error) {
                            if (!isViewportCurrent(generation)) return;
                            dispatchViewportJavascript(generation,
                                "window.SloiApp&&window.SloiApp.onViewportTileError("
                                    + quoted(request.requestId) + "," + quoted(tile.id()) + ","
                                    + quoted(viewportErrorCode(error)) + "," + quoted(messageOf(error)) + ")"
                            );
                        }
                    }
                    if (isViewportCurrent(generation)) {
                        dispatchViewportJavascript(generation,
                            "window.SloiApp&&window.SloiApp.onViewportBatchComplete("
                                + quoted(request.requestId) + ")"
                        );
                    }
                });
            }
        }

        @JavascriptInterface
        public void cancelViewportBuildings() {
            synchronized (taskLock) {
                viewportGeneration++;
                cancel(viewportFuture);
            }
        }

        @JavascriptInterface
        public void cancelShadowFrame() {
            synchronized (taskLock) {
                frameGeneration++;
                cancel(frameFuture);
            }
        }

        @JavascriptInterface
        public void requestShadowFrame(String sceneId, int frameIndex, String requestId) {
            final long generation;
            synchronized (taskLock) {
                generation = ++frameGeneration;
                cancel(frameFuture);
                frameFuture = engineExecutor.submit(() -> {
                    try {
                        OnDeviceSceneEngine.FrameBuildResult result = sceneEngine.buildFrame(
                            sceneId,
                            frameIndex,
                            null
                        );
                        String url = APP_ORIGIN + "/generated/" + result.file;
                        dispatchJavascriptIfCurrent(
                            () -> generation == frameGeneration,
                            "window.SloiApp&&window.SloiApp.onFrameReady(" +
                                quoted(result.sceneId) + "," + result.frameIndex + "," +
                                quoted(requestId) + "," + quoted(url) + ")"
                        );
                    } catch (Throwable error) {
                        dispatchJavascriptIfCurrent(
                            () -> generation == frameGeneration,
                            "window.SloiApp&&window.SloiApp.onFrameError(" +
                                quoted(sceneId) + "," + frameIndex + "," + quoted(requestId) + "," +
                                quoted(messageOf(error)) + ")"
                        );
                    }
                });
            }
        }

        @JavascriptInterface
        public void searchPlaces(String requestJson) {
            String parsedRequestId = "";
            final String requestId;
            final String query;
            final int limit;
            try {
                JSONObject request = new JSONObject(requestJson);
                parsedRequestId = request.optString("requestId", "");
                requestId = parsedRequestId;
                query = request.getString("query");
                limit = request.optInt("limit", 5);
            } catch (Exception error) {
                dispatchJavascript(
                    "window.SloiApp&&window.SloiApp.onPlacesError(" +
                        quoted(parsedRequestId) + "," + quoted(messageOf(error)) + ")"
                );
                return;
            }

            final long generation;
            synchronized (taskLock) {
                if (sceneFuture != null && !sceneFuture.isDone()) {
                    dispatchJavascript(
                        "window.SloiApp&&window.SloiApp.onPlacesError(" +
                            quoted(requestId) + "," + quoted("Дождитесь расчёта района") + ")"
                    );
                    return;
                }
                generation = ++searchGeneration;
                sceneEngine.cancelActiveRequests();
                cancel(searchFuture);
                searchFuture = engineExecutor.submit(() -> {
                    try {
                        String payload = sceneEngine.searchPlaces(query, limit);
                        synchronized (taskLock) {
                            if (generation != searchGeneration) return;
                        }
                        dispatchJavascript(
                            "window.SloiApp&&window.SloiApp.onPlacesReady(" +
                                quoted(requestId) + "," + quoted(payload) + ")"
                        );
                    } catch (Throwable error) {
                        synchronized (taskLock) {
                            if (generation != searchGeneration) return;
                        }
                        dispatchJavascript(
                            "window.SloiApp&&window.SloiApp.onPlacesError(" +
                                quoted(requestId) + "," + quoted(messageOf(error)) + ")"
                        );
                    }
                });
            }
        }
    }
}
