// Offline tests: the built node driven through a minimal stand-in for n8n's execution context, against a fake Tanvo
// API. Run with `npm test` (builds first).
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { after, before, beforeEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { Tanvo } = require('../dist/nodes/Tanvo/Tanvo.node.js');
const { TanvoApi } = require('../dist/credentials/TanvoApi.credentials.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
let base;
let state;
const reset = () => (state = { posts: [], auth: [], runs: new Map(), doneAfter: 2, fail: false, uploads: [] });
reset();

const server = http.createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const raw = Buffer.concat(chunks);
	const send = (s, v) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(v));
	if (req.url.startsWith('/put/')) {
		state.uploads.push({ mime: req.headers['content-type'], bytes: raw.length });
		return res.writeHead(200).end();
	}
	if (req.url.startsWith('/files/')) return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
	state.auth.push(req.headers.authorization);
	if (req.headers.authorization !== 'Bearer sk_good') return send(401, { error: 'invalid_api_key', message: 'That API key is invalid.' });
	const p = req.url.split('?')[0];
	if (p === '/api/v1/models') {
		return send(200, { models: [
			{ id: 'nano-banana-2', kind: 'image', name: 'Nano Banana 2', defaults: { aspect: '1:1', resolution: '1K', format: 'PNG' }, credits_at_defaults: 25, free_tier: false },
			{ id: 'studio-image-v1', kind: 'image', name: 'Tanvo Image v1', defaults: { aspect: '1:1', resolution: '1K', format: 'PNG' }, credits_at_defaults: 5, free_tier: true },
			{ id: 'kling-3-0', kind: 'video', name: 'Kling 3.0', defaults: { aspect: '16:9', resolution: '720p', duration: 5 }, credits_at_defaults: 155, free_tier: false },
		] });
	}
	if (p === '/api/v1/apps') {
		return send(200, { apps: [{ slug: 'ai-pet-portrait-generator', kind: 'image', name: 'Pet Portrait Generator', description: 'A painted portrait.', inputs: [{ min: 1, label: 'Pet photo' }], looks: [
			{ id: 'renaissance', name: 'Renaissance oil', prompt: 'oil portrait', model: 'nano-banana-2', options: {} },
			{ id: 'royal', name: 'Royal monarch', prompt: 'Paint the pet as a monarch.', model: 'nano-banana-2', options: { aspect: '3:4' } },
		] }] });
	}
	if (req.method === 'POST' && p === '/api/v1/uploads') return send(200, { upload_url: `${base}/put/${state.uploads.length}`, url: `https://media.tanvo.ai/uploads/u/${state.uploads.length}.png` });
	if (req.method === 'POST' && p === '/api/v1/generations') {
		const b = JSON.parse(raw);
		state.posts.push(b);
		if (b.options?.resolution === '8K') return send(400, { error: 'invalid', message: 'That model or setting is not available.', issues: ['options.resolution: 8K'] });
		const id = `gen${state.runs.size + 1}`;
		const g = { id, kind: b.kind, model: b.model, status: 'PROCESSING', cost: 25, error: null, options: b.options, outputs: [] };
		state.runs.set(id, { g, polls: 0 });
		return send(202, { generation: g });
	}
	if (req.method === 'GET' && p.startsWith('/api/v1/generations/')) {
		const r = state.runs.get(p.split('/').pop());
		if (!r) return send(404, { error: 'not_found', message: 'No such generation.' });
		if (++r.polls >= state.doneAfter) {
			r.g = state.fail ? { ...r.g, status: 'FAILED', error: 'upstream timeout' } : { ...r.g, status: 'SUCCEEDED', outputs: [{ url: `${base}/files/${r.g.id}/0.png`, mime: 'image/png' }] };
		}
		return send(200, { generation: r.g });
	}
	send(404, { error: 'not_found', message: req.url });
});

