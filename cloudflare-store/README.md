# Irons Pub Bingo store on Cloudflare (experiment)

The same team store as the Google Sheet version, running as a Cloudflare Worker. Each event
gets its own Durable Object, which handles one request at a time. Syncs never wait on a lock
and there is no cold start. The plugin needs no changes: its store URL simply points here.

The Durable Object runs `docs/apps-script-store.gs` itself, so both backends behave the same.
`build.mjs` turns the script into a module, and `src/google.js` stands in for the Google
services it uses. The event's data lives in Durable Object storage, saved row by row after
every request.

## Try it

You need a free Cloudflare account and Node.js.

1. In this folder, sign in: `npx wrangler login`
2. Set the admin password: `npx wrangler secret put ADMIN_TOKEN`
3. Deploy: `npx wrangler deploy`. It prints your Worker address, like
   `https://irons-pub-bingo-store.<you>.workers.dev`.
4. Pick an event code, for example `summer-2026`. Open
   `https://irons-pub-bingo-store.<you>.workers.dev/e/summer-2026/admin`, enter the admin
   password, press Load, and fill in Teams and the Board code.
5. In the plugin settings, set the store URL to
   `https://irons-pub-bingo-store.<you>.workers.dev/e/summer-2026`.

The same address without `/admin` is the player portal.

## Admin page

It edits the tabs admins used in the sheet: Teams, Board code, Settings, Adjustments and
Requests. Saving a tab works like typing in the sheet. Setting a request to Done approves it,
and editing Teams or the Board code applies on the next sync. The Board tabs are shown read
only. The buttons run the sheet's menu actions.

## Tests

`npm test` builds the module and runs the Worker under Node, with stand-ins for Cloudflare.
The store logic itself is covered by `store-tests/run-tests.js`.

## Differences from the Google Sheet version

- No spreadsheet. The admin page replaces it. A bridge that mirrors the data into a Google
  Sheet would be a next step.
- Discord posts are sent after the reply, without the sheet version's retry on a rate limit.
  Discord sometimes limits Cloudflare's shared addresses.
- One admin password for every event on the Worker.
