package app.sloi.map;

import org.junit.Test;
import java.util.HashMap;
import java.util.Map;
import static org.junit.Assert.*;

public final class ExtensionStateStoreTest {
    private static final String MODULES = "{\"version\":1,\"modules\":{\"spb-live\":{\"enabled\":true,\"settings\":{\"routes\":\"[]\",\"bus\":false,\"opacity\":0.8,\"extra\":null}}}}";
    private static final String PRESETS = "{\"version\":1,\"presets\":[{\"id\":\"commute\",\"name\":\"На работу\",\"routes\":[{\"type\":\"bus\",\"number\":\"49\",\"color\":\"#123456\"}]}],\"activeId\":\"commute\"}";

    private static final class Memory implements ExtensionStateStore.Backend {
        final Map<String, String> values = new HashMap<>();
        int reads, writes;
        boolean commit = true, fail;
        @Override public String read(String key) {
            reads++;
            if (fail) throw new IllegalStateException("unavailable");
            return values.get(key);
        }
        @Override public boolean write(String key, String value) {
            writes++;
            if (fail) throw new IllegalStateException("unavailable");
            if (!commit) return false;
            values.put(key, value);
            return true;
        }
    }

    @Test public void committedStateSurvivesStoreRecreationForBothAllowedKeys() {
        Memory memory = new Memory();
        ExtensionStateStore store = new ExtensionStateStore(memory);
        assertNull(store.read(ExtensionStateStore.MODULES_KEY));
        assertTrue(store.write(ExtensionStateStore.MODULES_KEY, MODULES));
        assertTrue(store.write(ExtensionStateStore.PRESETS_KEY, PRESETS));
        ExtensionStateStore reopened = new ExtensionStateStore(memory);
        assertEquals(MODULES, reopened.read(ExtensionStateStore.MODULES_KEY));
        assertEquals(PRESETS, reopened.read(ExtensionStateStore.PRESETS_KEY));
    }

    @Test public void uncommittedOrFailedWritesAreReportedAndNeverReplaceCommittedState() {
        Memory memory = new Memory();
        ExtensionStateStore store = new ExtensionStateStore(memory);
        assertTrue(store.write(ExtensionStateStore.PRESETS_KEY, PRESETS));
        memory.commit = false;
        assertFalse(store.write(ExtensionStateStore.PRESETS_KEY, "{\"version\":1,\"presets\":[],\"activeId\":null}"));
        assertEquals(PRESETS, store.read(ExtensionStateStore.PRESETS_KEY));
        memory.fail = true;
        assertFalse(store.write(ExtensionStateStore.PRESETS_KEY, PRESETS));
        assertNull(store.read(ExtensionStateStore.PRESETS_KEY));
    }

    @Test public void arbitraryPreferenceKeysAreRejectedBeforeBackendAccess() {
        Memory memory = new Memory();
        ExtensionStateStore store = new ExtensionStateStore(memory);
        for (String key : new String[] {null, "", "theme", "../sloi-modules-state", "SLOI-MODULES-STATE"}) {
            assertFalse(store.write(key, MODULES));
            assertNull(store.read(key));
        }
        assertEquals(0, memory.reads);
        assertEquals(0, memory.writes);
    }

    @Test public void malformedJsonWrongVersionAndTrailingValueCannotReachDisk() {
        Memory memory = new Memory();
        ExtensionStateStore store = new ExtensionStateStore(memory);
        for (String text : new String[] {null, "", "[]", "null", "{broken", "{\"version\":2,\"modules\":{}}",
                "{\"version\":\"1\",\"modules\":{}}", "{\"version\":1,\"modules\":{}} false"}) {
            assertFalse("Invalid document: " + text, store.write(ExtensionStateStore.MODULES_KEY, text));
        }
        assertEquals(0, memory.writes);
    }

    @Test public void corruptBackingDataIsNotExposedToJavascript() {
        Memory memory = new Memory();
        memory.values.put(ExtensionStateStore.PRESETS_KEY, "{\"version\":1,\"presets\":[]}");
        assertNull(new ExtensionStateStore(memory).read(ExtensionStateStore.PRESETS_KEY));
        assertEquals(0, memory.writes);
    }

    @Test public void utf8LimitsAreEnforcedAtTheActualByteBoundary() {
        Memory memory = new Memory();
        ExtensionStateStore store = new ExtensionStateStore(memory);
        String base = "{\"version\":1,\"presets\":[],\"activeId\":null}";
        String exact = base + repeat(" ", ExtensionStateStore.PRESETS_MAX_BYTES - base.length());
        assertTrue(store.write(ExtensionStateStore.PRESETS_KEY, exact));
        assertFalse(store.write(ExtensionStateStore.PRESETS_KEY, exact + " "));
        String multibyte = "{\"version\":1,\"presets\":[],\"activeId\":null,\"padding\":\"" + repeat("я", 33000) + "\"}";
        assertTrue(multibyte.length() < ExtensionStateStore.PRESETS_MAX_BYTES);
        assertFalse(store.write(ExtensionStateStore.PRESETS_KEY, multibyte));
        String modules = "{\"version\":1,\"modules\":{}}";
        String large = modules + repeat(" ", ExtensionStateStore.MODULES_MAX_BYTES - modules.length());
        assertTrue(store.write(ExtensionStateStore.MODULES_KEY, large));
        assertFalse(store.write(ExtensionStateStore.MODULES_KEY, large + " "));
    }

    @Test public void moduleStateRequiresTypedEnableFlagAndPrimitiveSettings() {
        Memory memory = new Memory();
        ExtensionStateStore store = new ExtensionStateStore(memory);
        for (String text : new String[] {"{\"version\":1,\"modules\":[]}",
                "{\"version\":1,\"modules\":{\"bad/path\":{\"enabled\":true,\"settings\":{}}}}",
                "{\"version\":1,\"modules\":{\"spb-live\":{\"enabled\":\"true\",\"settings\":{}}}}",
                "{\"version\":1,\"modules\":{\"spb-live\":{\"enabled\":true,\"settings\":{\"routes\":[]}}}}"}) {
            assertFalse(store.write(ExtensionStateStore.MODULES_KEY, text));
        }
        assertTrue(store.write(ExtensionStateStore.MODULES_KEY, "{\"version\":1,\"modules\":{}}"));
    }

    @Test public void presetStateIsStructurallyBoundedBeforeDomainValidation() {
        Memory memory = new Memory();
        ExtensionStateStore store = new ExtensionStateStore(memory);
        for (String text : new String[] {"{\"version\":1,\"presets\":{},\"activeId\":null}",
                "{\"version\":1,\"presets\":[],\"activeId\":42}",
                "{\"version\":1,\"presets\":[{\"id\":\"a\",\"name\":\"a\",\"routes\":[]}],\"activeId\":null}"}) {
            assertFalse(store.write(ExtensionStateStore.PRESETS_KEY, text));
        }
        String item = "{\"id\":\"a\",\"name\":\"a\",\"routes\":[{}]}";
        String tooMany = "{\"version\":1,\"presets\":[" + item + repeat("," + item, 20) + "],\"activeId\":null}";
        assertFalse(store.write(ExtensionStateStore.PRESETS_KEY, tooMany));
        assertTrue(store.write(ExtensionStateStore.PRESETS_KEY, "{\"version\":1,\"presets\":[],\"activeId\":null}"));
    }

    private static String repeat(String value, int count) {
        StringBuilder result = new StringBuilder(value.length() * count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
