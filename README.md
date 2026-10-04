# Irons Pub Bingo

A RuneLite plugin for clan bingo events. Your host shares a board. The plugin tracks the
tiles as you play and adds up progress across your team. It tracks drops, boss kill
counts, pets, XP, agility laps, loot value and chat messages.

## Getting started

1. Enable **Irons Pub Bingo** and open the bingo icon in the sidebar.
2. In the plugin settings, turn on **Use team store** and paste the store URL from your
   host.
3. In the panel, press **Import board from store**.
4. Press **Choose team** and pick your team.
5. Play. Tiles turn amber on progress and green when complete.

The **Get started** card in the panel always shows the next step. If your event has no
store, use **Import board** to paste the board code and put your team code in the
settings. The **?** button in the panel opens the in-game help.

## Tiles and credit requests

Click a tile to see its goals, who contributed what, and its actions.

The tracker can miss progress, for example drops on mobile or kills from before you
imported the board. Open the tile's **Actions** and press **Request admin credit**. Add
the amount and a link to a screenshot as proof. With a Discord webhook set, the plugin
can take the screenshot, post it and attach its link for you. An admin reviews the
request. Approved credit counts for the whole team.

The store URL opened in a browser is the player portal. It shows the live board and all
requests. Mobile players can file requests there. They pick their name from the players
who have synced to that team, so sync once with the plugin first.

## Good to know

- Keep the built-in **Loot Tracker** enabled. Drops, chests and raid loot come from it.
- For pet tiles, turn on the game setting **Collection log - New addition notification**.
  Specific pet tiles need it, and it names the pet on any-pet tiles.
- XP and kill count goals start counting when you import the board.
- When your host publishes a newer board, the panel and an overlay in game say so.
  Reimport it from the store. The **New board overlay** setting turns the overlay off.
- Each team keeps its own progress. Switching teams parks it, switching back restores it.
- Discord: set a **Webhook URL** and turn on **Post completions to Discord** to post your
  completed tiles with a screenshot.

## Privacy

The team store and the Discord posts are off by default. When you turn them on, the
plugin sends your in-game name, your bingo progress and a hashed account id to the store
URL your host gave you, and messages with screenshots to your own Discord webhook. These
servers are run by your host and Discord, not by RuneLite, and they see your IP address.
Live sync with online teammates uses RuneLite's party service.

## Hosting an event

