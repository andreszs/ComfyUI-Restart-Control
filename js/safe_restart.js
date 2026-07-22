import { app } from "../../scripts/app.js";
import * as restartCore from "./safe_restart_core.mjs";

const {
    CAPABILITIES_ROUTE,
    QUEUE_ROUTE,
    RESTART_ROUTE,
    TOKEN_HEADER,
    hasCompletedRestart,
    isAllowedBrowserShortcut,
    nextPollDelay,
    queueCounts,
} = restartCore;
const PLUGINS_ROUTE = restartCore.PLUGINS_ROUTE || "/safe-restart/plugins";

function selectedPluginIds(plugins) {
    return plugins
        .filter((plugin) => plugin.protected || (plugin.selectable && plugin.selected))
        .map((plugin) => plugin.id);
}

function pluginSelectionCounts(plugins) {
    const selectable = plugins.filter((plugin) => plugin.selectable);
    return {
        load: selectedPluginIds(plugins).length,
        excluded: selectable.filter((plugin) => !plugin.selected).length,
    };
}

if (!document.getElementById("andreszs-safe-restart-styles")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "andreszs-safe-restart-styles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./safe_restart.css", import.meta.url).href;
    document.head.append(stylesheet);
}

const EXTENSION_NAME = "andreszs.RestartControl";
const TAB_ID = "andreszs-restart-control";
const STATE_KEY = "__andreszsComfyUIRestartControl";
const POLL_TIMEOUT_MS = 120_000;
const COMPLETION_HOLD_MS = 500;

let restartInProgress = false;
let overlay = null;
let elapsedTimer = null;
let restartStartedAt = null;
let inertedElements = [];
let keyboardLocked = false;
let cascadeAnimations = [];

function apiRequest(route, options = {}) {
    return app.api.fetchApi(route, {
        cache: "no-store",
        credentials: "same-origin",
        ...options,
    });
}

async function readJson(response, context) {
    if (!response.ok) {
        let detail = `${context} failed (${response.status})`;
        try {
            const body = await response.json();
            if (body?.error) detail = body.error;
        } catch {
            // Keep the HTTP status when the server did not return JSON.
        }
        throw new Error(detail);
    }
    return response.json();
}

async function fetchCapabilities() {
    return readJson(await apiRequest(CAPABILITIES_ROUTE), "Capability check");
}

async function fetchQueue() {
    return readJson(await apiRequest(QUEUE_ROUTE), "Queue check");
}

async function fetchPlugins(capabilities) {
    return readJson(await apiRequest(PLUGINS_ROUTE, {
        headers: { [TOKEN_HEADER]: capabilities.restart_token },
    }), "Custom node inventory");
}

async function submitRestart(capabilities, enabledPlugins = null) {
    const response = await apiRequest(RESTART_ROUTE, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            [TOKEN_HEADER]: capabilities.restart_token,
        },
        body: JSON.stringify(enabledPlugins === null
            ? {}
            : { safe_mode: true, enabled_plugins: enabledPlugins }),
    });
    return readJson(response, "Restart request");
}

function queueStatus(queue) {
    const { running, pending } = queueCounts(queue);
    if (running === 0 && pending === 0) return { text: "QUEUE CLEAR", busy: false };
    return { text: `${running} RUNNING / ${pending} PENDING`, busy: true };
}

