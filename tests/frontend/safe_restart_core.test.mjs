import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    hasCompletedRestart,
    isAllowedBrowserShortcut,
    nextPollDelay,
    pluginSelectionCounts,
    queueCounts,
    selectedPluginIds,
} from "../../js/safe_restart_core.mjs";

const stylesheet = await readFile(
    new URL("../../js/safe_restart.css", import.meta.url),
    "utf8",
);
const frontend = await readFile(
    new URL("../../js/safe_restart.js", import.meta.url),
    "utf8",
);
test("queueCounts tolerates missing queue data", () => {
    assert.deepEqual(queueCounts(undefined), { running: 0, pending: 0 });
});

test("poll backoff is bounded", () => {
    assert.equal(nextPollDelay(500), 750);
    assert.equal(nextPollDelay(4000), 5000);
    assert.equal(nextPollDelay(5000), 5000);
});

test("restart completion requires a different boot id", () => {
    assert.equal(hasCompletedRestart("old", { available: true, boot_id: "old" }), false);
    assert.equal(hasCompletedRestart("old", { available: true, boot_id: "new" }), true);
    assert.equal(hasCompletedRestart("old", null), false);
});

test("restart lock permits browser recovery shortcuts but blocks workflow keys", () => {
    assert.equal(isAllowedBrowserShortcut({ key: "F5" }), true);
    assert.equal(isAllowedBrowserShortcut({ key: "r", ctrlKey: true }), true);
    assert.equal(isAllowedBrowserShortcut({ key: "ArrowLeft", altKey: true }), true);
    assert.equal(isAllowedBrowserShortcut({ key: "Delete" }), false);
    assert.equal(isAllowedBrowserShortcut({ key: "z", ctrlKey: true }), false);
});

test("plugin selection always preserves protected entries", () => {
    const plugins = [
        { id: "Plugin-A", selectable: true, selected: false, protected: false },
        { id: "Plugin-B", selectable: true, selected: true, protected: false },
        { id: "Safe-Restart", selectable: false, selected: true, protected: true },
        { id: "Disabled.disabled", selectable: false, selected: false, protected: false },
    ];

    assert.deepEqual(selectedPluginIds(plugins), ["Plugin-B", "Safe-Restart"]);
    assert.deepEqual(pluginSelectionCounts(plugins), { load: 2, excluded: 1 });
});

test("restart feedback survives ComfyUI's global animation limiter", () => {
    assert.match(
        stylesheet,
        /body\.disable-animations \.andreszs-safe-restart-beacon\s*\{[^}]*animation-duration:\s*1\.6s !important;/s,
    );
    assert.match(
        stylesheet,
        /body\.disable-animations \.andreszs-safe-restart-telemetry > span\s*\{[^}]*animation-duration:\s*1\.7s !important;/s,
    );
});

test("restart completion freezes the beacon and telemetry in green", () => {
    assert.match(
        stylesheet,
        /--safe-restart-green:\s*#35ff88;/,
    );
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-complete \.andreszs-safe-restart-beacon,[^}]*\.andreszs-safe-restart-complete \.andreszs-safe-restart-telemetry > span\s*\{[^}]*var\(--safe-restart-green\)[^}]*opacity:\s*1;[^}]*animation:\s*none !important;/s,
    );
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-complete \.andreszs-safe-restart-trace > div,[^}]*\.andreszs-safe-restart-complete \.andreszs-safe-restart-trace-index,[^}]*\.andreszs-safe-restart-complete \.andreszs-safe-restart-trace b,[^}]*var\(--safe-restart-green\)/s,
    );
});

test("telemetry animation changes brightness without resizing blocks", () => {
    const telemetryKeyframes = stylesheet.match(
        /@keyframes andreszs-safe-restart-telemetry\s*\{(?<body>[\s\S]*?)\n\}/,
    );
    assert.ok(telemetryKeyframes);
    assert.doesNotMatch(telemetryKeyframes.groups.body, /transform:/);
});