/** A minimal IExecuteFunctions / ILoadOptionsFunctions for this node. */
function ctx(params, { key = 'sk_good', items = [{ json: {} }], continueOnFail = false } = {}) {
	const credentials = { apiKey: key, baseUrl: base };
	const request = async (o, withAuth) => {
		const headers = { ...(o.headers ?? {}) };
		if (withAuth) headers.Authorization = `Bearer ${credentials.apiKey}`;
		if (o.json) headers['content-type'] = 'application/json';
		const res = await fetch(o.url, { method: o.method, headers, body: o.body === undefined ? undefined : o.json ? JSON.stringify(o.body) : o.body });
		const buf = Buffer.from(await res.arrayBuffer());
		if (!res.ok) {
			const err = new Error(`Request failed with status code ${res.status}`);
			err.response = { status: res.status, data: JSON.parse(buf.toString() || '{}') };
			throw err;
		}
		if (o.encoding === 'arraybuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
		return o.json ? JSON.parse(buf.toString() || '{}') : buf.toString();
	};
	return {
		getInputData: () => items,
		getNodeParameter: (name, i, fallback) => (name in params ? params[name] : fallback),
		getCurrentNodeParameter: (name) => params[name],
		getCredentials: async () => credentials,
		getNode: () => ({ name: 'Tanvo', type: 'n8n-nodes-tanvo.tanvo', typeVersion: 1, parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async function (_name, o) { return request(o, true); },
			httpRequest: async (o) => request(o, false),
			prepareBinaryData: async (buffer, fileName, mimeType) => ({ data: buffer.toString('base64'), fileName, mimeType }),
			assertBinaryData: (i, field) => { const b = items[i].binary?.[field]; if (!b) throw new Error(`No binary field ${field}`); return b; },
			getBinaryDataBuffer: async (i, field) => Buffer.from(items[i].binary[field].data, 'base64'),
		},
	};
}

const node = new Tanvo();
const run = (params, opts) => node.execute.call(ctx(params, opts));

before(async () => {
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(reset);

describe('Tanvo node', () => {
	it('describes itself as an n8n node with credentials and AI tool use', () => {
		assert.equal(node.description.name, 'tanvo');
		assert.equal(node.description.usableAsTool, true);
		assert.deepEqual(node.description.credentials, [{ name: 'tanvoApi', required: true }]);
		const cred = new TanvoApi();
		assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
		assert.equal(cred.test.request.url, '/me');
	});

	it('generates an image, fills model defaults, waits and returns binary data', async () => {
		const [[item]] = await run({ resource: 'image', operation: 'generate', model: 'nano-banana-2', prompt: 'a lighthouse', imageSettings: { aspect: '16:9' }, useImages: false, wait: true, timeout: 60, download: true, binaryPropertyName: 'data', options: {} });
		assert.equal(item.json.status, 'SUCCEEDED');
		assert.deepEqual(state.posts[0].options, { aspect: '16:9', resolution: '1K', format: 'PNG' });
		assert.match(state.posts[0].requestKey, /^n8n-/);
		assert.equal(item.binary.data.mimeType, 'image/png');
		assert.deepEqual(Buffer.from(item.binary.data.data, 'base64'), PNG);
		assert.ok(state.auth.every((a) => a === 'Bearer sk_good'));
	});

	it('uploads reference images from binary fields', async () => {
		const items = [{ json: {}, binary: { data: { data: PNG.toString('base64'), mimeType: 'image/png', fileName: 'a.png' } } }];
		await run({ resource: 'image', operation: 'generate', model: 'nano-banana-2', prompt: 'winter', useImages: true, photoSource: 'binary', photoBinaryFields: 'data', wait: false, options: {} }, { items });
		assert.deepEqual(state.uploads, [{ mime: 'image/png', bytes: PNG.length }]);
		assert.equal(state.posts[0].imageUrls[0], 'https://media.tanvo.ai/uploads/u/0.png');
	});

	it('returns a video run at once when not waiting, then Generation → Get downloads it', async () => {
		const [[started]] = await run({ resource: 'video', operation: 'generate', model: 'kling-3-0', prompt: 'a fox', videoSettings: { duration: 10, audio: true, endImageUrl: 'https://x/end.jpg' }, wait: false, options: { requestKey: 'job-7' } });
		assert.equal(started.json.status, 'PROCESSING');
		assert.equal(started.binary, undefined);
		assert.equal(state.posts[0].requestKey, 'job-7');
		assert.deepEqual(state.posts[0].options, { aspect: '16:9', resolution: '720p', duration: 10, audio: true });
		assert.equal(state.posts[0].endImageUrl, 'https://x/end.jpg');
		const [[got]] = await run({ resource: 'generation', operation: 'get', generationId: started.json.id, download: true, binaryPropertyName: 'video' });
		assert.equal(got.json.status, 'PROCESSING');
		const [[done]] = await run({ resource: 'generation', operation: 'get', generationId: started.json.id, download: true, binaryPropertyName: 'video' });
		assert.equal(done.json.status, 'SUCCEEDED');
		assert.ok(done.binary.video);
	});

	it('writes a song with the chosen mode', async () => {
		await run({ resource: 'music', operation: 'generate', mode: 'Lyrics', prompt: '[Verse] …', songSettings: { title: 'Ana Rides', vocal: 'f' }, wait: false, options: {} });
		assert.deepEqual(state.posts[0], { requestKey: state.posts[0].requestKey, kind: 'music', model: 'suno-v6', prompt: '[Verse] …', options: { tier: 'Lyrics', resolution: 'song', title: 'Ana Rides', vocal: 'f' } });
	});

	it('runs an app look with the personal touch and checks the photo count', async () => {
		await assert.rejects(run({ resource: 'app', operation: 'run', app: 'ai-pet-portrait-generator', look: 'royal', photoSource: 'url', photoUrls: '', wait: false, options: {} }), /needs 1 photo/);
		await run({ resource: 'app', operation: 'run', app: 'ai-pet-portrait-generator', look: 'royal', photoSource: 'url', photoUrls: 'https://x/rex.jpg', details: 'Rex', wait: false, options: {} });
		const b = state.posts.at(-1);
		assert.equal(b.model, 'nano-banana-2');
		assert.deepEqual(b.options, { aspect: '3:4', resolution: '1K', format: 'PNG' });
		assert.equal(b.prompt, 'Paint the pet as a monarch.\n\nThis one is for: Rex.');
		assert.deepEqual(b.imageUrls, ['https://x/rex.jpg']);
	});

	it('reports API errors with the code, and a failed run, and honours Continue On Fail', async () => {
		await assert.rejects(run({ resource: 'image', operation: 'generate', model: 'nano-banana-2', prompt: 'x', imageSettings: { resolution: '8K' }, wait: false, options: {} }), (e) => /invalid: That model or setting is not available\. \(options\.resolution: 8K\)/.test(e.message));
		await assert.rejects(run({ resource: 'image', operation: 'generate', model: 'nano-banana-2', prompt: 'x', wait: false, options: {} }, { key: 'sk_bad' }), (e) => /invalid_api_key/.test(e.message));
		state.fail = true;
		await assert.rejects(run({ resource: 'image', operation: 'generate', model: 'nano-banana-2', prompt: 'x', wait: true, timeout: 60, download: true, options: {} }), /failed: upstream timeout\. Its credits were refunded/);
		const [[soft]] = await run({ resource: 'image', operation: 'generate', model: 'nano-banana-2', prompt: 'x', wait: true, timeout: 60, options: {} }, { continueOnFail: true });
		assert.match(soft.json.error, /upstream timeout/);
	});

	it('loads model, app and look options for the editor', async () => {
		const c = ctx({ app: 'ai-pet-portrait-generator' });
		const images = await node.methods.loadOptions.getImageModels.call(c);
		assert.deepEqual(images.map((o) => o.value), ['nano-banana-2', 'studio-image-v1']);
		assert.equal(images[0].name, 'Nano Banana 2 (25 credits)');
		assert.deepEqual((await node.methods.loadOptions.getVideoModels.call(c)).map((o) => o.value), ['kling-3-0']);
		assert.equal((await node.methods.loadOptions.getApps.call(c))[0].value, 'ai-pet-portrait-generator');
		assert.deepEqual((await node.methods.loadOptions.getLooks.call(c)).map((o) => o.value), ['renaissance', 'royal']);
	});
});