function showPluginSelector(inventory, queue) {
    const plugins = inventory.plugins
        .filter((plugin) => plugin.selectable || plugin.protected)
        .map((plugin) => ({
            ...plugin,
            selected: true,
        }));
    const selector = document.createElement("div");
    selector.className = "andreszs-safe-restart-selector";
    selector.setAttribute("role", "dialog");
    selector.setAttribute("aria-modal", "true");
    selector.setAttribute("aria-labelledby", "andreszs-safe-restart-selector-title");
    selector.innerHTML = `
        <div class="andreszs-safe-restart-selector-card">
            <button type="button" class="andreszs-safe-restart-selector-close" data-selector-close aria-label="Close">×</button>
            <header>
                <div class="andreszs-safe-restart-selector-kicker"><span></span>RESTART CONTROL / PLUGIN MATRIX</div>
                <h2 id="andreszs-safe-restart-selector-title">Define restart directive</h2>
            </header>
            <div class="andreszs-safe-restart-selector-toolbar">
                <label><i class="pi pi-search" aria-hidden="true"></i><input type="search" placeholder="Filter nodes…" aria-label="Filter nodes"></label>
                <button type="button" data-selector-toggle-all>Disable all</button>
            </div>
            <div class="andreszs-safe-restart-plugin-list" role="list"></div>
            <div class="andreszs-safe-restart-selector-summary">
                <span class="andreszs-safe-restart-selector-status" data-selector-status>
                    <span data-selector-counts></span>
                    <span data-selector-profile>PROFILE APPLIES TO NEXT RESTART ONLY</span>
                </span>
                <span data-selector-queue></span>
            </div>
            <footer>
                <button type="button" data-selector-cancel>CANCEL</button>
                <button type="button" class="is-primary" data-selector-confirm>RESTART</button>
            </footer>
        </div>`;

    const list = selector.querySelector(".andreszs-safe-restart-plugin-list");
    const search = selector.querySelector('input[type="search"]');
    const status = selector.querySelector("[data-selector-status]");
    const counts = selector.querySelector("[data-selector-counts]");
    const profile = selector.querySelector("[data-selector-profile]");
    const queueElement = selector.querySelector("[data-selector-queue]");
    const toggleAll = selector.querySelector("[data-selector-toggle-all]");
    const queueState = queueStatus(queue);
    queueElement.textContent = queueState.text;
    queueElement.classList.toggle("is-busy", queueState.busy);

    const stateLabels = {
        active: "ACTIVE",
        excluded: "EXCLUDED",
        protected: "REQUIRED",
    };
    const rows = plugins.map((plugin) => {
        const row = document.createElement("label");
        row.className = "andreszs-safe-restart-plugin-row";
        row.dataset.search = `${plugin.name} ${plugin.id}`.toLowerCase();

        const identity = document.createElement("span");
        identity.className = "andreszs-safe-restart-plugin-identity";
        const name = document.createElement("strong");
        name.textContent = plugin.name;
        const id = document.createElement("small");
        id.textContent = plugin.locations > 1 ? `${plugin.locations} locations` : "";
        id.hidden = plugin.locations <= 1;
        identity.append(name, id);

        const state = document.createElement("span");
        state.className = `andreszs-safe-restart-plugin-state is-${plugin.state}`;
        state.textContent = stateLabels[plugin.state] || plugin.state.toUpperCase();

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = plugin.selected;
        toggle.disabled = !plugin.selectable;
        toggle.setAttribute("aria-label", `Load ${plugin.name} on next boot`);
        const switchTrack = document.createElement("span");
        switchTrack.className = "andreszs-safe-restart-plugin-switch";

        row.append(identity, state, toggle, switchTrack);
        list.append(row);
        return { plugin, row, toggle, state };
    });
    const noResults = document.createElement("div");
    noResults.className = "andreszs-safe-restart-no-results";
    noResults.setAttribute("role", "status");
    noResults.hidden = true;
    noResults.innerHTML = `<span aria-hidden="true">×</span><strong>NO TARGETS FOUND</strong>`;
    list.append(noResults);
    const noResultsSignal = noResults.querySelector("span");
    let noResultsAnimation = null;
    let summaryInterval = null;
    let summaryAnimations = [];
    let showingProfile = false;

    const animateSummary = () => {
        showingProfile = !showingProfile;
        for (const animation of summaryAnimations) animation.cancel();
        const entering = showingProfile ? profile : counts;
        const leaving = showingProfile ? counts : profile;
        summaryAnimations = [
            leaving.animate([
                { opacity: 1, transform: "translateY(0)" },
                { opacity: 0, transform: "translateY(-0.18rem)" },
            ], { duration: 180, easing: "ease-in", fill: "forwards" }),
            entering.animate([
                { opacity: 0, transform: "translateY(0.18rem)" },
                { opacity: 1, transform: "translateY(0)" },
            ], { duration: 220, delay: 90, easing: "ease-out", fill: "forwards" }),
        ];
    };

    const stopSummaryCycle = () => {
        window.clearInterval(summaryInterval);
        summaryInterval = null;
        for (const animation of summaryAnimations) animation.cancel();
        summaryAnimations = [];
    };

    const showNoResults = (show) => {
        if (show === !noResults.hidden) return;
        noResults.hidden = !show;
        if (show) {
            noResultsAnimation = noResultsSignal.animate([
                { opacity: 0.35, filter: "brightness(0.8)" },
                { opacity: 1, filter: "brightness(1.65)" },
                { opacity: 0.35, filter: "brightness(0.8)" },
            ], {
                duration: 1050,
                easing: "ease-in-out",
                iterations: Infinity,
            });
        } else {
            noResultsAnimation?.cancel();
            noResultsAnimation = null;
        }
    };

    const update = () => {
        for (const item of rows) {
            item.plugin.selected = item.toggle.checked;
            if (item.plugin.selectable) {
                const state = !item.toggle.checked
                    ? "excluded"
                    : item.plugin.state === "excluded" ? "staged" : "active";
                item.state.className = `andreszs-safe-restart-plugin-state is-${state}`;
                item.state.textContent = state.toUpperCase();
                item.state.setAttribute(
                    "aria-label",
                    state === "staged"
                        ? "Disabled now; enabled on next restart"
                        : item.state.textContent,
                );
            }
        }
        const totals = pluginSelectionCounts(plugins);
        counts.textContent = `${totals.load} LOAD / ${totals.excluded} EXCLUDED`;
        status.setAttribute(
            "aria-label",
            `${counts.textContent}. This profile applies to the next restart only.`,
        );
        const allSelected = rows
            .filter((item) => item.plugin.selectable)
            .every((item) => item.toggle.checked);
        toggleAll.textContent = allSelected ? "Disable all" : "Enable all";
        toggleAll.dataset.action = allSelected ? "disable" : "enable";
    };
    for (const item of rows) item.toggle.addEventListener("change", update);
    toggleAll.addEventListener("click", () => {
        const enabled = toggleAll.dataset.action === "enable";
        for (const item of rows) if (item.plugin.selectable) item.toggle.checked = enabled;
        update();
    });
    search.addEventListener("input", () => {
        const query = search.value.trim().toLowerCase();
        let matches = 0;
        for (const item of rows) {
            const match = item.row.dataset.search.includes(query);
            item.row.hidden = !match;
            if (match) matches += 1;
        }
        showNoResults(query.length > 0 && matches === 0);
    });
    update();

    document.body.append(selector);
    summaryInterval = window.setInterval(animateSummary, 2800);
    const background = Array.from(document.body.children)
        .filter((child) => child !== selector && !child.inert);
    for (const child of background) child.inert = true;

    return new Promise((resolve) => {
        const close = () => {
            window.removeEventListener("keydown", onKeyDown, true);
            noResultsAnimation?.cancel();
            stopSummaryCycle();
            for (const child of background) child.inert = false;
            selector.remove();
            resolve(null);
        };
        const onKeyDown = (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
        };
        window.addEventListener("keydown", onKeyDown, true);
        selector.querySelector("[data-selector-cancel]").addEventListener("click", close);
        selector.querySelector("[data-selector-close]").addEventListener("click", close);
        selector.querySelector("[data-selector-confirm]").addEventListener("click", (event) => {
            event.currentTarget.disabled = true;
            window.removeEventListener("keydown", onKeyDown, true);
            noResultsAnimation?.cancel();
            stopSummaryCycle();
            inertedElements = background;
            const totals = pluginSelectionCounts(plugins);
            resolve({
                enabledPlugins: selectedPluginIds(plugins),
                element: selector,
                safeReboot: totals.excluded > 0,
            });
        });
        requestAnimationFrame(() => search.focus({ preventScroll: true }));
    });
}

