package app.sloi.map;

import java.net.URI;

/** Permission decisions shared by the Android/WebView boundary. */
final class LocationAccessPolicy {
    static final String FINE = "android.permission.ACCESS_FINE_LOCATION";
    static final String COARSE = "android.permission.ACCESS_COARSE_LOCATION";

    static boolean isAppOrigin(String value) {
        if (value == null) return false;
        try {
            URI origin = new URI(value);
            String path = origin.getRawPath();
            return "https".equalsIgnoreCase(origin.getScheme())
                && "appassets.androidplatform.net".equalsIgnoreCase(origin.getHost())
                && (origin.getPort() == -1 || origin.getPort() == 443)
                && origin.getRawUserInfo() == null
                && origin.getRawQuery() == null && origin.getRawFragment() == null
                && (path == null || path.isEmpty() || "/".equals(path));
        } catch (Exception invalid) {
            return false;
        }
    }

    static boolean grantedResult(String[] permissions, int[] results, int grantedValue) {
        if (permissions == null || results == null) return false;
        for (int index = 0; index < Math.min(permissions.length, results.length); index++) {
            if ((FINE.equals(permissions[index]) || COARSE.equals(permissions[index]))
                && results[index] == grantedValue) return true;
        }
        return false;
    }

    static String permissionState(boolean fine, boolean coarse, boolean requested, boolean rationale) {
        if (fine) return "precise";
        if (coarse) return "approximate";
        return requested && !rationale ? "blocked" : "denied";
    }

    private LocationAccessPolicy() {}
}
