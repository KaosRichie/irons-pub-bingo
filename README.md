# Irons Pub Bingo

A RuneLite plugin for clan bingo events. The host shares a board file; the plugin tracks
drops, kill counts, pets, XP, laps and more on a bingo board in the sidebar.

## Players

1. Enable **Irons Pub Bingo** and open the bingo icon in the sidebar.
2. **Setup → Import board**, then paste the board code from your host — or hit
   **Import from store** if your event uses a team store.
3. Play. Tiles turn amber on progress and green when complete.
4. Click a tile for its goals, who contributed, and its actions (manual tick, credit
   request, reset).

**Team play:** put the team code from your host in the settings, or pick it with
**Choose team**, then **Connect live sync**. Progress combines across the team: counts add
up, distinct item lists count each item once, manual ticks apply team-wide.

Notes:

- Keep the built-in **Loot Tracker** enabled — chest and raid loot comes from its events.
- For tiles chasing a *specific* pet, enable **Collection log - New addition notification**.
- XP and kill-count goals start counting when you import the board.
- Each team keeps its own progress. Changing your team code (or the store toggle) switches
  the board to that team's progress — nothing counts for two teams, and coming back to a
  team restores what you had there.
- Optional: set a **Discord webhook** to post your completions with a screenshot.

## Hosts

1. **Build the board** with [Bingo Forge](https://kaosrichie.github.io/irons-pub-bingo/board-builder.html)
   (source: [docs/board-builder.html](docs/board-builder.html)). Set an
   `id`, `version`, the event `start`/`end` and points, then export the code.
2. **Set up the team store** (~10 minutes, once per event — recommended so progress syncs
   even when players are never online together): blank Google Sheet → Extensions → Apps
   Script → paste [docs/apps-script-store.gs](docs/apps-script-store.gs) → Deploy → Web
   app, *Execute as: Me*, *Who has access: Anyone*. Copy the `/exec` URL.
3. **Fill the sheet**: `/exec` URL into **Settings → Portal URL**, the board code into
   **Board code**, one row per team into **Teams**. The store rejects every sync until
   **Teams** has rows, so fill it before sharing the URL.
4. **Share the `/exec` URL** with the clan. Players turn on *Use team store*, paste the
   URL, then **Import from store** and **Choose team**.
5. Run the event from the sheet. Share the sheet with your **admins only** — players never
   need it, and editors can see everything.

One sheet runs the whole event; teams are kept apart by team code. Without a store, share
the board code and a team code instead — everything else still works over live party sync.

### The sheet

| Tab | What it's for |
|---|---|
| **Board code** | The official board. Players import it from here, and clients running a different board are rejected. |
| **Teams** | Code + display name per team. Fill this first: only listed codes may sync, and it fills the Choose team picker. |
| **Adjustments** | Credit progress by hand. Rows add up; a negative row corrects a mistake. |
| **Requests** | Player credit requests. Set Status to `Done` (writes the ledger row for you) or `Rejected`. |
| **Board \<team\>** | Read-only view per team: the grid, per-goal progress, who contributed what. |
| **Removed** | Who stopped counting. Auto-filled when someone leaves a team — their progress there is parked and returns if they rejoin. Add a row to evict by hand. |
| **Settings** | Portal URL, and `Poll interval (seconds)` to tune how often clients sync. |

Each client talks to the store every 2 minutes — one call both uploads and downloads —
plus once per tile completion and once when you log out. Change that with
`Poll interval (seconds)` on the **Settings** tab: `60` keeps a short event close to live,
a few hundred keeps the traffic down on a long one. It is clamped to 60–900 seconds, and
completions always sync immediately whatever it is set to.

Menu: **Irons Pub Bingo → Open player portal · Refresh board view · Approve/Deny selected
request(s) · Reset store data**.

The `/exec` URL opened in a **browser** is the player portal: live board, request statuses,
and a form to request credit with proof links — for mobile players and anyone without the
plugin.

### Board format

```json
{"name": "Summer Bingo", "id": "summer-2026", "version": 1,
 "start": "2026-08-29T18:00Z", "end": "2026-09-07T20:00Z",
 "size": 5, "linePoints": 10, "blackoutPoints": 50,
 "tiles": [ ... size*size tiles, left-to-right, top-to-bottom ... ]}
```

A tile: `{"label", "description"?, "icon"?, "points"?, "mode": "ALL"|"ANY", "goals": []}`

- `id` — keep it stable. Same id means you can fix a board mid-event without resetting
  anyone: reword labels, swap icons, adjust points, edit tiles in place, and never insert,
  remove or reorder them. Bump `version` so players see they need the new code. Change what
  a tile *tracks* and it counts as a different board — progress starts fresh.
- `start`/`end` — outside the window automatic tracking doesn't count; manual ticks do.
- `icon` — an item name, or a numeric item id for untradeables.

### Goal types

| type | tracks | fields |
|---|---|---|
| `DROP` | item drops | `items`, `sources`?, `count`, `distinct`? |
| `RAID_PURPLE` | raid uniques | `raids` (`COX`/`TOB`/`TOA`), `count` |
| `KC` | kill count of bosses that print one | `npcs`, `count` |
| `KILL` | kills of any NPC — counted from the loot the game gives you, so a shared kill counts once | `npcs`, `count` |
| `PET` | pets received | `pets`?, `count` |
| `XP` | XP since import | `skill`, `amount` |
| `LAP` | agility course laps | `course`, `count` |
| `VALUE` | one loot pile worth X gp | `amount`, `sources`?, `count` |
| `CHAT` | a game message matching a regex | `pattern`, `count` |
| `MANUAL` | nothing — players tick it by hand | — |

Item and NPC names are case-insensitive globs (`Ancient page*`). Add `name` to a goal to
label its progress bar.

Marks of grace are a `DROP` goal with the course as the source. They're read from your
inventory, so they're cheatable — run those tiles on trust, or ask for before/after
screenshots.

A full example: [docs/example-board.json](docs/example-board.json). To try the plugin
without running an event, import [docs/test-board.json](docs/test-board.json) - a 3x3
F2P board whose tiles you can finish around Lumbridge in a few minutes.

### Fairness

- Clients must run the host's exact board code; a locally edited board can't sync.
- Progress belongs to the team it was earned on.
- Credit requests count only once an admin approves them.
- A rebuilt client could still fake numbers — the sheet's per-player audit and your proof
  policy are the backstop.

## Building

`gradlew build` builds the plugin; `gradlew run` starts a dev client with it loaded.