function restartStatusMarkup() {
    return `
        <div class="andreszs-safe-restart-kicker" aria-hidden="true">
            <span class="andreszs-safe-restart-beacon"></span>
            <span data-safe-restart-kicker-label>SERVER RESTART / BOOT TRACE</span>
        </div>
        <div class="andreszs-safe-restart-trace" aria-hidden="true">
            <div data-safe-restart-request>
                <span class="andreszs-safe-restart-trace-index">01</span><span class="andreszs-safe-restart-trace-label">RESTART REQUEST</span><b>TRANSMITTING</b>
            </div>
            <div data-safe-restart-handoff>
                <span class="andreszs-safe-restart-trace-index">02</span><span class="andreszs-safe-restart-trace-label">PROCESS HANDOFF</span><b>STANDBY</b>
            </div>
            <div data-safe-restart-boot>
                <span class="andreszs-safe-restart-trace-index">03</span><span class="andreszs-safe-restart-trace-label">BOOT ID WATCH</span><b>STANDBY</b>
            </div>
        </div>
        <div class="andreszs-safe-restart-telemetry" aria-hidden="true">
            ${Array.from({ length: 20 }, (_, index) => `<span style="--delay:${((index - 19) * 0.085).toFixed(3)}s"></span>`).join("")}
        </div>
        <i class="pi pi-exclamation-triangle andreszs-safe-restart-error-icon" aria-hidden="true"></i>
        <p data-safe-restart-message hidden></p>
        <p class="andreszs-safe-restart-detail">
            <span data-safe-restart-detail-label>PLEASE STAND BY</span>
            <b>/</b> <span data-safe-restart-elapsed>0s</span>
        </p>
        <div data-safe-restart-actions hidden>
            <button type="button" data-safe-restart-retry>Try again</button>
            <button type="button" data-safe-restart-reload>Reload now</button>
        </div>`;
}

