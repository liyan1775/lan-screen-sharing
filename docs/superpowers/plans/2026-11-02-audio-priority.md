# System Audio Priority Implementation Plan

> **For agentic workers:** Use native execution in this ongoing authorized workspace; keep changes scoped and request one fresh code review after implementation.

**Goal:** Allow the broadcaster to send captured system audio regardless of unconfirmed isolation, and give a concrete browser-background performance check.

**Architecture:** Keep the existing capture-to-WebRTC mesh. Make isolation observational rather than an admission gate, remove exact post-capture retries, and keep user control over system sound. Investigate background performance separately from JS display timers.

**Tech Stack:** Go embedded assets, native JavaScript, WebRTC, Node pure tests.

**Spec:** `docs/superpowers/specs/2026-11-02-audio-priority-design.md`

## Global Constraints

- Use `D:\个人项目\局域网屏幕共享`, current feature branch; preserve three pre-existing dirty audit files.
- No service/browser/product launch, real capture, network policy edits, new dependencies or global browser settings changes.
- Do not claim verified isolation from browser settings or claim background performance fixed from pure tests.

## Review Focus

- Unsupported/omitted restriction API still yields a usable shared system-audio track.
- False/unknown audio settings and manual failed checks cannot silently stop system sound.
- Missing system audio, ended capture, leave/late-capture cleanup remain correct.
- Normal combined start must work from the production app click, without a manual-test gate.
- Background state must not change sender targets or be described as a diagnosed network bottleneck.

### Task 1: System audio without isolation gates

Files: `internal/web/assets/media.js`, `system-audio-isolation.js`, `app.js`, `state.js`, `index.html`; tests `media-capture.test.js`, `system-audio-isolation.test.js`, `app-microphone-lifecycle.test.js`.

- [x] Add real production-media regressions for unsupported/false/unknown restriction returning captured audio, watch them fail on 0.2.1.
- [x] Remove unsupported API early rejection and post-capture exact retries; inspect actual settings, keep captured audio and set an advisory status.
- [x] Remove normal-start/manual-pass gate; optional manual checks update isolation status only, add an explicit user stop-system-audio button.
- [x] Exercise the app click path for combined start without verification and failed manual check retaining audio/mic.
- [x] Run focused tests, then the allowed complete pure Node suite; commit owned production/test/spec changes.

### Task 2: Background performance check and distribution

Files: `index.html`, `app.js`, `media-stats.js`; current public guides, README, build/package script and a new release record.

- [x] Add visible Edge per-site/energy-saver instructions and copy-current-page-address action; preserve historical FPS evidence.
- [x] Record foreground/background findings and pending user experiment accurately; do not add unverified capture workarounds.
- [x] Run allowed Go pure tests and compile-only app tests; build Windows 0.2.2 candidate.
- [x] Obtain fresh code review via `superpowers:requesting-code-review`, fix material findings with a red/green regression.
- [x] Preserve 0.2.1 rollback, pin final EXE hash, package 0.2.2, verify ZIP CRC, hashes, PE, encoding, guide links and old artifacts.
- [x] Commit release inputs and deliver concise Chinese links and remaining real-test boundary.
