# Changelog

All notable changes to this project will be documented here.

## [0.1.1] - 2026-07-22

### Changed

- Matched the plugin matrix width to the Boot Trace display.
- Updated the plugin matrix screenshot and animated Registry banner.

## [0.1.0] - 2026-07-22

### Added

- Queue-aware restart confirmation using ComfyUI's native dialog.
- Per-boot restart token, same-origin checks, JSON-only POST, and concurrent-request lock.
- Backend process replacement with the original Python interpreter and arguments, suppressing ComfyUI's automatic second browser tab.
- Animated Boot Trace overlay with sequential telemetry blocks, elapsed time, boot ID polling, automatic reconnection, and recovery actions.
- Temporary workflow interaction lock while the backend is restarting.
- Native sidebar styling with an isolated compatibility layer that places Restart above Help.
- Selective safe reboot matrix with plugin search, active and disabled states, bulk controls, and a protected Restart Control entry.
- Restart Control branding and directory name, replacing the original Safe Restart project name.
