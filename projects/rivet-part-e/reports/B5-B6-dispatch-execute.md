# B5 + B6 — Dispatch / Execute (agent report, condensed)

| Req | Rung | Key evidence | Missing link |
|---|---|---|---|
| B5.1 | 5 | `DispatchBoard.tsx` day view @ `routes.ts:88`; 26/26 tests pass | — |
| B5.2 | 5 | `DispatchBoard.tsx:584` drag always POSTs /api/proposals, never direct PATCH | — |
| B5.3 | 3 | `ReassignAppointmentExecutionHandler` wired (`handlers.ts:1278`); technician resolver proven (`entity-resolution.test.ts:220-319`) | (1) "assign NAME to JOB" phrasing matches add_crew_member's examples, no fixture pins it; (2) appointmentReference w/o date or stickyJobId falls to `resolveUpcomingAppointment` (`pg-entity-resolver.ts:397-437`) which IGNORES job/customer text — returns soonest tenant-wide |
| B5.4 | 2 | `assignment-notifications.ts` full push+SMS impl, called from `assignment.ts:282,321` — but `TechnicianAssignmentNotifier` NEVER instantiated in app.ts; module instance stays undefined → permanent no-op | wire `new TechnicianAssignmentNotifier` + setter in app.ts |
| B5.5 | 3 | app channel wired (`TechnicianDayView.tsx:510` → `dispatch/routes.ts:262-310`, coordinator `app.ts:4978`) | SMS keyword (no OMW keyword; only out/sick/unavailable) and voice (no en-route intent) both absent — 1 of 3 channels |
| B5.6 | 2 | branded en-route SMS sends (`delay-notifications.ts:139-142,419-452`) but "ETA" = pre-existing scheduled window (:443-447), NOT GPS; pings write-only (zero readers), no computeEta anywhere | GPS→ETA computation does not exist |
| B5.7 | 2 | `computeDispatchLateness` (`dispatch/lateness.ts`) complete, 13/13 unit pass — ZERO production callers | no worker/route invokes it |
| B5.8 | 5 | SMS OUT/SICK/UNAVAILABLE → `from-tech-out.ts:136` cascade reschedule proposals (ready_for_review); registered `app.ts:1883-1904`; `tech-status-sms.test.ts:198` audit [suite-confirmed] | single no_show/cancel doesn't cascade; test lacks cross-tenant negative |
| B5.9 | 0 | zero "license"/"two-person" hits anywhere; electrical.ts has no such concept | absent |
| B6.1 | 3 | min-h-11 on `TechJobView.tsx:458,509,530`; reachable via technician/day | no jsdom class-contract or 320px Playwright test for this screen (mandated pattern) |
| B6.2 | 3 | photo capture real (`TechJobView.tsx:486-545` + `routes/job-photos.ts`) | clock-in gating has ZERO implementation client or server |
| B6.3 | 5 | `log_time_entry` full path; handler isFullyWired (`full-app-voice-handlers.ts:195-239`); real TimeEntryService (`app.ts:2083,1424`); technician assistant test 33/33 pass | — |
| B6.4 | 5 | `packages/mobile/src/offline/` journal+flush, crash-safe; mounted `app/_layout.tsx:24,42`; voice enqueues offline (`useVoiceCapture.ts:62-66`); 27/27 pass | photo capture not in queue (no mobile camera UI); web field surface has no offline queue |

Watchlist: assign_technician confirmed absent as distinct intent; reassign covers B5.3 mechanically but NOT the literal sentence. Offline capture seed WRONG/STALE — mobile implementation real, tested, wired. B5.9 confirmed rung 0.

Deltas: stale comment in assignment-notifications.ts (says SMS deferred; it's implemented — but neither channel wired anyway); voice-action-catalog's reassign example carries "instead of me" disambiguator the PRD sentence lacks; mobile offline subsystem undocumented.