function ensureOverlay() {
    if (overlay?.isConnected) return overlay;

    overlay = document.createElement("div");
    overlay.id = "andreszs-safe-restart-overlay";
    overlay.className = "andreszs-safe-restart-overlay";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "assertive");
    overlay.setAttribute("aria-busy", "true");
    overlay.tabIndex = -1;
    overlay.innerHTML = `<div class="andreszs-safe-restart-card">${restartStatusMarkup()}</div>`;
    document.body.append(overlay);
    lockWorkspace(overlay);
    return overlay;
}

function blockWorkflowKeyboard(event) {
    if (isAllowedBrowserShortcut(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

function lockWorkspace(element) {
    if (inertedElements.length === 0) {
        inertedElements = Array.from(document.body.children)
            .filter((child) => child !== element && !child.inert);
        for (const child of inertedElements) child.inert = true;
    }
    if (!keyboardLocked) {
        window.addEventListener("keydown", blockWorkflowKeyboard, true);
        keyboardLocked = true;
    }
    requestAnimationFrame(() => element.focus({ preventScroll: true }));
}

function allowRecoveryInput() {
    if (keyboardLocked) {
        window.removeEventListener("keydown", blockWorkflowKeyboard, true);
        keyboardLocked = false;
    }
}

function unlockWorkspace() {
    allowRecoveryInput();
    for (const child of inertedElements) child.inert = false;
    inertedElements = [];
}

function setTraceAccepted(element, accepted) {
    const request = element.querySelector("[data-safe-restart-request]");
    const handoff = element.querySelector("[data-safe-restart-handoff]");
    const boot = element.querySelector("[data-safe-restart-boot]");
    request.classList.toggle("is-active", !accepted);
    request.classList.toggle("is-complete", accepted);
    handoff.classList.toggle("is-active", accepted);
    handoff.classList.remove("is-complete");
    boot.classList.remove("is-active", "is-complete");
    request.querySelector("b").textContent = accepted ? "✓ ACCEPTED" : "TRANSMITTING";
    handoff.querySelector("b").textContent = accepted ? "ACTIVE" : "STANDBY";
    boot.querySelector("b").textContent = accepted ? "AWAITING" : "STANDBY";
}

function setTraceComplete(element) {
    const states = [
        ["[data-safe-restart-request]", "✓ ACCEPTED"],
        ["[data-safe-restart-handoff]", "✓ COMPLETE"],
        ["[data-safe-restart-boot]", "✓ VERIFIED"],
    ];
    for (const [selector, status] of states) {
        const row = element.querySelector(selector);
        row.classList.remove("is-active");
        row.classList.add("is-complete");
        row.querySelector("b").textContent = status;
    }
}

function stopElapsedTimer() {
    if (elapsedTimer !== null) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
    }
}

function startElapsedTimer(element) {
    stopElapsedTimer();
    restartStartedAt = Date.now();
    const elapsed = element.querySelector("[data-safe-restart-elapsed]");
    const update = () => {
        elapsed.textContent = `${Math.floor((Date.now() - restartStartedAt) / 1000)}s`;
    };
    update();
    elapsedTimer = setInterval(update, 1000);
}

function stopBootCascade() {
    for (const animation of cascadeAnimations) animation.cancel();
    cascadeAnimations = [];
}

function playBootCascade(element, { animateShell = true } = {}) {
    stopBootCascade();

    const animate = (target, keyframes, options) => {
        if (typeof target?.animate !== "function") return;
        cascadeAnimations.push(target.animate(keyframes, {
            fill: "both",
            ...options,
        }));
    };
    const easeOut = "cubic-bezier(0.16, 1, 0.3, 1)";
    const card = element.querySelector(".andreszs-safe-restart-card");
    const kicker = element.querySelector(".andreszs-safe-restart-kicker");
    const rows = element.querySelectorAll(".andreszs-safe-restart-trace > div");
    const telemetry = element.querySelector(".andreszs-safe-restart-telemetry");
    const detail = element.querySelector(".andreszs-safe-restart-detail");

    if (animateShell) {
        animate(element, [
            { backgroundColor: "rgb(0 7 12 / 0%)" },
            { backgroundColor: "rgb(0 7 12 / 48%)" },
        ], { duration: 140, easing: "ease-out" });
        animate(card, [
            {
                clipPath: "inset(0 50% 0 50%)",
                filter: "brightness(1.65)",
                opacity: 0,
            },
            {
                clipPath: "inset(0 18% 0 18%)",
                filter: "brightness(1.3)",
                opacity: 1,
                offset: 0.55,
            },
            { clipPath: "inset(0)", filter: "brightness(1)", opacity: 1 },
        ], { duration: 230, easing: easeOut });
    }
    animate(kicker, [
        {
            filter: "blur(2px) brightness(1.6)",
            opacity: 0,
            transform: "translateX(-8px)",
        },
        {
            filter: "blur(0) brightness(1)",
            opacity: 1,
            transform: "translateX(0)",
        },
    ], { delay: 100, duration: 130, easing: easeOut });

    rows.forEach((row, index) => animate(row, [
        {
            filter: "blur(1px) brightness(1.45)",
            opacity: 0,
            transform: "translateX(-9px)",
        },
        { filter: "blur(0) brightness(1)", opacity: 1, transform: "translateX(0)" },
    ], { delay: 190 + (index * 60), duration: 110, easing: easeOut }));

    animate(telemetry, [
        { clipPath: "inset(0 50% 0 50%)", filter: "brightness(1.6)", opacity: 0 },
        { clipPath: "inset(0)", filter: "brightness(1)", opacity: 1 },
    ], {
        delay: 380,
        duration: 130,
        easing: easeOut,
    });
    animate(detail, [
        { filter: "blur(1px) brightness(1.4)", opacity: 0, transform: "translateY(3px)" },
        { filter: "blur(0) brightness(1)", opacity: 1, transform: "translateY(0)" },
    ], { delay: 470, duration: 120, easing: easeOut });
}

async function showRestarting(safeReboot = false, selector = null) {
    let element;
    let resizeAnimation = null;
    if (selector?.isConnected) {
        element = selector;
        overlay = element;
        const card = element.querySelector(".andreszs-safe-restart-selector-card");
        const startRect = card.getBoundingClientRect();
        const oldContent = Array.from(card.children);
        await Promise.all(oldContent.map(async (child) => {
            const animation = child.animate([
                { opacity: 1, transform: "translateY(0)" },
                { opacity: 0, transform: "translateY(-4px)" },
            ], { duration: 110, easing: "ease-in", fill: "both" });
            try {
                await animation.finished;
            } catch {
                // A cancelled transition should not prevent the restart.
            }
        }));

        const startBackground = getComputedStyle(element).backgroundColor;
        element.id = "andreszs-safe-restart-overlay";
        element.className = "andreszs-safe-restart-overlay";
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "assertive");
        element.tabIndex = -1;
        card.className = "andreszs-safe-restart-card";
        card.innerHTML = restartStatusMarkup();
        card.style.boxSizing = "border-box";
        card.style.visibility = "hidden";
        const targetRect = card.getBoundingClientRect();
        card.style.width = `${startRect.width}px`;
        card.style.height = `${startRect.height}px`;
        card.style.overflow = "hidden";
        card.style.visibility = "";
        card.getBoundingClientRect();
        resizeAnimation = card.animate([
            { width: `${startRect.width}px`, height: `${startRect.height}px` },
            { width: `${targetRect.width}px`, height: `${targetRect.height}px` },
        ], {
            duration: 310,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "both",
        });
        element.animate([
            { backgroundColor: startBackground },
            { backgroundColor: "rgb(0 7 12 / 48%)" },
        ], { duration: 310, easing: "ease-out" });
    } else {
        element = ensureOverlay();
    }
    lockWorkspace(element);
    element.setAttribute("aria-busy", "true");
    element.classList.remove(
        "andreszs-safe-restart-complete",
        "andreszs-safe-restart-failed",
    );
    element.querySelector("[data-safe-restart-kicker-label]").textContent =
        `${safeReboot ? "SAFE" : "SERVER"} RESTART / BOOT TRACE`;
    element.querySelector("[data-safe-restart-detail-label]").textContent =
        "PLEASE STAND BY";
    element.querySelector("[data-safe-restart-message]").hidden = true;
    element.querySelector("[data-safe-restart-actions]").hidden = true;
    setTraceAccepted(element, false);
    startElapsedTimer(element);
    playBootCascade(element, { animateShell: selector === null });
    if (resizeAnimation) {
        try {
            await resizeAnimation.finished;
        } catch {
            // Continue with the final responsive dimensions if animation is cancelled.
        }
        const card = element.querySelector(".andreszs-safe-restart-card");
        const finalFrame = resizeAnimation.effect.getKeyframes().at(-1);
        card.style.width = finalFrame.width;
        card.style.height = finalFrame.height;
        resizeAnimation.cancel();
        card.style.removeProperty("width");
        card.style.removeProperty("height");
        card.style.removeProperty("overflow");
        card.style.removeProperty("box-sizing");
    }
}

function showRecovery(error, retry) {
    const element = ensureOverlay();
    stopBootCascade();
    stopElapsedTimer();
    element.setAttribute("aria-busy", "false");
    element.classList.add("andreszs-safe-restart-failed");
    allowRecoveryInput();
    const message = element.querySelector("[data-safe-restart-message]");
    message.textContent = `ComfyUI did not reconnect automatically. ${error.message}`;
    message.hidden = false;
    const actions = element.querySelector("[data-safe-restart-actions]");
    actions.hidden = false;
    actions.querySelector("[data-safe-restart-retry]").onclick = retry;
    actions.querySelector("[data-safe-restart-reload]").onclick = () => location.reload();
    requestAnimationFrame(() => actions.querySelector("[data-safe-restart-retry]").focus());
}

function setButtonBusy(button, busy) {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reloadAfterRestart(element, safeReboot = false) {
    stopBootCascade();
    stopElapsedTimer();
    element.setAttribute("aria-busy", "false");
    element.classList.add("andreszs-safe-restart-complete");
    setTraceComplete(element);
    element.querySelector("[data-safe-restart-kicker-label]").textContent =
        `${safeReboot ? "SAFE" : "SERVER"} RESTART / SYSTEM ONLINE`;
    element.querySelector("[data-safe-restart-detail-label]").textContent =
        "LINK RESTORED";
    await delay(COMPLETION_HOLD_MS);
    location.reload();
}

async function waitForNewBoot(previousBootId) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let pollDelay = 500;
    let lastError = new Error("Timed out while waiting for the backend.");

    while (Date.now() < deadline) {
        await delay(pollDelay);
        try {
            const capabilities = await fetchCapabilities();
            if (hasCompletedRestart(previousBootId, capabilities)) return;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
        pollDelay = nextPollDelay(pollDelay);
    }
    throw lastError;
}

async function requestRestart(button) {
    if (restartInProgress) return;
    restartInProgress = true;
    setButtonBusy(button, true);

    let previousBootId = null;
    let restartAccepted = false;
    let safeReboot = false;
    let enabledPlugins = null;
    try {
        const [capabilities, queue] = await Promise.all([
            fetchCapabilities(),
            fetchQueue(),
        ]);
        previousBootId = capabilities.boot_id;
        const inventory = await fetchPlugins(capabilities);
        const selection = await showPluginSelector(inventory, queue);
        if (selection === null) return;
        safeReboot = selection.safeReboot;
        enabledPlugins = safeReboot ? selection.enabledPlugins : null;
        overlay = selection.element;

        await showRestarting(safeReboot, overlay);
        await submitRestart(capabilities, enabledPlugins);
        restartAccepted = true;
        setTraceAccepted(overlay, true);
        await waitForNewBoot(previousBootId);
        await reloadAfterRestart(overlay, safeReboot);
    } catch (error) {
        const restartError = error instanceof Error ? error : new Error(String(error));
        console.error("[ComfyUI Restart Control]", restartError);
        showRecovery(restartError, async () => {
            await showRestarting(safeReboot);
            try {
                if (restartAccepted && previousBootId) {
                    const currentCapabilities = await fetchCapabilities();
                    if (hasCompletedRestart(previousBootId, currentCapabilities)) {
                        await reloadAfterRestart(overlay, safeReboot);
                        return;
                    }
                    if (!currentCapabilities.restart_in_progress) {
                        await submitRestart(currentCapabilities, enabledPlugins);
                    }
                    setTraceAccepted(overlay, true);
                    await waitForNewBoot(previousBootId);
                    await reloadAfterRestart(overlay, safeReboot);
                    return;
                }
                unlockWorkspace();
                overlay.remove();
                overlay = null;
                restartInProgress = false;
                setButtonBusy(button, false);
                await requestRestart(button);
            } catch (retryError) {
                const error = retryError instanceof Error
                    ? retryError
                    : new Error(String(retryError));
                showRecovery(error, () => location.reload());
            }
        });
    } finally {
        if (!overlay?.isConnected) {
            restartInProgress = false;
            setButtonBusy(button, false);
        }
    }
}

function findActionButton(toolbar) {
    return (
        toolbar.querySelector(`.${TAB_ID}-tab-button`) ||
        toolbar.querySelector('button[aria-label="Restart ComfyUI"]')
    );
}

function installActionButton() {
    const toolbar = document.querySelector('[data-testid="side-toolbar"]');
    if (!toolbar) return;

    const actionButton = findActionButton(toolbar);
    const helpButton = toolbar.querySelector('[data-testid="help-center-button"]');
    if (!actionButton || !helpButton?.parentElement) return;

    if (actionButton.nextElementSibling !== helpButton) {
        helpButton.parentElement.insertBefore(actionButton, helpButton);
    }
    actionButton.dataset.safeRestartAction = "true";
    actionButton.setAttribute("aria-label", "Restart ComfyUI");
        actionButton.setAttribute(
            "aria-description",
            "Define restart directive",
    );
    actionButton.removeAttribute("title");

    if (actionButton.dataset.safeRestartBound !== "true") {
        actionButton.dataset.safeRestartBound = "true";
        actionButton.addEventListener(
            "click",
            (event) => {
                event.preventDefault();
                event.stopImmediatePropagation();
                    void requestRestart(actionButton);
            },
            true,
        );
    }
}

function installCompatibilityLayer() {
    const previousState = window[STATE_KEY];
    previousState?.observer?.disconnect();
    if (previousState?.onPageHide) {
        window.removeEventListener("pagehide", previousState.onPageHide);
    }

    let installQueued = false;
    const queueInstall = () => {
        if (installQueued) return;
        installQueued = true;
        queueMicrotask(() => {
            installQueued = false;
            installActionButton();
        });
    };
    const observer = new MutationObserver(queueInstall);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const onPageHide = () => {
        observer.disconnect();
        stopBootCascade();
        stopElapsedTimer();
        unlockWorkspace();
    };
    window.addEventListener("pagehide", onPageHide, { once: true });
    window[STATE_KEY] = { observer, onPageHide };
    queueInstall();
}

app.registerExtension({
    name: EXTENSION_NAME,
    async setup() {
        app.extensionManager.registerSidebarTab({
            id: TAB_ID,
            icon: "pi pi-refresh",
            title: "Restart",
            label: "Restart",
            tooltip: "Define restart directive",
            type: "custom",
            render() {},
        });
        installCompatibilityLayer();
    },
});
