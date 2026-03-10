# Component Test Matrix (Knowledge Portal UI)

Scope: `web/public/index.html` behavior covered by `web/public/index.component.test.js` and future component tests.

Status legend:
- ✅ Covered
- 🟡 Partial
- ❌ Not covered yet

---

## Happy Path Matrix

| ID | User Journey / Behavior | Expected Outcome | Current Status | Current Test | Notes / Next Test |
|---|---|---|---|---|---|
| HP-01 | App boot initializes UI | Source dropdown loads with API data | ✅ | `loads source options on init` | Keep as baseline smoke test |
| HP-02 | Select source=telegram | Channels and topic list load | ✅ | `loads telegram topics and renders selected topic messages` | Asserts topic list visible + content |
| HP-03 | Click a topic in topic list | Topic becomes current; view loads | ✅ | `loads telegram topics and renders selected topic messages` | Covered via topic row click |
| HP-04 | Render layer header/title | Header shows topic/layer title | ✅ | `loads telegram topics and renders selected topic messages` | Header contains topic name |
| HP-05 | Render message list | Messages render in `#messages` | ✅ | `loads telegram topics and renders selected topic messages` | Verifies message content text |
| HP-06 | Channel dropdown direct selection | Selecting channel loads view | ✅ | `loads view when selecting channel from channel dropdown` | Covered via `#channel-select` change |
| HP-07 | Tree node click navigation | Clicking tree node switches layer | ✅ | `supports tree-node click navigation to child layer` | Explicit tree click path covered |
| HP-08 | Branch badge navigation | Click `→ B` badge opens child layer | ✅ | `navigates to child layer via branch badge and can go back via header link` | Badge click verified |
| HP-09 | Back-link navigation | Back-link returns to parent and focuses msg | ✅ | `navigates to child layer via branch badge and can go back via header link` | Back-link flow covered |
| HP-10 | Save/restore last viewed layer | Per topic layer is restored from localStorage | ✅ | `restores valid saved layer from localStorage` + `falls back to current layer when saved layer id is stale` | Both valid-restore and stale-fallback paths covered |

| HP-11 | Rich markdown render | Markdown converted and sanitized | 🟡 | Indirect only | Add explicit assertions for markdown formatting |
| HP-12 | Entity-based render path | PRE entities become fenced code blocks | ❌ | — | Feed `entities` in mocked message and assert code card |
| HP-13 | Copy code button success | Clipboard gets code text, button shows ✓ briefly | ❌ | — | Mock `navigator.clipboard.writeText` success |
| HP-14 | Theme auto-apply | Dark class toggles by hour | ❌ | — | Mock `Date` hour and assert `body.dark` toggle |

---

## Negative / Edge Path Matrix

| ID | Failure / Edge Case | Expected Outcome | Current Status | Current Test | Notes / Next Test |
|---|---|---|---|---|---|
| NG-01 | `/api/sources` fails/rejects | UI doesn’t crash; fallback remains visible | ❌ | — | Add fetch rejection test around init path |
| NG-02 | Channels API returns empty list | Channel select stays with placeholder | ❌ | — | Assert no extra options |
| NG-03 | Topics API returns empty | Topic list visible but empty (or hidden by design) | ❌ | — | Clarify desired UX then test |
| NG-04 | View API missing/invalid `tree` | App avoids crash; tree empty state handled | ❌ | — | Mock malformed response |
| NG-05 | Saved layer missing in state | Fallback to `viewState.currentLayerId` | ✅ | `falls back to current layer when saved layer id is stale` | Stale localStorage id branch covered |
| NG-06 | `showLayer` with unknown layerId | No crash; current view preserved | ❌ | — | Call path via crafted tree click |
| NG-07 | Empty layer messages | Shows "No messages in this layer" | ✅ | `shows empty state when selected layer has no messages` | Empty layer branch covered |
| NG-08 | Markdown renderer throws | Falls back to escaped plaintext | ❌ | — | Make markdown mock throw in `render` |
| NG-09 | Clipboard write fails | No crash; button state remains safe | ❌ | — | Reject `writeText` promise |
| NG-10 | API returns non-string channel objects missing fields | UI handles defaults without crash | ❌ | — | Return malformed channel entries |
| NG-11 | Message has invalid timestamp | Time render degrades gracefully | ❌ | — | Use bad ts and assert output exists |
| NG-12 | LocalStorage inaccessible (throws) | Save/get layer quietly no-op | ❌ | — | Mock localStorage get/set throw |
| NG-13 | Tree node with deep nesting collapsed | Expand/collapse toggles correctly | ❌ | — | Assert `+ / −` behavior and child visibility |
| NG-14 | App path prefix handling (`appBasePath`) | API calls include prefix correctly | ❌ | — | Set `window.location.pathname` and assert fetch URLs |

---

## Suggested Next Batch (priority order)

1. HP-06 Channel dropdown change flow
2. HP-08 Branch badge navigation
3. HP-09 Back-link parent jump + focus
4. NG-07 Empty layer UI
5. NG-05 Stale saved layer fallback
6. NG-09 Clipboard failure safety
7. NG-08 Markdown throw fallback
8. NG-14 appBasePath-prefixed API URLs

---

## Exit Criteria Proposal

- All Happy Path IDs HP-01..HP-10 = ✅
- At least 8 Negative IDs NG-01..NG-14 = ✅
- `index.component.test.js` remains deterministic (no network, no timers leakage)
- Coverage for UI script lines >= 90% and branch >= 80%
