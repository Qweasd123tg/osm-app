package app.sloi.map;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
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
import java.io.FileInputStream;
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
    private static final int CITY_PACK_IMPORT_REQUEST = 1003;
    private static final int MAX_GEOJSON_BYTES = 2 * 1024 * 1024;

    private WebView webView;
    private ExtensionStateStore extensionStateStore;
    private OnDeviceSceneEngine sceneEngine;
    private CityPackStore cityPackStore;
    private OfflineBasemapStore offlineBasemapStore;
    private OfflinePlaceStore offlinePlaceStore;
    private ExecutorService engineExecutor;
    private ExecutorService packExecutor;
    private ExecutorService viewportExecutor;
    private ExecutorService importExecutor;
    private ExecutorService searchExecutor;
    private java.util.concurrent.ThreadPoolExecutor nearestPlaceExecutor;
    private final java.util.concurrent.ConcurrentHashMap<String, NearestPlaceRequest> nearestPlaceRequests = new java.util.concurrent.ConcurrentHashMap<>();
    private ExecutorService offlineBasemapExecutor;
    private PlaceSearchService placeSearch;
    private ExecutorService offlinePlaceExecutor;
    private Future<?> offlinePlaceFuture;
    private volatile long offlinePlaceGeneration;
    private volatile String offlinePlacePhase = "loading", offlinePlaceError;
    private volatile long offlinePlaceCurrent, offlinePlaceTotal;
    private long offlinePlaceProgressAt;
    private final Object taskLock = new Object();
    private Future<?> sceneFuture;
    private Future<?> frameFuture;
    private Future<?> searchFuture;
    private Future<?> packFuture;
    private Future<?> packCatalogFuture;
    private Future<?> viewportFuture;
    private Future<?> importFuture;
    private Future<?> offlineBasemapFuture;
    private long sceneGeneration;
    private long frameGeneration;
    private long searchGeneration;
    private long packGeneration;
    private long packCatalogGeneration;
    private long viewportGeneration;
    private long importGeneration;
    private long offlineBasemapGeneration;
    private String sceneRequestId;
    private boolean geoJsonChooserPending;
    private String cityPackChooserId;
    private long cityPackChooserGeneration;
    private volatile boolean destroyed;
    private Object backInvokedCallback;
    private GeolocationPermissions.Callback pendingLocationCallback;
    private String pendingLocationOrigin;
    private volatile boolean locationPermissionRequestInFlight;

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences extensionPreferences = getSharedPreferences("extension-state", MODE_PRIVATE);
        extensionStateStore = new ExtensionStateStore(new ExtensionStateStore.Backend() {
            @Override public String read(String key) { return extensionPreferences.getString(key, null); }
            @Override public boolean write(String key, String value) {
                // JavascriptInterface calls run off the UI thread. Report a
                // saved collection only after Android has committed the file.
                return extensionPreferences.edit().putString(key, value).commit();
            }
        });

        getWindow().setStatusBarColor(Color.rgb(246, 245, 240));
        getWindow().setNavigationBarColor(Color.rgb(246, 245, 240));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(235, 238, 235));
        // Android 15+ enforces edge-to-edge. Give WebView an actual usable
        // viewport above the system bars and IME instead of covering its forms.
        FrameLayout content = new FrameLayout(this);
        content.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(content);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets safe = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        content.requestApplyInsets();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backInvokedCallback = Api33Back.register(this, this::handleBackPressed);
        }

        File generatedDir = new File(getFilesDir(), "generated-scenes");
        File viewportDir = new File(getFilesDir(), "viewport-tiles");
        cityPackStore = new CityPackStore(getFilesDir());
        offlineBasemapStore = new OfflineBasemapStore(getFilesDir());
        offlinePlaceStore = new OfflinePlaceStore(getFilesDir());
        placeSearch = new PlaceSearchService(offlinePlaceStore::search, this::isSearchNetworkAvailable);
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
        searchExecutor = PlaceSearchService.newSearchExecutor();
        nearestPlaceExecutor = new java.util.concurrent.ThreadPoolExecutor(2, 2, 15,
            java.util.concurrent.TimeUnit.SECONDS, new java.util.concurrent.ArrayBlockingQueue<>(4), runnable -> {
                Thread thread = new Thread(runnable, "sloi-nearest-place");
                thread.setPriority(Thread.NORM_PRIORITY - 1);
                return thread;
            }, new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
        nearestPlaceExecutor.allowCoreThreadTimeOut(true);
        offlinePlaceExecutor = new java.util.concurrent.ThreadPoolExecutor(1, 1, 0,
            java.util.concurrent.TimeUnit.SECONDS, new java.util.concurrent.ArrayBlockingQueue<>(1), runnable -> {
                Thread thread = new Thread(runnable, "sloi-address-index");
                thread.setPriority(Thread.NORM_PRIORITY - 1);
                return thread;
            }, new java.util.concurrent.ThreadPoolExecutor.DiscardOldestPolicy());
        offlineBasemapExecutor = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "sloi-offline-basemap"));
        WebViewAssetLoader.InternalStoragePathHandler basemapFiles =
            new WebViewAssetLoader.InternalStoragePathHandler(this, offlineBasemapStore.directory());
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
            .addPathHandler(
                "/basemap/",
                path -> {
                    WebResourceResponse response = basemapFiles.handle(path);
                    if (response != null && path.endsWith(".pbf")) {
                        response.setMimeType("application/x-protobuf");
                        response.setEncoding(null);
                    }
                    return response;
                }
            )
            .build();

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString()
            + " Sloi/" + BuildConfig.VERSION_NAME + " (+https://github.com/Qweasd123tg/osm-app)");
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
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
                if (destroyed || !LocationAccessPolicy.isAppOrigin(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                boolean precise = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                // Users of older APKs may only have COARSE. Offer the new precise
                // choice once, then honour an approximate choice on later requests.
                boolean preciseChoiceOffered = getPreferences(MODE_PRIVATE)
                    .getBoolean("location-precise-choice-offered", false);
                if (precise || (hasLocationPermission() && preciseChoiceOffered)) {
                    callback.invoke(origin, true, false);
                    return;
                }

                clearPendingLocationRequest(false);
                pendingLocationOrigin = origin;
                pendingLocationCallback = callback;
                if (locationPermissionRequestInFlight) return;
                locationPermissionRequestInFlight = true;
                getPreferences(MODE_PRIVATE).edit()
                    .putBoolean("location-permission-requested", true)
                    .putBoolean("location-precise-choice-offered", true).apply();
                // Request both together so Android 12+ can offer Precise / Approximate.
                requestPermissions(new String[] {
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                }, LOCATION_PERMISSION_REQUEST);
            }

            @Override
            public void onGeolocationPermissionsHidePrompt() {
                // The page can cancel its position request while the OS dialog is open.
                // Keep the in-flight guard until its permission result arrives.
                clearPendingLocationRequest(false);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                WebView view,
                WebResourceRequest request
            ) {
                File font = offlineBasemapStore.cachedFont(request.getUrl().toString());
                if (font != null) {
                    try {
                        WebResourceResponse cached = new WebResourceResponse("application/x-protobuf", null, new FileInputStream(font));
                        cached.setResponseHeaders(java.util.Collections.singletonMap("Access-Control-Allow-Origin", APP_ORIGIN));
                        return cached;
                    } catch (java.io.IOException error) { Log.w(TAG, "Cached basemap font unavailable", error); }
                }
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
        onCityDataChangedForSearch();
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
        locationPermissionRequestInFlight = false;
        boolean granted = hasLocationPermission() || LocationAccessPolicy.grantedResult(
            permissions, grantResults, PackageManager.PERMISSION_GRANTED);
        clearPendingLocationRequest(!destroyed && granted);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == CITY_PACK_IMPORT_REQUEST) {
            onCityPackImportResult(resultCode, data);
            return;
        }
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

    private void onCityPackImportResult(int resultCode, Intent data) {
        final String id;
        final long generation;
        synchronized (taskLock) {
            id = cityPackChooserId; generation = cityPackChooserGeneration;
            cityPackChooserId = null;
            if (destroyed || id == null || generation != packGeneration) return;
        }
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            dispatchJavascriptIfCurrent(() -> generation == packGeneration,
                "window.SloiApp&&window.SloiApp.onCityPackChanged(" + quoted(cityPackStore.listPacksJson(false)) + ")");
            return;
        }
        final Uri uri = data.getData();
        if (!"content".equals(uri.getScheme())) {
            dispatchJavascriptIfCurrent(() -> generation == packGeneration,
                "window.SloiApp&&window.SloiApp.onCityPackError(" + quoted(id) + ","
                    + quoted("Выберите ZIP или GeoPackage через системный диалог") + ")");
            return;
        }
        synchronized (taskLock) {
            if (destroyed || generation != packGeneration) return;
            cancel(packFuture);
            packFuture = packExecutor.submit(() -> importCityPack(uri, id, generation));
        }
    }

    private void importCityPack(Uri uri, String id, long generation) {
        try {
            String name = "city-package"; long size = -1;
            try (Cursor cursor = getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn);
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn);
                }
            }
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                cityPackStore.importPackage(id, input, name, size, (phase, current, total) ->
                    dispatchJavascriptIfCurrent(() -> generation == packGeneration,
                        "window.SloiApp&&window.SloiApp.onCityPackProgress(" + quoted(id) + "," + quoted(phase)
                            + "," + current + "," + total + ")"));
            }
            onCityDataChangedForSearch();
            if (!invalidateViewportForPack(generation)) return;
            dispatchJavascriptIfCurrent(() -> generation == packGeneration,
                "window.SloiApp&&window.SloiApp.onCityPackChanged(" + quoted(cityPackStore.listPacksJson(false)) + ")");
        } catch (Throwable error) {
            Log.w(TAG, "City package import failed", error);
            dispatchJavascriptIfCurrent(() -> generation == packGeneration,
                "window.SloiApp&&window.SloiApp.onCityPackError(" + quoted(id) + "," + quoted(messageOf(error)) + ")");
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
        cityPackStore.close();
        placeSearch.close();
        offlinePlaceStore.close();
        offlineBasemapStore.cancel();
        synchronized (taskLock) {
            importGeneration++;
            geoJsonChooserPending = false;
            cityPackChooserId = null;
            cancel(sceneFuture);
            cancel(frameFuture);
            cancel(searchFuture);
            cancel(packFuture);
            cancel(packCatalogFuture);
            cancel(viewportFuture);
            cancel(importFuture);
            offlineBasemapGeneration++;
            cancel(offlineBasemapFuture);
            offlinePlaceGeneration++;
            cancel(offlinePlaceFuture);
        }
        engineExecutor.shutdownNow();
        packExecutor.shutdownNow();
        viewportExecutor.shutdownNow();
        importExecutor.shutdownNow();
        searchExecutor.shutdownNow();
        for (NearestPlaceRequest request : nearestPlaceRequests.values()) cancel(request.future);
        nearestPlaceRequests.clear();
        nearestPlaceExecutor.shutdownNow();
        offlineBasemapExecutor.shutdownNow();
        offlinePlaceExecutor.shutdownNow();
        sceneEngine.clearMemory();
        webView.removeJavascriptInterface("AndroidHost");
        webView.destroy();
        super.onDestroy();
    }

    private void clearPendingLocationRequest(boolean allowed) {
        GeolocationPermissions.Callback callback = pendingLocationCallback;
        String origin = pendingLocationOrigin;
        pendingLocationCallback = null;
        pendingLocationOrigin = null;
        if (callback != null && origin != null) callback.invoke(origin, allowed, false);
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean locationEnabled() {
        LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return manager.isLocationEnabled();
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
            || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    private void openLocationSettingsIntent(Intent intent) {
        runOnUiThread(() -> {
            if (destroyed || webView == null) return;
            Uri page = Uri.parse(webView.getUrl() == null ? "" : webView.getUrl());
            if (!"https".equals(page.getScheme()) || !APP_HOST.equals(page.getHost())
                || (page.getPort() != -1 && page.getPort() != 443)
                || page.getUserInfo() != null || !"/assets/index.html".equals(page.getPath())) return;
            try { startActivity(intent); }
            catch (ActivityNotFoundException error) { Log.w(TAG, "Location settings unavailable", error); }
        });
    }

    private static void cancel(Future<?> future) {
        if (future != null) {
            future.cancel(true);
        }
    }

    private static final class NearestPlaceRequest {
        volatile Future<?> future;
    }

    private void cancelNearestPlace(String requestId) {
        NearestPlaceRequest request = nearestPlaceRequests.remove(requestId);
        if (request == null) return;
        cancel(request.future);
        if (request.future instanceof Runnable) nearestPlaceExecutor.remove((Runnable) request.future);
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
            if (current instanceof java.net.SocketTimeoutException) {
                return "Передача данных остановилась. Проверьте соединение или маршрут VPN и повторите попытку.";
            }
            if (current instanceof java.net.UnknownHostException) {
                return "Не удалось найти сервер. Проверьте подключение к сети.";
            }
            String currentMessage = current.getMessage();
            if (message == null && currentMessage != null && !currentMessage.trim().isEmpty()) {
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

    private boolean isSearchNetworkAvailable() {
        try {
            android.net.ConnectivityManager manager = getSystemService(android.net.ConnectivityManager.class);
            android.net.Network network = manager == null ? null : manager.getActiveNetwork();
            android.net.NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
            return capabilities != null && capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (RuntimeException error) { return true; }
    }

    private JSONObject offlinePlacesState() {
        JSONObject state = offlinePlaceStore.statusJson();
        try {
            state.put("phase", offlinePlacePhase).put("current", offlinePlaceCurrent).put("total", offlinePlaceTotal);
            if (offlinePlaceError != null) state.put("error", offlinePlaceError);
            return state;
        } catch (org.json.JSONException error) { throw new IllegalStateException(error); }
    }

    private void dispatchOfflinePlacesState(long generation, boolean force) {
        if (destroyed || generation != offlinePlaceGeneration) return;
        long now = System.nanoTime();
        if (!force && now - offlinePlaceProgressAt < 150_000_000L) return;
        offlinePlaceProgressAt = now;
        dispatchJavascriptIfCurrent(() -> generation == offlinePlaceGeneration,
            "window.SloiApp&&window.SloiApp.onOfflinePlacesState&&window.SloiApp.onOfflinePlacesState(" + offlinePlacesState() + ")");
    }

    /** Derived address data never changes the source GeoPackage or its viewport revision. */
    private void onCityDataChangedForSearch() {
        synchronized (taskLock) {
            if (destroyed) return;
            long generation = ++offlinePlaceGeneration;
            offlinePlaceStore.cancel();
            cancel(offlinePlaceFuture);
            offlinePlaceFuture = offlinePlaceExecutor.submit(() -> {
                try {
                    java.util.List<OfflinePlaceStore.Source> sources = cityPackStore.installedSearchSources();
                    offlinePlaceStore.retainSources(sources);
                    if (generation != offlinePlaceGeneration || destroyed) return;
                    offlinePlacePhase = "indexing"; offlinePlaceError = null;
                    offlinePlaceCurrent = 0; offlinePlaceTotal = 0;
                    dispatchOfflinePlacesState(generation, true);
                    for (OfflinePlaceStore.Source source : sources) offlinePlaceStore.ensureIndex(source, (phase, current, total) -> {
                        if (generation != offlinePlaceGeneration || destroyed) return;
                        offlinePlaceCurrent = current; offlinePlaceTotal = total;
                        dispatchOfflinePlacesState(generation, false);
                    });
                    if (generation != offlinePlaceGeneration || destroyed) return;
                    offlinePlacePhase = "ready";
                    dispatchOfflinePlacesState(generation, true);
                } catch (Throwable error) {
                    if (generation != offlinePlaceGeneration || destroyed) return;
                    offlinePlacePhase = "error"; offlinePlaceError = messageOf(error);
                    Log.w(TAG, "Offline address preparation failed", error);
                    dispatchOfflinePlacesState(generation, true);
                }
            });
        }
    }

    public final class AndroidBridge {
        @JavascriptInterface
        public String readExtensionState(String key) {
            return destroyed ? null : extensionStateStore.read(key);
        }

        @JavascriptInterface
        public boolean writeExtensionState(String key, String json) {
            return !destroyed && extensionStateStore.write(key, json);
        }

        @JavascriptInterface
        public void listOfflinePlaces() {
            dispatchJavascript("window.SloiApp&&window.SloiApp.onOfflinePlacesState&&window.SloiApp.onOfflinePlacesState(" + offlinePlacesState() + ")");
        }

        @JavascriptInterface
        public String getOfflinePlacesState() { return offlinePlacesState().toString(); }

        @JavascriptInterface
        public void prepareOfflinePlaces() { onCityDataChangedForSearch(); }
        @JavascriptInterface
        public String getOfflineBasemap() {
            JSONObject record = offlineBasemapStore.record();
            return record == null ? "null" : record.toString();
        }

        @JavascriptInterface
        public void listOfflineBasemap() {
            JSONObject record = offlineBasemapStore.record();
            dispatchJavascript("window.SloiApp&&window.SloiApp.onOfflineBasemap(" + (record == null ? "null" : record.toString()) + ")");
        }

        @JavascriptInterface
        public void downloadOfflineBasemap(String requestJson) {
            final OfflineBasemapStore.Request request;
            try { request = OfflineBasemapStore.Request.parse(requestJson); }
            catch (Throwable error) {
                dispatchJavascript("window.SloiApp&&window.SloiApp.onOfflineBasemapError(\"\"," + quoted(messageOf(error)) + ")");
                return;
            }
            synchronized (taskLock) {
                if (destroyed) return;
                long generation = ++offlineBasemapGeneration;
                offlineBasemapStore.cancel();
                cancel(offlineBasemapFuture);
                offlineBasemapFuture = offlineBasemapExecutor.submit(() -> {
                    try {
                        JSONObject record = offlineBasemapStore.download(request, (phase, current, total) ->
                            dispatchJavascriptIfCurrent(() -> generation == offlineBasemapGeneration,
                                "window.SloiApp&&window.SloiApp.onOfflineBasemapProgress(" + quoted(request.requestId) + ","
                                    + quoted(phase) + "," + current + "," + total + ")"));
                        dispatchJavascriptIfCurrent(() -> generation == offlineBasemapGeneration,
                            "window.SloiApp&&window.SloiApp.onOfflineBasemapChanged(" + record.toString() + ")");
                    } catch (Throwable error) {
                        Log.w(TAG, "Offline basemap download failed", error);
                        dispatchJavascriptIfCurrent(() -> generation == offlineBasemapGeneration,
                            "window.SloiApp&&window.SloiApp.onOfflineBasemapError(" + quoted(request.requestId) + ","
                                + quoted(messageOf(error)) + ")");
                    }
                });
            }
        }

        @JavascriptInterface
        public void cancelOfflineBasemap() {
            synchronized (taskLock) {
                if (destroyed) return;
                long generation = ++offlineBasemapGeneration;
                offlineBasemapStore.cancel();
                cancel(offlineBasemapFuture);
                offlineBasemapFuture = offlineBasemapExecutor.submit(() -> {
                    JSONObject record = offlineBasemapStore.record();
                    dispatchJavascriptIfCurrent(() -> generation == offlineBasemapGeneration,
                        "window.SloiApp&&window.SloiApp.onOfflineBasemapChanged(" + (record == null ? "null" : record.toString()) + ")");
                });
            }
        }

        @JavascriptInterface
        public void deleteOfflineBasemap() {
            synchronized (taskLock) {
                if (destroyed) return;
                long generation = ++offlineBasemapGeneration;
                offlineBasemapStore.cancel();
                cancel(offlineBasemapFuture);
                offlineBasemapFuture = offlineBasemapExecutor.submit(() -> {
                    try {
                        offlineBasemapStore.delete();
                        dispatchJavascriptIfCurrent(() -> generation == offlineBasemapGeneration,
                            "window.SloiApp&&window.SloiApp.onOfflineBasemapChanged(null)");
                    } catch (Throwable error) {
                        dispatchJavascriptIfCurrent(() -> generation == offlineBasemapGeneration,
                            "window.SloiApp&&window.SloiApp.onOfflineBasemapError(\"\"," + quoted(messageOf(error)) + ")");
                    }
                });
            }
        }

        @JavascriptInterface
        public String getLocationState() {
            boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            boolean coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            boolean requested = getPreferences(MODE_PRIVATE).getBoolean("location-permission-requested", false);
            boolean rationale = shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)
                || shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_COARSE_LOCATION);
            JSONObject state = new JSONObject();
            try {
                state.put("permission", LocationAccessPolicy.permissionState(fine, coarse, requested, rationale));
                state.put("enabled", locationEnabled());
                state.put("requestPending", locationPermissionRequestInFlight);
            } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
            return state.toString();
        }

        @JavascriptInterface
        public void openLocationSettings() {
            openLocationSettingsIntent(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
        }

        @JavascriptInterface
        public void openAppSettings() {
            openLocationSettingsIntent(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName())));
        }

        @JavascriptInterface
        public boolean isDarkTheme() {
            return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        }

        @JavascriptInterface
        public void setSystemBarTheme(boolean dark) {
            runOnUiThread(() -> {
                if (destroyed) return;
                int color = dark ? Color.rgb(36, 39, 45) : Color.WHITE;
                getWindow().setStatusBarColor(color);
                getWindow().setNavigationBarColor(color);
                View decor = getWindow().getDecorView();
                int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                decor.setSystemUiVisibility(dark ? decor.getSystemUiVisibility() & ~lightFlags
                    : decor.getSystemUiVisibility() | lightFlags);
                webView.setBackgroundColor(color);
                if (webView.getParent() instanceof View) ((View) webView.getParent()).setBackgroundColor(color);
            });
        }

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
        public void importCityPack(String id) {
            try { CityPackStore.requireId(id); }
            catch (IllegalArgumentException error) {
                dispatchJavascript("window.SloiApp&&window.SloiApp.onCityPackError(" + quoted(id) + "," + quoted(messageOf(error)) + ")");
                return;
            }
            final long generation;
            synchronized (taskLock) {
                if (destroyed || cityPackChooserId != null) return;
                invalidatePackCatalogLocked();
                generation = ++packGeneration;
                cityPackStore.cancelActiveRequests();
                cancel(packFuture);
                cityPackChooserId = id;
                cityPackChooserGeneration = generation;
            }
            runOnUiThread(() -> {
                synchronized (taskLock) {
                    if (destroyed || generation != packGeneration || !id.equals(cityPackChooserId)) return;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/zip", "application/x-zip-compressed", "application/geopackage+sqlite3",
                        "application/vnd.sqlite3", "application/x-sqlite3", "application/octet-stream",
                    });
                    intent.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(intent, CITY_PACK_IMPORT_REQUEST);
                } catch (ActivityNotFoundException | SecurityException error) {
                    synchronized (taskLock) { if (generation == packGeneration) cityPackChooserId = null; }
                    dispatchJavascriptIfCurrent(() -> generation == packGeneration,
                        "window.SloiApp&&window.SloiApp.onCityPackError(" + quoted(id) + ","
                            + quoted("Не удалось открыть системный выбор файла") + ")");
                }
            });
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
                        onCityDataChangedForSearch();
                        if (!invalidateViewportForPack(generation)) return;
                        dispatchJavascriptIfCurrent(
                            () -> generation == packGeneration,
                            "window.SloiApp&&window.SloiApp.onCityPackChanged(" +
                                quoted(cityPackStore.listPacksJson(false)) + ")"
                        );
                    } catch (Throwable error) {
                        Log.w(TAG, "City pack installation failed", error);
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
                        onCityDataChangedForSearch();
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
                sceneEngine.cancelActiveRequests();
                cancel(sceneFuture);
                cancel(frameFuture);
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

        /** Each endpoint owns its request; picking B must not cancel the name of A. */
        @JavascriptInterface
        public void reversePlaceLookup(String requestJson) {
            String parsedId = "";
            try {
                if (destroyed) return;
                JSONObject value = new JSONObject(requestJson);
                parsedId = value.getString("requestId");
                if (!parsedId.matches("[a-zA-Z0-9_-]{1,80}")) throw new IllegalArgumentException("Invalid lookup request");
                final String requestId = parsedId;
                final double latitude = value.getDouble("latitude"), longitude = value.getDouble("longitude");
                OfflinePlaceStore.validatePoint(latitude, longitude);
                cancelNearestPlace(requestId);
                NearestPlaceRequest request = new NearestPlaceRequest();
                java.util.concurrent.FutureTask<Void> task = new java.util.concurrent.FutureTask<>(() -> {
                    JSONObject result = null;
                    try { result = offlinePlaceStore.nearest(latitude, longitude); }
                    catch (Exception error) { Log.d(TAG, "Nearest offline label unavailable", error); }
                    String payload = result == null ? "null" : result.toString();
                    dispatchJavascriptIfCurrent(() -> nearestPlaceRequests.remove(requestId, request),
                        "window.SloiPlaceNames&&window.SloiPlaceNames.onNativeResult(" + quoted(requestId) + "," + payload + ")");
                    return null;
                });
                request.future = task;
                nearestPlaceRequests.put(requestId, request);
                try { nearestPlaceExecutor.execute(task); }
                catch (java.util.concurrent.RejectedExecutionException busy) {
                    nearestPlaceRequests.remove(requestId, request);
                    dispatchJavascript("window.SloiPlaceNames&&window.SloiPlaceNames.onNativeResult(" + quoted(requestId) + ",null)");
                }
            } catch (Exception error) {
                dispatchJavascript("window.SloiPlaceNames&&window.SloiPlaceNames.onNativeResult(" + quoted(parsedId) + ",null)");
            }
        }

        @JavascriptInterface
        public void cancelPlaceNameLookup(String requestId) { cancelNearestPlace(requestId); }

        @JavascriptInterface
        public void searchPlaces(String requestJson) {
            String parsedRequestId = "";
            final String requestId;
            final String query;
            final int limit;
            final double latitude, longitude, zoom;
            try {
                JSONObject request = new JSONObject(requestJson);
                parsedRequestId = request.optString("requestId", "");
                requestId = parsedRequestId;
                query = request.getString("query");
                limit = request.optInt("limit", 5);
                latitude = request.optDouble("latitude", Double.NaN);
                longitude = request.optDouble("longitude", Double.NaN);
                zoom = request.optDouble("zoom", 12);
            } catch (Exception error) {
                dispatchJavascript(
                    "window.SloiApp&&window.SloiApp.onPlacesError(" +
                        quoted(parsedRequestId) + "," + quoted(messageOf(error)) + ")"
                );
                return;
            }

            final long generation;
            synchronized (taskLock) {
                if (destroyed) return;
                generation = ++searchGeneration;
                placeSearch.cancel();
                cancel(searchFuture);
                searchFuture = searchExecutor.submit(() -> {
                    try {
                        String payload = placeSearch.search(query, limit, latitude, longitude, zoom);
                        dispatchJavascriptIfCurrent(() -> generation == searchGeneration,
                            "window.SloiApp&&window.SloiApp.onPlacesReady(" +
                                quoted(requestId) + "," + quoted(payload) + ")"
                        );
                    } catch (Throwable error) {
                        dispatchJavascriptIfCurrent(() -> generation == searchGeneration,
                            "window.SloiApp&&window.SloiApp.onPlacesError(" +
                                quoted(requestId) + "," + quoted(messageOf(error)) + ")"
                        );
                    }
                });
            }
        }

        @JavascriptInterface
        public void cancelPlaceSearch() {
            synchronized (taskLock) {
                if (destroyed) return;
                searchGeneration++;
                placeSearch.cancel();
                cancel(searchFuture);
            }
        }
    }
}
