(function (root) {
  "use strict";
  const TYPES = Object.freeze({ bus: "Автобус", tram: "Трамвай", trolley: "Троллейбус" });
  const COLORS = ["#3974d5", "#bb4853", "#168a85", "#8253b0", "#b76c18"];
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(className, text, action) {
    const element = node("button", className, text); element.type = "button";
    if (action) element.addEventListener("click", action);
    return element;
  }
  function icon(type) {
    return root.SloiTransportSymbols.create(type) || root.SloiTransportSymbols.create("bus");
  }
  function routeChip(route) {
    const chip = node("span", "transport-route-chip");
    chip.style.setProperty("--route-color", route.color);
    chip.setAttribute("aria-label", `${TYPES[route.type] || "Маршрут"} ${route.number}`);
    chip.append(icon(route.type), node("strong", "", route.number)); return chip;
  }
  function routePreview(routes) {
    const preview = node("span", "transport-route-preview");
    for (const route of routes) preview.append(routeChip(route));
    return preview;
  }

  function install(options) {
    if (!options?.map || !options.host || !options.presets) throw new Error("Транспорт недоступен");
    const { map, host, presets, editor } = options;
    let opened = false, disposed = false, tab = "presets", opener = null, pending = false, operation = 0;
    let catalog = null, catalogRequest = null, catalogError = "", selectedLine = "";
    let editorMode = "list", editingId = null, editorStatus = null, editorEpoch = 0;
    const panel = node("section", "transport-panel"); panel.id = "transport-panel"; panel.hidden = true;
    panel.setAttribute("role", "region"); panel.setAttribute("aria-labelledby", "transport-title");
    const header = node("header", "transport-header");
    const title = node("h2", "", "Транспорт"); title.id = "transport-title";
    const closeButton = button("transport-close", "×", () => close()); closeButton.setAttribute("aria-label", "Закрыть транспорт");
    header.append(title, closeButton);
    const tabs = node("nav", "transport-tabs"); tabs.setAttribute("aria-label", "Разделы транспорта");
    const tabButtons = new Map();
    for (const [id, label] of [["presets", "Наборы"], ["metro", "Метро"]]) {
      const control = button("", label, () => setTab(id)); control.dataset.transportTab = id;
      control.setAttribute("aria-controls", `transport-${id}`); tabButtons.set(id, control); tabs.append(control);
    }
    const content = node("div", "transport-content");
    const presetContent = node("div", "transport-presets"); presetContent.id = "transport-presets";
    const metroContent = node("div", "transport-metro"); metroContent.id = "transport-metro";
    content.append(presetContent, metroContent);
    const status = node("p", "transport-status"); status.setAttribute("role", "status"); status.hidden = true;
    panel.append(header, tabs, content, status); document.body.append(panel);

    function snapshot(id) { try { return host.get(id); } catch (_) { return null; } }
    function message(value, error = false) {
      status.textContent = value || ""; status.hidden = !value; status.classList.toggle("is-error", error);
    }
    function moduleMessage() {
      if (pending) return;
      const current = snapshot(tab === "metro" ? "spb-metro" : "spb-live");
      if (current?.error) message(current.error, true);
      else if (current?.warning) message(current.warning);
      else if (current?.status === "loading") message("Загрузка…");
      else if (tab === "presets" && current?.enabled && map.getZoom() < 12) message("Приблизьте карту, чтобы увидеть транспорт");
      else message("");
    }
    async function choosePreset(id) {
      const current = ++operation; pending = true; message("Загрузка…"); renderPresets();
      try { await presets.select(id); if (current !== operation || disposed) return; }
      catch (error) { if (current === operation && !disposed) message(error.message || "Не удалось показать набор", true); }
      finally { if (current === operation && !disposed) { pending = false; renderPresets(); if (!status.classList.contains("is-error")) moduleMessage(); } }
    }
    function hideLive() {
      ++operation; pending = false; presets.cancelPending?.(); host.disable("spb-live"); message(""); renderPresets();
    }
    function renderPresets() {
      if (disposed) return;
      const live = snapshot("spb-live"), activeId = presets.activeId();
      const actions = node("div", "transport-live-actions");
      const all = button("transport-filter", "Все маршруты", () => choosePreset(null));
      all.dataset.transportAll = ""; all.setAttribute("aria-pressed", String(live?.enabled && activeId === null && !live.settings.route && !live.settings.routes)); all.disabled = pending;
      const hide = button("transport-filter", "Скрыть", hideLive); hide.dataset.transportHide = "";
      hide.setAttribute("aria-pressed", String(!live?.enabled)); hide.disabled = !live?.enabled && !pending;
      actions.append(all, hide);
      const list = node("div", "transport-preset-list"); list.setAttribute("role", "group"); list.setAttribute("aria-label", "Наборы маршрутов");
      const saved = presets.list();
      for (const preset of saved) {
        const control = button("transport-preset", undefined, () => choosePreset(preset.id)); control.dataset.transportPreset = preset.id;
        control.setAttribute("aria-pressed", String(live?.enabled && activeId === preset.id)); control.disabled = pending;
        control.append(node("strong", "transport-preset-name", preset.name), routePreview(preset.routes)); list.append(control);
      }
      if (!saved.length) list.append(node("p", "transport-empty", "Сохраните нужные номера в набор."));
      const edit = button("transport-edit-link", "Изменить наборы", () => { close(false); options.onEditPresets?.(); }); edit.dataset.transportEdit = "";
      presetContent.replaceChildren(actions, list, edit);
    }
    function lineButton(line, action) {
      const control = button("transport-line-choice", undefined, action); control.dataset.metroLine = line.id;
      control.style.setProperty("--line-color", line.color);
      control.setAttribute("aria-label", `Линия ${line.id}: ${line.name}`);
      control.setAttribute("aria-pressed", String(selectedLine === line.id));
      control.append(node("span", "transport-line-number", line.id)); return control;
    }
    function fitLine(line) {
      if (!line?.bounds || line.bounds.length !== 2) return;
      const height = panel.getBoundingClientRect().height;
      map.fitBounds(line.bounds, { padding: { top: 80, bottom: height + 24, left: 32, right: 32 }, maxZoom: 15, duration: 450 });
    }
    async function chooseLine(id, fit = true) {
      const current = ++operation; pending = true; selectedLine = id; message("Загрузка…"); renderMetro();
      try {
        const configured = await host.configure("spb-metro", { selectedLine: id });
        if (current !== operation || disposed) return;
        const loaded = configured.enabled ? configured : await host.enable("spb-metro");
        if (current !== operation || disposed) return;
        if (loaded.status === "error") throw new Error(loaded.error || "Метро недоступно");
        if (fit && opened && tab === "metro") {
          const lines = id ? catalog?.lines.filter(line => line.id === id) : catalog?.lines;
          if (lines?.length) {
            const boxes = lines.map(line => line.bounds).filter(Boolean);
            if (boxes.length) fitLine({ bounds: [[Math.min(...boxes.map(box => box[0][0])), Math.min(...boxes.map(box => box[0][1]))], [Math.max(...boxes.map(box => box[1][0])), Math.max(...boxes.map(box => box[1][1]))]] });
          }
        }
      } catch (error) { if (current === operation && !disposed) message(error.message || "Метро недоступно", true); }
      finally { if (current === operation && !disposed) { pending = false; renderMetro(); if (!status.classList.contains("is-error")) moduleMessage(); } }
    }
    function renderMetro() {
      if (disposed) return;
      const lines = catalog?.lines || root.SloiMetro?.lines || [];
      const choices = node("div", "transport-line-choices"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "Линии метро");
      const all = button("transport-line-all", "Все", () => chooseLine("")); all.dataset.metroLine = ""; all.setAttribute("aria-pressed", String(!selectedLine)); all.disabled = pending; choices.append(all);
      for (const line of lines) { const choice = lineButton(line, () => chooseLine(line.id)); choice.disabled = pending; choices.append(choice); }
      const list = node("div", "transport-stations");
      const line = catalog?.lines.find(item => item.id === selectedLine);
      if (line) {
        const heading = node("h3", "transport-line-title", line.name); heading.style.setProperty("--line-color", line.color); list.append(heading);
        for (const station of line.stations) {
          const row = button("transport-station", undefined, () => {
            if (!Array.isArray(station.coordinates) || station.coordinates.length !== 2) return;
            const offset = -panel.getBoundingClientRect().height / 2;
            map.easeTo({ center: station.coordinates, zoom: Math.max(16, map.getZoom()), offset: [0, offset], duration: 400 });
            for (const other of list.querySelectorAll(".transport-station")) other.setAttribute("aria-pressed", String(other === row));
          });
          row.style.setProperty("--line-color", line.color); row.dataset.metroStation = station.id; row.setAttribute("aria-pressed", "false");
          const label = `${station.name}${station.closed ? " (закрыта)" : ""}`;
          row.setAttribute("aria-label", `${label}${station.note ? `. ${station.note}` : ""}`);
          row.append(node("span", "transport-station-dot"), node("span", "", label)); list.append(row);
        }
      } else if (catalog) {
        for (const current of catalog.lines) {
          const row = button("transport-line-row", undefined, () => chooseLine(current.id)); row.style.setProperty("--line-color", current.color);
          row.append(node("span", "transport-line-number", current.id), node("span", "", current.name)); list.append(row);
        }
      } else if (catalogError) {
        list.append(node("p", "transport-empty is-error", catalogError));
        list.append(button("transport-edit-link", "Повторить", loadCatalog));
      } else list.append(node("p", "transport-empty", "Загрузка станций…"));
      metroContent.replaceChildren(choices, list);
    }
    async function loadCatalog() {
      catalogRequest?.abort();
      if (disposed || !opened || tab !== "metro") return;
      catalogError = ""; const controller = new AbortController(); catalogRequest = controller; renderMetro();
      try {
        if (!root.SloiMetro?.catalog) throw new Error("Модуль метро недоступен");
        const result = await root.SloiMetro.catalog({ signal: controller.signal });
        if (disposed || controller.signal.aborted || catalogRequest !== controller) return;
        catalog = result; renderMetro();
      } catch (error) {
        if (!controller.signal.aborted && !disposed && catalogRequest === controller) { catalogError = error.message || "Не удалось загрузить станции"; renderMetro(); }
      } finally { if (catalogRequest === controller) catalogRequest = null; }
    }
    function setTab(next) {
      tab = next === "metro" ? "metro" : "presets";
      catalogRequest?.abort(); catalogRequest = null;
      for (const [id, control] of tabButtons) control.setAttribute("aria-pressed", String(id === tab));
      presetContent.hidden = tab !== "presets"; metroContent.hidden = tab !== "metro";
      if (tab === "metro") {
        selectedLine = snapshot("spb-metro")?.settings.selectedLine || ""; renderMetro();
        if (!catalog) loadCatalog();
      } else renderPresets();
      content.scrollTop = 0; moduleMessage();
    }
    function refresh() {
      if (disposed) return;
      renderPresets();
      if (opened && tab === "metro") {
        const selected = snapshot("spb-metro")?.settings.selectedLine;
        if (typeof selected === "string") selectedLine = selected;
        renderMetro();
      }
      if (opened) moduleMessage();
      if (editor && editorMode === "list") renderEditorList();
    }
    function refreshStatus() {
      // A feed warning must not replace focused presets or metro stations.
      if (!disposed && opened) moduleMessage();
    }
    function open(next = "presets") {
      if (disposed) return;
      opener = document.activeElement; options.onOpen?.(); opened = true; panel.hidden = false;
      document.body.classList.add("has-transport-panel"); setTab(next); closeButton.focus({ preventScroll: true });
    }
    function close(restoreFocus = true) {
      if (!opened) return;
      opened = false; catalogRequest?.abort(); catalogRequest = null; panel.hidden = true;
      document.body.classList.remove("has-transport-panel");
      options.onClose?.();
      if (restoreFocus && opener?.isConnected && !opener.closest(".sheet, .settings-page")) opener.focus({ preventScroll: true });
    }

    function editorMessage(value, error = false) {
      if (!editorStatus) return;
      editorStatus.textContent = value || ""; editorStatus.hidden = !value; editorStatus.classList.toggle("is-error", error);
    }
    function renderEditorList() {
      if (!editor || disposed) return;
      ++editorEpoch;
      editorMode = "list"; editingId = null;
      const list = node("div", "transport-editor-list");
      for (const preset of presets.list()) {
        const row = button("transport-editor-preset", undefined, () => showEditor(preset.id)); row.dataset.editTransportPreset = preset.id;
        const copy = node("span", "transport-editor-preset-copy"); copy.append(node("strong", "", preset.name), routePreview(preset.routes));
        row.append(copy, node("span", "transport-editor-chevron", "›")); list.append(row);
      }
      if (!list.childElementCount) list.append(node("p", "transport-empty", "Здесь будут ваши наборы маршрутов."));
      const create = button("primary-button transport-create-preset", "Создать набор", () => showEditor(null)); create.dataset.createTransportPreset = "";
      editorStatus = node("p", "transport-status"); editorStatus.setAttribute("role", "status"); editorStatus.hidden = true;
      editor.replaceChildren(list, create, editorStatus);
    }
    function showEditor(id) {
      if (!editor || disposed) return;
      if (id === undefined) { renderEditorList(); return; }
      const existing = id ? presets.list().find(preset => preset.id === id) : null;
      if (id && !existing) { renderEditorList(); editorMessage("Набор не найден", true); return; }
      const currentEditor = ++editorEpoch;
      editorMode = "edit"; editingId = existing?.id || null;
      const form = node("form", "transport-preset-form"); form.setAttribute("aria-label", existing ? "Изменить набор" : "Новый набор");
      const heading = node("div", "transport-editor-heading");
      heading.append(node("h2", "", existing ? "Изменить набор" : "Новый набор"), button("transport-edit-link", "Отмена", renderEditorList));
      const nameLabel = node("label", "transport-preset-name-field", "Название");
      const name = node("input"); name.type = "text"; name.name = "name"; name.maxLength = 48; name.required = true; name.autocomplete = "off"; name.value = existing?.name || ""; name.placeholder = "Например, На работу";
      name.setAttribute("aria-label", "Название набора"); nameLabel.append(name);
      const routes = node("div", "transport-edit-routes"); const fields = [];
      const add = button("secondary-button transport-add-route", "Добавить маршрут", () => addRoute()); add.dataset.addTransportRoute = "";
      function updateRouteLabels() {
        fields.forEach((field, index) => {
          field.type.setAttribute("aria-label", `Тип транспорта ${index + 1}`); field.number.setAttribute("aria-label", `Номер маршрута ${index + 1}`);
          field.color.setAttribute("aria-label", `Цвет маршрута ${index + 1}`); field.remove.setAttribute("aria-label", `Удалить маршрут ${index + 1}`);
        }); add.disabled = fields.length >= 20;
      }
      function addRoute(value = {}) {
        if (fields.length >= 20) return;
        const row = node("div", "transport-edit-route");
        const type = node("select");
        for (const [id, label] of Object.entries(TYPES)) { const choice = node("option", "", label); choice.value = id; type.append(choice); }
        type.value = value.type || "bus";
        const number = node("input"); number.type = "text"; number.inputMode = "text"; number.autocomplete = "off"; number.maxLength = 12; number.required = true; number.placeholder = "Номер"; number.value = value.number || "";
        const color = node("input", "transport-route-color"); color.type = "color"; color.value = value.color || COLORS[fields.length % COLORS.length];
        const remove = button("transport-remove-route", "×", () => {
          const index = fields.findIndex(field => field.row === row); if (index >= 0) fields.splice(index, 1);
          row.remove(); updateRouteLabels();
        });
        const field = { row, type, number, color, remove }; fields.push(field); row.append(type, number, color, remove); routes.append(row); updateRouteLabels();
      }
      for (const route of existing?.routes || [{}]) addRoute(route);
      const actions = node("div", "transport-editor-actions");
      const save = node("button", "primary-button", "Сохранить"); save.type = "submit"; actions.append(save);
      if (existing) actions.append(button("secondary-button transport-delete-preset", "Удалить набор", async () => {
        try {
          const wasActive = presets.activeId() === existing.id, wasEnabled = snapshot("spb-live")?.enabled;
          presets.remove(existing.id);
          if (wasActive && wasEnabled) await presets.select(null);
          else if (wasActive) await host.configure("spb-live", { routes: "", route: "" });
          if (currentEditor === editorEpoch && !disposed) renderEditorList();
        } catch (error) { if (currentEditor === editorEpoch && !disposed) editorMessage(error.message || "Не удалось удалить набор", true); }
      }));
      editorStatus = node("p", "transport-status"); editorStatus.setAttribute("role", "status"); editorStatus.hidden = true;
      form.append(heading, nameLabel, routes, add, actions, editorStatus);
      form.addEventListener("submit", async event => {
        event.preventDefault(); save.disabled = true; editorMessage("");
        try {
          const saved = presets.save({ ...(editingId ? { id: editingId } : {}), name: name.value, routes: fields.map(field => ({ type: field.type.value, number: field.number.value, color: field.color.value })) });
          editingId = saved.id;
          await presets.select(saved.id);
          if (currentEditor === editorEpoch && !disposed) renderEditorList();
        } catch (error) { if (currentEditor === editorEpoch && !disposed) { editorMessage(error.message || "Не удалось сохранить набор", true); save.disabled = false; } }
      });
      editor.replaceChildren(form); name.focus({ preventScroll: true });
    }
    const unsubscribe = presets.subscribe(refresh);
    function onMove() { if (opened && tab === "presets") moduleMessage(); }
    map.on("moveend", onMove);
    const onKey = event => { if (opened && event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey);
    refresh();
    return Object.freeze({ open, close, isOpen: () => opened, back() { if (!opened) return false; close(); return true; }, refresh, refreshStatus, showEditor,
      editorBack() { if (editorMode !== "edit") return false; renderEditorList(); return true; },
      dispose() { if (disposed) return; close(false); disposed = true; ++operation; catalogRequest?.abort(); unsubscribe?.(); map.off("moveend", onMove); document.removeEventListener("keydown", onKey); panel.remove(); editor?.replaceChildren(); },
    });
  }
  root.SloiTransportUI = Object.freeze({ install });
})(typeof window !== "undefined" ? window : globalThis);
