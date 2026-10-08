# Irons Pub Bingo store on Cloudflare

The Irons Pub Bingo team store, run as a Cloudflare Worker on a free account. Each event
gets its own Durable Object, so one event's syncs never wait on another's.

The event's rules live in `src/store.js`. `src/worker.js` routes requests to the event and
saves what changed, and `src/data.js` shapes the data the portal and admin pages show.

## Setup

You need a free Cloudflare account and Node.js.

1. In this folder, sign in: `npx wrangler login`
2. Set the admin password: `npx wrangler secret put ADMIN_TOKEN`
3. Deploy: `npx wrangler deploy`. It prints your Worker address, like
   `https://irons-pub-bingo.<you>.workers.dev`.
4. Pick an event code of 3 to 40 lowercase letters, digits and hyphens, for example
   `summer-2026`. Open `https://irons-pub-bingo.<you>.workers.dev/e/summer-2026/admin`
   and sign in with the admin password.
5. Add your teams and the board code. The event exists once you save something. Until
   then its address shows nothing and accepts no syncs.
6. Share `https://irons-pub-bingo.<you>.workers.dev/e/summer-2026` with the clan. Players
   turn on Use team store in the plugin settings and paste it into Team store URL. In a
   browser it is the player portal.

Open `https://irons-pub-bingo.<you>.workers.dev/admin` to see every event, start a new one or
delete one.

Bingo Forge can also save the board for you. Export the code, enter the event URL and the
admin password, and press **Send to store**.

## Admin page

- **Requests**: approve, reject, withdraw or reopen credit requests.
- **Boards**: each team's board and progress. Reset a tile's progress from here.
- **Give credit**: credit progress by hand, and remove earlier credit. A negative amount
  takes a player down to zero at most.
- **Teams**: team codes, display names and an optional Discord webhook per team.
- **Board code**: paste a new code and press **Save and apply**.
- **Settings**: the links to share, the poll interval, and resetting the event's data.
- **Usage**: requests per day for the last 14 days.

The admin password is kept in your browser after you sign in. It is never put in a URL.

## Good to know

- One admin password covers every event on the Worker.
- Approvals, credit and withdrawals post to Discord right away, but a post is not retried
  if Discord rate limits it. Discord sometimes limits Cloudflare's shared addresses.
- Credit and requests belong to the board they were given on. A new board starts without
  them.

## Tests

`npm test` runs the store's own tests and the Worker under Node. To test on Cloudflare's own
runtime, put `ADMIN_TOKEN=<anything>` in a `.dev.vars` file here, start
`npx wrangler dev`, and run `node test/live-check.mjs http://127.0.0.1:8787 <that token>`.
It runs a whole event against the Worker, and works against a deployed one too.