1. **Build the board** in [Bingo Forge](https://kaosrichie.github.io/irons-pub-bingo/board-builder.html)
   (source: [board-builder.html](docs/board-builder.html)). It runs in your browser. Set
   an `id`, `version`, the event `start`/`end` and points, then export the code.
2. **Set up a team store.** It syncs progress even when players are never online
   together. Pick one of the two options below.
3. **Add your teams and the board code** to the store. The store rejects every sync
   until it has teams, so do this before you share the URL.
4. **Share the store URL** with the clan.

Without a store, share the board code and a team code instead. Everything else works over
live party sync.

### Option 1: Google Sheet

About 10 minutes, once per event.

1. Blank Google Sheet, Extensions, Apps Script. Paste
   [apps-script-store.gs](docs/apps-script-store.gs).
2. Deploy as a Web app with *Execute as: Me* and *Who has access: Anyone*. Copy the
   `/exec` URL. That is the store URL.
3. Reload the sheet. Put the `/exec` URL in **Settings → Portal URL**, the board code in
   **Board code**, and one row per team in **Teams**.
4. Share the sheet with your **admins only**. Players never need it.

After you edit the script, redeploy it as a new version. Saving alone keeps serving the
old code.

| Tab | What it's for |
|---|---|
| **Board code** | The official board. Players import it from here. Clients running a different board are rejected. |
| **Teams** | Code and display name per team. Only listed codes can sync, and it fills the Choose team picker. The optional Webhook column is a Discord webhook that announces approved credit to the team. |
| **Adjustments** | Credit progress by hand. Rows add up. A negative row corrects a mistake. |
| **Requests** | Player credit requests. Set Status to `Done` to approve (it writes the Adjustments row) or `Rejected`. Rejecting an approved request takes the credit back. |
| **Board \<team\>** | Read-only view per team: the grid, per-goal progress, who contributed what, and when each member last synced. |
| **Removed** | Who stopped counting. Filled in when someone leaves a team. Their progress is parked and returns if they rejoin. Add a row to remove someone by hand. |
| **Settings** | Portal URL, and `Poll interval (seconds)`. |

The **Irons Pub Bingo** menu has: Open player portal, Refresh board view, Approve/Deny
selected request(s), Apply pasted board update, Reset a tile's progress, and Reset store
data. For a tile reset, first select the tile on its Board tab.

Approvals are announced on the team's webhook. This needs one extra Google permission.
After deploying, run the menu's Approve action once and accept the prompt. Approvals made
with the Status dropdown can't post to Discord directly. They go out with the next player
sync.

### Option 2: Cloudflare Worker

The same store, run as a Cloudflare Worker on a free account. You manage the event on an
admin page instead of a sheet. Bingo Forge can send the board straight to it. See
[cloudflare-store/README.md](cloudflare-store/README.md) for setup.

### Sync timing

Each client syncs every 2 minutes, plus once per tile completion and once on logout. One
call both uploads and downloads. Change it with `Poll interval (seconds)` in the store's
settings, from 60 to 900. Use 60 for a short event and a few hundred for a long one.

### Board format

```json
{"name": "Summer Bingo", "id": "summer-2026", "version": 1,
 "start": "2026-08-29T18:00Z", "end": "2026-09-07T20:00Z",
 "size": 5, "linePoints": 10, "blackoutPoints": 50, "diagonals": true,
 "tiles": [ ... size*size tiles, left-to-right, top-to-bottom ... ]}
```

A tile: `{"label", "description"?, "icon"?, "points"?, "mode": "ALL"|"ANY", "goals": []}`

- `id`: keep it stable. The same id lets you edit a live board without resetting
  progress. Edit tiles in place. Never insert, remove or reorder them. Bump `version` so
  players see they need the new code. A new id is a new board with fresh progress.
- Changing what a tile tracks resets that tile's progress. Relabeling it or changing its
  target keeps it. The store resets its stored progress for that tile on the next sync,
  or right away with **Apply pasted board update** (sheet) or **Save and apply**
  (Cloudflare admin page).
- `start`/`end`: outside this window automatic tracking doesn't count. Manual ticks do.
- `diagonals`: set `false` and only rows and columns count as lines.
- `icon`: an item name, or a numeric item id for untradeables.
- Any goal takes `"screenshot": true` to post each step of its progress with a screenshot
  to the player's Discord webhook.

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

- Item and NPC names are case-insensitive globs (`Ancient page*`).
- `name` labels a goal's progress bar.
- `itemIds` matches exact ids, for items that share a name with something else.
- `regions` limits a chat goal to certain map regions. Find region ids on the
  [region map](https://kaosrichie.github.io/irons-pub-bingo/region-map.html).
- `loot` lists which loot kinds count: any of `"KILL"`, `"PICKPOCKET"` and `"OTHER"`
  (chests, caskets, events). Left out, everything counts.

Drop and loot value goals only count what RuneLite's Loot Tracker sees. Most thieving
chests don't show up there. A chat goal with `regions` often covers what the tracker
misses.

Marks of grace are a `DROP` goal with the course as the source. They are read from your
inventory, so they can be cheated. Run those tiles on trust, or ask for before and after
screenshots.

A full example: [example-board.json](docs/example-board.json). To try the plugin without
an event, import [test-board.json](docs/test-board.json). It is a 3x3 F2P board you can
finish around Lumbridge in a few minutes.

### Fairness

- Clients must run the host's exact board code. A locally edited board can't sync.
- Progress belongs to the team it was earned on.
- Credit requests count only once an admin approves them.
- Each client proves which account it syncs for, so the store URL alone can't change
  another player's progress. On the sheet, if a player is ever locked out, clear their
  key cell on the hidden Store tab.
- A modified client could still fake numbers. The per-player view and your proof policy
  are the backstop.
