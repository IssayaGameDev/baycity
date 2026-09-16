# Debug pane

`KEYBOARD_MODE`/`startTpsClient` is called with `debugFolders: []` (ADR 0075): none of the platform's twelve
folders. What remains is the frame meter (platform, always) and the game's two folders, built in `main.ts`.
Kodjo's list; nothing else is added without his word.

## Movement

| Control | Binds | Range | Meaning |
| --- | --- | --- | --- |
| `ground brake m/s²` | `client.tuning.groundBrakeMaxAccel` | 20–1000 | ceiling on losing or redirecting ground speed, at `ACCEL_REF_SPEED` (ADR 0078/0096) |
| `air accel m/s²` | `client.tuning.airMaxAccel` | 10–500 | ceiling on air steering, same reference |
| `air drag /s` | `client.tuning.airDrag` | 0–4 | fraction of horizontal speed lost per airborne second, stick or no stick (ADR 0107) |
| `weight vs speed` | `client.tuning.maxAccelScaling` | 0–1 | how both grow with speed: 0 fixed, 0.5 `√v`, 1 constant time |

The shipped values are in `KEYBOARD_MODE.tuning` (`src/editorMode.ts`) and nowhere else. `weight vs speed` has
no visible effect at low Level: down there the time-based rate is already the slower limit.

Gaining speed has no slider: `groundMaxAccel` is `Infinity`, so a start is instant at every Level.
| `pick speed` | `speedPick.enabled` | on/off | run at a chosen speed instead of Max Speed (stand-in for the real game's picker) |
| `speed studs/s` | `speedPick.studs` | 1–1000 | the pick; capped at Max Speed when applied |

## Progression

| Control | Effect |
| --- | --- |
| Reset experience | `experience = 0`, saved |
| Reset wins | `wins = 0`, saved |
| `grant XP` + **Add experience** | adds the field's amount to Experience, saved |
| `grant Wins` + **Add wins** | adds the field's amount to Wins, saved |

To get a platform folder back for a session, list it in `debugFolders` in `main.ts`:
`camera | sky | touch | movement | render | gait | idle | inertia | head | jointLag | air | death`.

## Frame meter

`frame meter` checkbox at the pane root (platform, ADR 0070): `stats.js` FPS graph, off by default.
