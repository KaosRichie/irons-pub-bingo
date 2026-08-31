# Irons Pub Bingo

A RuneLite plugin for clan bingo events. Your host shares a board, the plugin tracks the
tiles as you play and combines progress across your team. It tracks drops, boss kill
counts, pets, XP, agility laps, loot value and chat messages.

## Getting started

1. Enable **Irons Pub Bingo** and open the bingo icon in the sidebar.
2. In the plugin settings, turn on **Use team store** and paste the store URL from your
   host.
3. **Setup → Import board → Import from store**.
4. **Setup → Choose team** and pick your team.
5. Play. Tiles turn amber on progress and green when complete.

While you set up, the Store line in the Team section shows which step is still missing.
If your event has no store, import the board code by hand instead and put your host's
team code in the settings.

## Tiles and credit requests

Click a tile to see its goals, who contributed what, and its actions.

The tracker can miss progress, for example drops on mobile or kills from before you
imported the board. Use **Request admin credit** on the tile and link a screenshot as
proof. An admin reviews it, and approved credit counts for the whole team. The store URL
opened in a browser is the player portal. It shows the live board and all requests, and
mobile players can file requests there.

## Good to know

- Keep the built-in **Loot Tracker** enabled. Chest and raid loot comes from its events.
- For specific pet tiles, enable **Collection log - New addition notification**.
- XP and kill-count goals start counting when you import the board.
- Each team keeps its own progress. Switching teams parks it, switching back restores it.
- Optional: set a **Discord webhook** to post your completions with a screenshot.

## Hosting an event

1. **Build the board** with [Bingo Forge](https://kaosrichie.github.io/irons-pub-bingo/board-builder.html)
   (source: [board-builder.html](docs/board-builder.html)). Set an `id`, `version`, the
   event `start`/`end` and points, then export the code. For chat goal region ids, use
   the [region map](https://kaosrichie.github.io/irons-pub-bingo/region-map.html).
2. **Set up the team store**, once per event, about 10 minutes. It syncs progress even
   when players are never online together. Blank Google Sheet → Extensions → Apps
   Script → paste [apps-script-store.gs](docs/apps-script-store.gs) → Deploy → Web app,
   *Execute as: Me*, *Who has access: Anyone*. Copy the `/exec` URL.
3. **Fill the sheet**: `/exec` URL into **Settings → Portal URL**, the board code into
   **Board code**, one row per team into **Teams**. The store rejects every sync until
   **Teams** has rows, so fill it before sharing the URL.
4. **Share the `/exec` URL** with the clan.
5. Run the event from the sheet. Share the sheet with your **admins only**. Players never
   need it.

One sheet runs the whole event. Teams are kept apart by team code. Without a store, share
the board code and a team code instead. Everything else works over live party sync.

### The sheet

| Tab | What it's for |
|---|---|
| **Board code** | The official board. Players import it from here. Clients running a different board are rejected. |
| **Teams** | Code + display name per team. Fill this first. Only listed codes may sync, and it fills the Choose team picker. |
| **Adjustments** | Credit progress by hand. Rows add up. A negative row corrects a mistake. |
| **Requests** | Player credit requests. Set Status to `Done` (writes the ledger row for you) or `Rejected`. |
| **Board \<team\>** | Read-only view per team: the grid, per-goal progress, who contributed what, and when each member last synced. |
| **Removed** | Who stopped counting. Auto-filled when someone leaves a team. Their progress is parked and returns if they rejoin. Add a row to evict by hand. |
| **Settings** | Portal URL, and `Poll interval (seconds)` to tune how often clients sync. |

Each client talks to the store every 2 minutes, plus once per tile completion and once on
logout. One call both uploads and downloads. Tune it with `Poll interval (seconds)` on the
**Settings** tab, clamped to 60 to 900. Use 60 for a short event, a few hundred for a long
one. Completions always sync immediately.

Menu: **Irons Pub Bingo → Open player portal · Refresh board view · Approve/Deny selected
request(s) · Reset store data**.

### Board format

```json
{"name": "Summer Bingo", "id": "summer-2026", "version": 1,
 "start": "2026-08-29T18:00Z", "end": "2026-09-07T20:00Z",
 "size": 5, "linePoints": 10, "blackoutPoints": 50, "diagonals": true,
 "tiles": [ ... size*size tiles, left-to-right, top-to-bottom ... ]}
```

A tile: `{"label", "description"?, "icon"?, "points"?, "mode": "ALL"|"ANY", "goals": []}`

- `id`: keep it stable. Same id lets you edit a live board without resetting progress,
  even what a tile tracks. Edit tiles in place, never insert, remove or reorder them.
  Bump `version` so players see they need the new code. A new id is a new board with
  fresh progress.
- `start`/`end`: outside the window automatic tracking doesn't count, manual ticks do.
- `diagonals`: set `false` and only rows and columns count as lines.
- `icon`: an item name, or a numeric item id for untradeables.
- Any goal takes `"screenshot": true` to post its progress and a screenshot to the
  player's Discord webhook as it happens.

### Goal types

| type | tracks | fields |
|---|---|---|
| `DROP` | item drops, pickpockets included | `items`, `itemIds`?, `sources`?, `loot`?, `count`, `distinct`? |
| `RAID_PURPLE` | raid uniques | `raids` (`COX`/`TOB`/`TOA`), `count`, `distinct`? |
| `KC` | kill count of bosses that print one | `npcs`, `count` |
| `KILL` | kills of any NPC, a shared kill counts once | `npcs`, `count` |
| `PET` | pets received | `pets`?, `count` |
| `XP` | XP since import | `skill`, `amount` |
| `LAP` | agility course laps | `course`, `count` |
| `VALUE` | one loot pile worth X gp | `amount`, `sources`?, `loot`?, `count` |
| `CHAT` | a game message matching a regex | `pattern`, `regions`?, `count` |
| `MANUAL` | nothing, players tick it by hand | none |

Item and NPC names are case-insensitive globs (`Ancient page*`). Add `name` to a goal to
label its progress bar. `itemIds` matches exact ids, for items that share a name with
something else. `regions` limits a chat goal to certain map regions. `loot` lists which
loot kinds a drop or loot value goal counts, any subset of `"KILL"`, `"PICKPOCKET"` and
`"OTHER"` (chests, caskets, events). Omitted, everything counts.

Drop and loot value goals only count what RuneLite's Loot Tracker sees. If loot doesn't
show up there, it can't count here. Most thieving chests are like this. A chat goal with
`regions` often covers what the tracker misses.

Marks of grace are a `DROP` goal with the course as the source. They're read from your
inventory, so they're cheatable. Run those tiles on trust, or ask for before/after
screenshots.

A full example: [example-board.json](docs/example-board.json). To try the plugin without
an event, import [test-board.json](docs/test-board.json). It is a 3x3 F2P board you can
finish around Lumbridge in a few minutes.

### Fairness

- Clients must run the host's exact board code. A locally edited board can't sync.
- Progress belongs to the team it was earned on.
- Credit requests count only once an admin approves them.
- A rebuilt client could still fake numbers. The sheet's per-player audit and your proof
  policy are the backstop.