test("hologram theme keeps the workspace visible behind frosted glass", () => {
    assert.match(stylesheet, /rgb\(3 12 18 \/ 78%\);/);
    assert.match(stylesheet, /backdrop-filter:\s*blur\(18px\) saturate\(125%\);/);
    assert.match(stylesheet, /--safe-restart-cyan:\s*#00e5ff;/);
});

test("boot cascade reveals status modules quickly without delaying restart", () => {
    assert.match(frontend, /function playBootCascade\(element, \{ animateShell = true \} = \{\}\)/);
    assert.match(frontend, /playBootCascade\(element, \{ animateShell: selector === null \}\);/);
    assert.match(
        frontend,
        /await showRestarting\(safeReboot, overlay\);\s*await submitRestart\(capabilities, enabledPlugins\);/s,
    );
    assert.match(frontend, /delay:\s*190 \+ \(index \* 60\)/);
    assert.match(frontend, /delay:\s*470,\s*duration:\s*120/);
});

test("plugin matrix morphs into the existing restart shell", () => {
    assert.match(frontend, /enabledPlugins:\s*selectedPluginIds\(plugins\),\s*element:\s*selector/s);
    assert.match(frontend, /card\.className = "andreszs-safe-restart-card"/);
    assert.match(frontend, /card\.innerHTML = restartStatusMarkup\(\)/);
    assert.match(frontend, /duration:\s*310/);
    assert.match(frontend, /width:\s*`\$\{startRect\.width\}px`, height:\s*`\$\{startRect\.height\}px`/);
    assert.match(frontend, /width:\s*`\$\{targetRect\.width\}px`, height:\s*`\$\{targetRect\.height\}px`/);
    assert.match(stylesheet, /\.andreszs-safe-restart-selector-card\s*\{[^}]*box-sizing:\s*border-box/s);
});

test("every Restart click opens the selective plugin matrix", () => {
    assert.match(frontend, /requestRestart\(actionButton\)/);
    assert.doesNotMatch(frontend, /event\.ctrlKey/);
    assert.match(frontend, /function showPluginSelector\(inventory, queue\)/);
    assert.match(frontend, /safe_mode:\s*true, enabled_plugins:\s*enabledPlugins/);
    assert.match(frontend, /data-selector-toggle-all/);
    assert.match(frontend, /Define restart directive/);
    assert.doesNotMatch(frontend, /Ctrl\+Click/);
    assert.doesNotMatch(frontend, /actionButton\.title\s*=/);
});

test("one contextual control toggles the entire selectable plugin set", () => {
    assert.match(frontend, /data-selector-toggle-all>Disable all<\/button>/);
    assert.match(frontend, /toggleAll\.textContent = allSelected \? "Disable all" : "Enable all"/);
    assert.match(frontend, /toggleAll\.dataset\.action = allSelected \? "disable" : "enable"/);
    assert.match(frontend, /const enabled = toggleAll\.dataset\.action === "enable"/);
    assert.doesNotMatch(frontend, /data-selector-enable/);
    assert.doesNotMatch(frontend, /data-selector-disable/);
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-selector-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(10rem, 1fr\) auto/s,
    );
});

test("plugin choices reset to the original profile on every opening", () => {
    assert.match(frontend, /\.filter\(\(plugin\) => plugin\.selectable \|\| plugin\.protected\)/);
    assert.match(frontend, /selected:\s*true/);
    assert.match(frontend, /safeReboot:\s*totals\.excluded > 0/);
    assert.match(frontend, /enabledPlugins = safeReboot \? selection\.enabledPlugins : null/);
});

test("plugin matrix omits entries that are already disabled", () => {
    assert.match(frontend, /plugin\.selectable \|\| plugin\.protected/);
    assert.doesNotMatch(frontend, /filter\(\(plugin\) => plugin\.active \|\|/);
});

test("currently excluded plugins are staged for the next restart", () => {
    assert.match(frontend, /item\.plugin\.state === "excluded" \? "staged" : "active"/);
    assert.match(frontend, /Disabled now; enabled on next restart/);
    assert.match(stylesheet, /\.andreszs-safe-restart-plugin-state\.is-staged\s*\{[^}]*#ffb454/s);
});

test("new selector helpers cannot prevent the Restart extension from loading", () => {
    assert.match(frontend, /import \* as restartCore from "\.\/safe_restart_core\.mjs"/);
    assert.match(frontend, /restartCore\.PLUGINS_ROUTE \|\| "\/safe-restart\/plugins"/);
    assert.doesNotMatch(frontend, /import\s*\{[^}]*PLUGINS_ROUTE[^}]*\}\s*from/s);
});

