export const CAPABILITIES_ROUTE = "/safe-restart/capabilities";
export const PLUGINS_ROUTE = "/safe-restart/plugins";
export const QUEUE_ROUTE = "/queue";
export const RESTART_ROUTE = "/safe-restart/restart";
export const TOKEN_HEADER = "X-ComfyUI-Safe-Restart-Token";

export function queueCounts(queue) {
    return {
        running: Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0,
        pending: Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0,
    };
}

export function selectedPluginIds(plugins) {
    return plugins
        .filter((plugin) => plugin.protected || (plugin.selectable && plugin.selected))
        .map((plugin) => plugin.id);
}

export function pluginSelectionCounts(plugins) {
    const selectable = plugins.filter((plugin) => plugin.selectable);
    return {
        load: plugins.filter(
            (plugin) => plugin.protected || (plugin.selectable && plugin.selected),
        ).length,
        excluded: selectable.filter((plugin) => !plugin.selected).length,
    };
}

export function nextPollDelay(previousDelay) {
    return Math.min(Math.round(previousDelay * 1.5), 5000);
}

export function hasCompletedRestart(previousBootId, capabilities) {
    return Boolean(
        capabilities?.available &&
        capabilities.boot_id &&
        capabilities.boot_id !== previousBootId
    );
}

export function isAllowedBrowserShortcut(event) {
    const key = String(event?.key || "").toLowerCase();
    return Boolean(
        key === "f5" ||
        ((event?.ctrlKey || event?.metaKey) && ["l", "r", "w"].includes(key)) ||
        (event?.altKey && ["arrowleft", "arrowright"].includes(key))
    );
}
