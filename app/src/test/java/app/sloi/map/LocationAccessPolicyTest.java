package app.sloi.map;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class LocationAccessPolicyTest {
    @Test public void localOriginAllowsWebViewTrailingSlashAndDefaultHttpsPort() {
        assertTrue(LocationAccessPolicy.isAppOrigin("https://appassets.androidplatform.net"));
        assertTrue(LocationAccessPolicy.isAppOrigin("https://appassets.androidplatform.net/"));
        assertTrue(LocationAccessPolicy.isAppOrigin("https://appassets.androidplatform.net:443/"));
        for (String origin : new String[] {null, "", "http://appassets.androidplatform.net",
                "https://appassets.androidplatform.net:444", "https://appassets.androidplatform.net.evil.test/",
                "https://evil.test@appassets.androidplatform.net/", "https://appassets.androidplatform.net/assets/index.html",
                "https://appassets.androidplatform.net/?query", "https://appassets.androidplatform.net/#fragment",
                "https://appassets.androidplatform.net/%2f", "not a url"}) {
            assertFalse("Untrusted origin: " + origin, LocationAccessPolicy.isAppOrigin(origin));
        }
    }

    @Test public void approximateOnlyGrantWorksRegardlessOfResultOrder() {
        assertTrue(LocationAccessPolicy.grantedResult(new String[] {LocationAccessPolicy.FINE, LocationAccessPolicy.COARSE},
            new int[] {-1, 0}, 0));
        assertTrue(LocationAccessPolicy.grantedResult(new String[] {LocationAccessPolicy.COARSE, LocationAccessPolicy.FINE},
            new int[] {0, -1}, 0));
        assertTrue(LocationAccessPolicy.grantedResult(new String[] {LocationAccessPolicy.FINE}, new int[] {0}, 0));
        assertFalse(LocationAccessPolicy.grantedResult(new String[] {LocationAccessPolicy.FINE, LocationAccessPolicy.COARSE},
            new int[] {-1, -1}, 0));
        assertFalse(LocationAccessPolicy.grantedResult(new String[] {"android.permission.CAMERA"}, new int[] {0}, 0));
        assertFalse(LocationAccessPolicy.grantedResult(new String[] {LocationAccessPolicy.FINE}, new int[0], 0));
        assertFalse(LocationAccessPolicy.grantedResult(null, null, 0));
    }

    @Test public void deniedAndBlockedAreDistinctWithoutRejectingApproximateChoice() {
        assertEquals("denied", LocationAccessPolicy.permissionState(false, false, false, false));
        assertEquals("denied", LocationAccessPolicy.permissionState(false, false, true, true));
        assertEquals("blocked", LocationAccessPolicy.permissionState(false, false, true, false));
        assertEquals("approximate", LocationAccessPolicy.permissionState(false, true, true, false));
        assertEquals("precise", LocationAccessPolicy.permissionState(true, true, true, false));
    }
}
