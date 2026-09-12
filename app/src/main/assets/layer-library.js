(function (root) {
  "use strict";

  const databaseName = "sloi-layer-library";
  const storeName = "layers";
  const databaseVersion = 1;
  const maxEntries = 5;
  const maxEntryBytes = 2 * 1024 * 1024;
  const maxTotalBytes = 8 * 1024 * 1024;
  const customIdPattern = /^custom-[a-z0-9-]{1,60}$/;
  const colorPattern = /^#[0-9a-fA-F]{6}$/;

  function utf8Size(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < value.length
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function jsonClone(value) {
    let source;
    try {
      source = JSON.stringify(value);
    } catch (_error) {
      throw new Error("GeoJSON должен содержать только обычные JSON-данные");
    }
    if (typeof source !== "string") {
      throw new Error("GeoJSON отсутствует или имеет неверный формат");
    }
    if (utf8Size(source) > maxEntryBytes) {
      throw new Error("GeoJSON превышает допустимый размер 2 МиБ");
    }
    return { value: JSON.parse(source), source };
  }

  function generateId() {
    const cryptoApi = root.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return `custom-${cryptoApi.randomUUID().toLowerCase()}`;
    }
    const random = Math.random().toString(36).slice(2, 12);
    return `custom-${Date.now().toString(36)}-${random}`;
  }

  function normalizeColor(value) {
    const color = typeof value === "string" && colorPattern.test(value.trim())
      ? value.trim().toLowerCase()
      : "";
    if (!color) throw new Error("Цвет слоя должен быть в формате #rrggbb");
    return color;
  }

  function normalizeEntry(input, options) {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input : null;
    if (!value) throw new Error("Локальный слой должен быть объектом");

    const settings = options && typeof options === "object" ? options : {};
    const suppliedId = typeof value.id === "string" ? value.id.trim() : "";
    const id = suppliedId || (settings.requireId ? "" : generateId());
    if (!customIdPattern.test(id)) {
      throw new Error("Некорректный идентификатор локального слоя");
    }

    const name = typeof value.name === "string" ? value.name.trim().slice(0, 60) : "";
    if (!name) throw new Error("Укажите название локального слоя");
    const color = normalizeColor(value.color);

    const cloned = jsonClone(value.data);
    const runtime = settings.runtime || root.SloiLayerRuntime;
    if (!runtime || typeof runtime.validateGeoJson !== "function") {
      throw new Error("Проверка GeoJSON недоступна");
    }

    let validated;
    try {
      validated = runtime.validateGeoJson(cloned.value);
    } catch (error) {
      throw new Error(`Некорректный GeoJSON: ${String(error && error.message || error)}`);
    }
    if (!validated || !validated.data) {
      throw new Error("Проверка GeoJSON не вернула данные слоя");
    }

    const safeData = jsonClone(validated.data).value;
    return {
      id,
      name,
      color,
      data: safeData,
      bounds: validated.bounds,
      featureCount: validated.featureCount,
    };
  }

  function requestError(prefix, request) {
    const detail = request && request.error && request.error.message;
    return new Error(detail ? `${prefix}: ${detail}` : prefix);
  }

  function storedRecordSize(record) {
    try {
      const serialized = JSON.stringify(record);
      if (typeof serialized !== "string") throw new Error();
      return utf8Size(serialized);
    } catch (_error) {
      throw new Error("В библиотеке есть повреждённая запись; удалите её перед импортом");
    }
  }

  class Library {
    constructor(options) {
      const settings = options && typeof options === "object" ? options : {};
      this.indexedDB = settings.indexedDB || root.indexedDB;
      this.runtime = settings.runtime || null;
      this.database = null;
    }

    open() {
      if (this.database) return Promise.resolve(this.database);
      if (!this.indexedDB || typeof this.indexedDB.open !== "function") {
        return Promise.reject(new Error("IndexedDB недоступна: локальные слои нельзя сохранить"));
      }
      return new Promise((resolve, reject) => {
        const request = this.indexedDB.open(databaseName, databaseVersion);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName, { keyPath: "id" });
          }
        };
        request.onblocked = () => reject(new Error("База локальных слоёв занята другой вкладкой"));
        request.onerror = () => reject(requestError("Не удалось открыть библиотеку слоёв", request));
        request.onsuccess = () => {
          this.database = request.result;
          this.database.onversionchange = () => {
            this.database.close();
            this.database = null;
          };
          resolve(this.database);
        };
      });
    }

    async load() {
      const database = await this.open();
      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = database.transaction(storeName, "readonly");
        } catch (error) {
          reject(new Error(`Не удалось прочитать библиотеку слоёв: ${error.message}`));
          return;
        }
        const request = transaction.objectStore(storeName).getAll();
        request.onerror = () => reject(requestError("Не удалось прочитать библиотеку слоёв", request));
        request.onsuccess = () => {
          const entries = [];
          const warnings = [];
          for (const record of request.result || []) {
            try {
              const entry = normalizeEntry(record, { requireId: true, runtime: this.runtime });
              if (entries.length < maxEntries) entries.push(entry);
              else warnings.push(`Слой ${entry.id} пропущен: достигнут лимит ${maxEntries}`);
            } catch (error) {
              const id = record && typeof record.id === "string" ? record.id : "без идентификатора";
              warnings.push(`Слой ${id} пропущен: ${error.message}`);
            }
          }
          resolve({ entries, warnings });
        };
      });
    }

    async put(input) {
      const entry = normalizeEntry(input, { runtime: this.runtime });
      const database = await this.open();
      return new Promise((resolve, reject) => {
        let settled = false;
        let transaction;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        try {
          transaction = database.transaction(storeName, "readwrite");
          const store = transaction.objectStore(storeName);
          const request = store.getAll();
          request.onerror = () => fail(requestError("Не удалось проверить место для слоя", request));
          request.onsuccess = () => {
            try {
              const records = request.result || [];
              const existingIds = new Set(records.map((record) => record && record.id));
              if (!existingIds.has(entry.id) && records.length >= maxEntries) {
                throw new Error(`Можно сохранить не больше ${maxEntries} локальных слоёв`);
              }
              let totalBytes = storedRecordSize(entry);
              for (const record of records) {
                if (record && record.id === entry.id) continue;
                totalBytes += storedRecordSize(record);
              }
              if (totalBytes > maxTotalBytes) {
                throw new Error("Локальные слои превышают общий лимит 8 МиБ");
              }
              const putRequest = store.put(entry);
              putRequest.onerror = () => fail(requestError("Не удалось сохранить локальный слой", putRequest));
            } catch (error) {
              transaction.abort();
              fail(error);
            }
          };
          transaction.oncomplete = () => {
            if (!settled) {
              settled = true;
              resolve(entry);
            }
          };
          transaction.onerror = () => fail(requestError("Не удалось сохранить локальный слой", transaction));
          transaction.onabort = () => {
            if (!settled) fail(requestError("Сохранение локального слоя отменено", transaction));
          };
        } catch (error) {
          fail(new Error(`Не удалось сохранить локальный слой: ${error.message}`));
        }
      });
    }

    async remove(id) {
      if (typeof id !== "string" || !customIdPattern.test(id)) {
        throw new Error("Некорректный идентификатор локального слоя");
      }
      const database = await this.open();
      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = database.transaction(storeName, "readwrite");
          const request = transaction.objectStore(storeName).delete(id);
          request.onerror = () => reject(requestError("Не удалось удалить локальный слой", request));
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(requestError("Не удалось удалить локальный слой", transaction));
          transaction.onabort = () => reject(requestError("Удаление локального слоя отменено", transaction));
        } catch (error) {
          reject(new Error(`Не удалось удалить локальный слой: ${error.message}`));
        }
      });
    }

    async updateColor(id, color) {
      if (typeof id !== "string" || !customIdPattern.test(id)) {
        throw new Error("Некорректный идентификатор локального слоя");
      }
      const normalizedColor = normalizeColor(color);
      const database = await this.open();
      return new Promise((resolve, reject) => {
        let settled = false;
        let updated = null;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        let transaction;
        try {
          transaction = database.transaction(storeName, "readwrite");
          const store = transaction.objectStore(storeName);
          const request = store.get(id);
          request.onerror = () => fail(requestError("Не удалось прочитать локальный слой", request));
          request.onsuccess = () => {
            const record = request.result;
            if (!record || typeof record !== "object" || record.id !== id) {
              transaction.abort();
              fail(new Error("Локальный слой не найден"));
              return;
            }
            updated = { ...record, color: normalizedColor };
            const putRequest = store.put(updated);
            putRequest.onerror = () => fail(requestError("Не удалось изменить цвет слоя", putRequest));
          };
          transaction.oncomplete = () => {
            if (!settled) {
              settled = true;
              resolve(updated);
            }
          };
          transaction.onerror = () => fail(requestError("Не удалось изменить цвет слоя", transaction));
          transaction.onabort = () => {
            if (!settled) fail(requestError("Изменение цвета слоя отменено", transaction));
          };
        } catch (error) {
          fail(new Error(`Не удалось изменить цвет слоя: ${error.message}`));
        }
      });
    }
  }

  root.SloiLayerLibrary = Object.freeze({
    Library,
    normalizeEntry,
    limits: Object.freeze({ maxEntries, maxEntryBytes, maxTotalBytes }),
  });
})(typeof window !== "undefined" ? window : globalThis);
