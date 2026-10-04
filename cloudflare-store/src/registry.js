// The list of events on this Worker, for the top-level admin page. Cloudflare can't list
// Durable Objects, so every event reports here: when it is created or changed by an admin,
// when it is deleted, and at most every few minutes while it is in use. Only the Worker
// itself can reach this object: no public route forwards to it.

export class EventRegistry
{
	constructor(state)
	{
		this.state = state;
	}

	async fetch(request)
	{
		const path = new URL(request.url).pathname;
		const body = request.method === 'POST' ? await request.json() : {};
		if (path === '/report' && body && /^[a-z0-9-]{3,40}$/.test(String(body.code || '')))
		{
			const key = 'event:' + body.code;
			if (body.deleted)
			{
				await this.state.storage.delete([key]);
			}
			else
			{
				const known = await this.state.storage.get(key);
				await this.state.storage.put({ [key]: Object.assign({}, body.summary || {},
					{ code: body.code, firstSeen: known ? known.firstSeen : new Date().toISOString() }) });
			}
			return new Response(null, { status: 204 });
		}
		if (path === '/list')
		{
			const events = [...(await this.state.storage.list({ prefix: 'event:' })).values()]
				.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
			return new Response(JSON.stringify(events), { headers: { 'content-type': 'application/json' } });
		}
		return new Response('Not found', { status: 404 });
	}
}
