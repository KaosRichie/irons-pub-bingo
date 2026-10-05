# Irons Pub Bingo: full Readme

The short version is the [Readme](../README.md).

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
- XP and kill count goals count from the event start, or from when you import the board
  if that's later.
- When your host publishes a newer board, the panel says so. Reimport it from the store.
- The in-game overlay can show the event countdown, store and live sync problems,
  and tiles you pinned. Right-click a tile on the board to pin it. Each part has its own
  switch under **In-game Overlay** in the settings.
- Each team keeps its own progress. Switching teams parks it, switching back restores it.
- Completed lines are drawn as red strokes through their tiles. **Line style** set to
  **Highlight** outlines the tiles instead. **Line color** picks the color for both.
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
   (source: [board-builder.html](board-builder.html)). It runs in your browser. Set
   an `id`, `version`, the event `start`/`end` and points, then export the code.
2. **Set up a team store.** It syncs progress even when players are never online
   together. It runs as a Cloudflare Worker on a free account. Follow
   [cloudflare-store/README.md](../cloudflare-store/README.md). It takes about 10 minutes.
3. **Open the event's admin page** and add your teams and the board code. Bingo Forge can
   also send the board straight to it. The store accepts no syncs until it has teams, so
   do this before you share the URL.
4. **Share the event URL** with the clan. It is the store URL for the plugin settings,
   and the player portal in a browser.

Without a store, share the board code and a team code instead. Everything else works over
live party sync.

On the admin page you review credit requests, give credit by hand, see each team's board
and who contributed what, reset a tile, and change the sync interval. Approved credit is
announced on the team's Discord webhook if it has one.

### Sync timing

Each client syncs every 2 minutes, plus once per tile completion and once on logout. One
call both uploads and downloads. Change the interval on the admin page's Settings, from
60 to 900 seconds. Use 60 for a short event and a few hundred for a long one.

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
  target keeps it. The store resets its stored progress for that tile when you press
  **Save and apply** on the admin page.
- `start`/`end`: outside this window automatic tracking doesn't count. Manual ticks do.
- `diagonals`: set `false` and only rows and columns count as lines.
- `icon`: an item name, or a numeric item id for untradeables.
- Any goal except `XP` and `MANUAL` takes `"screenshot": true`. Each step of its progress
  then posts a screenshot to the player's Discord webhook, if they post completions there.

### Goal types

| type | tracks | fields |
|---|---|---|
| `DROP` | item drops, pickpockets included | `items` and/or `itemIds`, `sources`?, `loot`?, `count`?, `distinct`? |
| `RAID_PURPLE` | raid uniques | `raids`? (`COX`/`TOB`/`TOA`), `count`?, `distinct`? |
| `KC` | kill count of bosses that print one | `npcs`, `count`? |
| `KILL` | kills of any NPC, a shared kill counts once | `npcs`, `count`? |
| `PET` | pets received | `pets`?, `count`? |
| `XP` | XP since import | `skill`, `amount` |
| `LAP` | agility course laps | `course`, `count`? |
| `VALUE` | one loot pile worth X gp | `amount`, `sources`?, `loot`?, `count`? |
| `CHAT` | a game message matching a regex | `pattern`, `regions`?, `count`? |
| `MANUAL` | nothing, players tick it by hand | none |

- Fields marked `?` are optional. `count` defaults to 1.
- Item and NPC names are case-insensitive globs (`Ancient page*`).
- `name` labels a goal's progress bar.
- `itemIds` matches exact ids, for items that share a name with something else. A `DROP`
  goal needs `items`, `itemIds` or both.
- `raids` left out counts all three raids.
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

A full example: [example-board.json](example-board.json). To try the plugin without
an event, import [test-board.json](test-board.json). It is a 3x3 F2P board you can
finish around Lumbridge in a few minutes.

### Fairness

- Clients must run the host's exact board code. A locally edited board can't sync.
- Progress belongs to the team it was earned on.
- Credit requests count only once an admin approves them.
- Each client proves which account it syncs for, so the store URL alone can't change
  another player's progress.
- A modified client could still fake numbers. The per-player view and your proof policy
  are the backstop.

## Developing

[`run-alt.cmd`](../run-alt.cmd) (Windows) starts a second dev client next to your main one, so two accounts
can test team sync together. It builds the plugin and runs it with its own RuneLite home in
`alt-home\.runelite`. The `alt-home` folder is gitignored.

The first time, create a `credentials.properties` for the second account in
`alt-home\.runelite\`. Follow
[Using Jagex Accounts](https://github.com/runelite/runelite/wiki/Using-Jagex-Accounts).
The file holds account credentials. Never commit it or share it.
