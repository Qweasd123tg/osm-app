(function (root) {
  "use strict";
  const states = new WeakMap(), active = new Set();
  const reduced = root.matchMedia("(prefers-reduced-motion: reduce)");

  function finish(state) {
    state.generation++;
    state.animation?.cancel(); state.animation = null;
    state.details.open = state.desired;
    state.details.style.height = state.height;
    state.details.style.overflow = state.overflow;
    delete state.details.dataset.disclosureMotion;
    active.delete(state);
  }

  function setOpen(details, desired) {
    const summary = details.querySelector(":scope > summary");
    if (!summary) return;
    let state = states.get(details);
    if (!state || !state.animation) {
      state = { details, desired: details.open, height: details.style.height,
        overflow: details.style.overflow, animation: null, generation: 0 };
      states.set(details, state);
    }
    const from = details.getBoundingClientRect().height;
    state.animation?.cancel(); state.animation = null;
    state.desired = !!desired;
    const generation = ++state.generation;
    if (!desired && details.contains(document.activeElement) && document.activeElement !== summary) summary.focus({ preventScroll: true });
    if (reduced.matches || !details.isConnected || details.closest("[hidden],[inert]") || typeof details.animate !== "function") {
      finish(state); return;
    }
    // Measure both native states without introducing wrappers or moving inputs.
    // Opening stays semantically open while its small content box expands;
    // closing commits the closed state once the shrink has completed.
    details.style.height = state.height;
    details.open = false;
    const closed = details.getBoundingClientRect().height;
    details.open = true;
    const expanded = details.getBoundingClientRect().height;
    const target = desired ? expanded : closed;
    if (Math.abs(target - from) < .5) { finish(state); return; }
    details.style.overflow = "hidden";
    details.dataset.disclosureMotion = desired ? "opening" : "closing";
    active.add(state);
    const animation = state.animation = details.animate([
      { height: `${from}px` }, { height: `${target}px` },
    ], { duration: 190, easing: "cubic-bezier(.2,.75,.25,1)", fill: "forwards" });
    animation.finished.then(() => {
      if (generation === state.generation && state.animation === animation) finish(state);
    }).catch(() => {});
  }

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button > 0) return;
    const summary = event.target.closest?.("summary");
    if (!summary || summary.parentElement?.tagName !== "DETAILS"
      || !summary.closest(".sheet,.settings-page,.routing-panel,[data-animate-disclosure]")
      || event.target.closest?.("button,a,input,select,textarea")) return;
    event.preventDefault();
    const details = summary.parentElement, state = states.get(details);
    setOpen(details, !(state?.animation ? state.desired : details.open));
  });
  reduced.addEventListener?.("change", () => { if (reduced.matches) for (const state of [...active]) finish(state); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) for (const state of [...active]) finish(state);
  });
  new MutationObserver(() => {
    for (const state of [...active]) {
      if (!state.details.isConnected || state.details.closest("[hidden],[inert]")) finish(state);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "inert"] });
  root.SloiDisclosure = Object.freeze({ setOpen });
})(typeof window !== "undefined" ? window : globalThis);
