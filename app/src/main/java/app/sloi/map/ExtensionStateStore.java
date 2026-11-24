package app.sloi.map;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.nio.charset.StandardCharsets;

/** Bounded, durable state for bundled extensions; never an arbitrary preference bridge. */
public final class ExtensionStateStore {
    public static final String MODULES_KEY = "sloi-modules-state";
    public static final String PRESETS_KEY = "sloi-transport-presets";
    public static final int MODULES_MAX_BYTES = 512 * 1024;
    public static final int PRESETS_MAX_BYTES = 64 * 1024;

    public interface Backend {
        String read(String key);
        /** Returns true only after the value has been committed to disk. */
        boolean write(String key, String value);
    }

    private final Backend backend;

    public ExtensionStateStore(Backend backend) {
        if (backend == null) throw new IllegalArgumentException("Хранилище не задано");
        this.backend = backend;
    }

    public synchronized String read(String key) {
        try {
            limit(key);
            String value = backend.read(key);
            if (value == null) return null;
            validate(key, value);
            return value;
        } catch (RuntimeException error) { return null; }
    }

    public synchronized boolean write(String key, String value) {
        try {
            validate(key, value);
            return backend.write(key, value);
        } catch (RuntimeException error) { return false; }
    }

    private static int limit(String key) {
        if (MODULES_KEY.equals(key)) return MODULES_MAX_BYTES;
        if (PRESETS_KEY.equals(key)) return PRESETS_MAX_BYTES;
        throw new IllegalArgumentException("Неизвестное хранилище расширений");
    }

    /** Native bounds/structure check. Domain rules remain with each JS module. */
    public static void validate(String key, String value) {
        int maxBytes = limit(key);
        if (value == null || value.length() > maxBytes
                || value.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            throw new IllegalArgumentException("Превышен размер состояния расширений");
        }
        try {
            JSONTokener parser = new JSONTokener(value);
            Object parsed = parser.nextValue();
            if (!(parsed instanceof JSONObject) || parser.nextClean() != 0) throw new IllegalArgumentException();
            JSONObject root = (JSONObject) parsed;
            Object version = root.opt("version");
            if (!(version instanceof Number) || ((Number) version).doubleValue() != 1) throw new IllegalArgumentException();
            if (MODULES_KEY.equals(key)) validateModules(root);
            else validatePresets(root);
        } catch (Exception error) {
            throw new IllegalArgumentException("Повреждено состояние расширений", error);
        }
    }

    private static void validateModules(JSONObject root) {
        Object value = root.opt("modules");
        if (!(value instanceof JSONObject)) throw new IllegalArgumentException();
        JSONObject modules = (JSONObject) value;
        if (modules.length() > 128) throw new IllegalArgumentException();
        for (java.util.Iterator<String> ids = modules.keys(); ids.hasNext();) {
            String id = ids.next();
            if (!id.matches("[a-z][a-z0-9-]{0,47}")) throw new IllegalArgumentException();
            Object entry = modules.opt(id);
            if (!(entry instanceof JSONObject)) throw new IllegalArgumentException();
            JSONObject module = (JSONObject) entry;
            if (!(module.opt("enabled") instanceof Boolean) || !(module.opt("settings") instanceof JSONObject)) throw new IllegalArgumentException();
            JSONObject settings = (JSONObject) module.opt("settings");
            for (java.util.Iterator<String> names = settings.keys(); names.hasNext();) {
                String setting = names.next();
                Object item = settings.opt(setting);
                if (item != JSONObject.NULL && !(item instanceof String) && !(item instanceof Number) && !(item instanceof Boolean)) throw new IllegalArgumentException();
            }
        }
    }

    private static void validatePresets(JSONObject root) {
        Object value = root.opt("presets");
        if (!(value instanceof JSONArray) || ((JSONArray) value).length() > 20 || !root.has("activeId")) throw new IllegalArgumentException();
        Object active = root.opt("activeId");
        if (active != JSONObject.NULL && !(active instanceof String)) throw new IllegalArgumentException();
        JSONArray presets = (JSONArray) value;
        for (int index = 0; index < presets.length(); index++) {
            Object entry = presets.opt(index);
            if (!(entry instanceof JSONObject)) throw new IllegalArgumentException();
            JSONObject preset = (JSONObject) entry;
            if (!(preset.opt("id") instanceof String) || !(preset.opt("name") instanceof String)
                    || !(preset.opt("routes") instanceof JSONArray)) throw new IllegalArgumentException();
            int count = ((JSONArray) preset.opt("routes")).length();
            if (count < 1 || count > 20) throw new IllegalArgumentException();
        }
    }
}