test("plugin matrix uses compact labels and full-width footer actions", () => {
    assert.match(frontend, /RESTART CONTROL \/ PLUGIN MATRIX/);
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-plugin-row\s*\{[^}]*min-height:\s*2\.65rem;[^}]*padding:\s*0\.2rem 0\.55rem/s,
    );
    assert.match(frontend, />Define restart directive<\/h2>/);
    assert.match(frontend, /placeholder="Filter nodes…"/);
    assert.match(frontend, /data-selector-cancel>CANCEL</);
    assert.match(frontend, /data-selector-confirm>RESTART</);
    assert.doesNotMatch(frontend, /data-selector-confirm[^>]*>[^<]*<i/);
    assert.doesNotMatch(frontend, /Turn off any custom nodes/);
    assert.match(frontend, /plugin\.locations > 1 \? `\$\{plugin\.locations\} locations` : ""/);
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-selector-card footer\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s,
    );
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-selector-card footer button\s*\{[^}]*width:\s*100%/s,
    );
});

test("plugin matrix shares the restart frame and offers a subtle close action", () => {
    assert.match(frontend, /data-selector-close aria-label="Close">×<\/button>/);
    assert.match(frontend, /\[data-selector-close\]"\)\.addEventListener\("click", close\)/);
    assert.match(
        frontend,
        /PROFILE APPLIES TO NEXT RESTART ONLY/,
    );
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-card::before,[\s\S]*\.andreszs-safe-restart-selector-card::before,[\s\S]*\.andreszs-safe-restart-selector-card::after\s*\{/,
    );
    assert.match(stylesheet, /\.andreszs-safe-restart-selector button\.andreszs-safe-restart-selector-close\s*\{/);
    assert.match(stylesheet, /\.andreszs-safe-restart-card\s*\{[^}]*width:\s*min\(30rem, 92vw\)/s);
    assert.match(stylesheet, /\.andreszs-safe-restart-selector-card\s*\{[^}]*width:\s*min\(30rem, 92vw\)/s);
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-selector-kicker\s*\{[^}]*font-size:\s*1rem;[^}]*font-weight:\s*500;[^}]*letter-spacing:\s*0\.075em/s,
    );
});

test("plugin summary alternates counts and the one-restart notice", () => {
    assert.match(frontend, /data-selector-counts/);
    assert.match(frontend, /data-selector-profile>PROFILE APPLIES TO NEXT RESTART ONLY/);
    assert.match(frontend, /summaryInterval = window\.setInterval\(animateSummary, 2800\)/);
    assert.match(frontend, /stopSummaryCycle\(\)/);
    assert.doesNotMatch(frontend, /andreszs-safe-restart-selector-note/);
    assert.match(
        stylesheet,
        /\.andreszs-safe-restart-selector-status > span\s*\{[^}]*grid-area:\s*1 \/ 1/s,
    );
});

test("empty plugin searches show a pulsing tactical warning", () => {
    assert.match(frontend, /<strong>NO TARGETS FOUND<\/strong>/);
    assert.match(frontend, /showNoResults\(query\.length > 0 && matches === 0\)/);
    assert.match(frontend, /noResultsSignal\.animate\(\[/);
    assert.match(frontend, /duration:\s*1050/);
    assert.match(frontend, /iterations:\s*Infinity/);
    assert.match(stylesheet, /\.andreszs-safe-restart-no-results\s*\{[^}]*border:\s*1px solid rgb\(255 68 92 \/ 48%\)/s);
    assert.match(stylesheet, /\.andreszs-safe-restart-no-results\[hidden\]\s*\{[^}]*display:\s*none/s);
});

test("status header distinguishes normal server restart from safe restart", () => {
    assert.match(frontend, /PLEASE STAND BY/);
    assert.match(frontend, /LINK RESTORED/);
    assert.doesNotMatch(frontend, /AWAITING NEW INSTANCE/);
    assert.match(frontend, /`\$\{safeReboot \? "SAFE" : "SERVER"\} RESTART \/ BOOT TRACE`/);
    assert.match(frontend, /`\$\{safeReboot \? "SAFE" : "SERVER"\} RESTART \/ SYSTEM ONLINE`/);
    assert.match(frontend, /showRestarting\(safeReboot\)/);
    assert.match(frontend, /reloadAfterRestart\(overlay, safeReboot\)/);
});
