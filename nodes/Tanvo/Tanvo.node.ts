import type {
	IBinaryKeyData,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

/*
 * Tanvo (https://tanvo.ai): images, video and songs on 30 models, and ready-made photo apps.
 * Programmatic style rather than declarative, because a generation is asynchronous: the node submits a run, polls
 * it until it finishes (minutes for video), then optionally downloads each output into binary data. Photos can come
 * from URLs or from binary fields of the incoming item (uploaded through the API's signed upload slots).
 */

type Output = { url: string; mime: string; title?: string; cover?: string; lyrics?: string; seconds?: number };
type Generation = { id: string; kind: string; model: string; status: string; cost: number; error: string | null; options: IDataObject; outputs: Output[] };
type Model = { id: string; kind: string; name: string; defaults: IDataObject; credits_at_defaults: number; free_tier: boolean };
type Look = { id: string; name: string; prompt: string; model: string; options: IDataObject };
type App = { slug: string; kind: string; name: string; description: string; inputs: Array<{ min: number; label: string }>; looks: Look[] };

const DONE = ['SUCCEEDED', 'FAILED', 'CANCELED'];

// ─── Shared fields ───────────────────────────────────────────────────────────

const show = (resource: string[], operation: string[]) => ({ displayOptions: { show: { resource, operation } } });

const waitFields = (resource: string[], operation: string[], defaultTimeout: number): INodeProperties[] => [
	{
		displayName: 'Wait for Result',
		name: 'wait',
		type: 'boolean',
		default: true,
		description: 'Whether to wait until the run has finished. If off, the node returns the run at once; check it later with Generation → Get.',
		...show(resource, operation),
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'timeout',
		type: 'number',
		default: defaultTimeout,
		typeOptions: { minValue: 10 },
		description: 'How long to wait before returning the run as it stands (it keeps running on Tanvo)',
		displayOptions: { show: { resource, operation, wait: [true] } },
	},
	{
		displayName: 'Download Files',
		name: 'download',
		type: 'boolean',
		default: true,
		description: 'Whether to download the outputs into binary data, for nodes that upload or send files',
		displayOptions: { show: { resource, operation, wait: [true] } },
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		description: 'Binary field for the first output; further outputs get _1, _2, … appended',
		displayOptions: { show: { resource, operation, wait: [true], download: [true] } },
	},
];

const photoFields = (resource: string[], operation: string[], label: string, required: boolean): INodeProperties[] => [
	{
		displayName: `${label} Source`,
		name: 'photoSource',
		type: 'options',
		default: 'url',
		options: [
			{ name: 'URLs', value: 'url', description: 'Public https URLs' },
			{ name: 'Binary Fields', value: 'binary', description: 'Files from earlier nodes, uploaded for you' },
		],
		...show(resource, operation),
	},
	{
		displayName: `${label} URLs`,
		name: 'photoUrls',
		type: 'string',
		default: '',
		required,
		placeholder: 'https://example.com/photo.jpg, https://example.com/second.jpg',
		description: 'Comma-separated https URLs, in the order the model or app needs them',
		displayOptions: { show: { resource, operation, photoSource: ['url'] } },
	},
	{
		displayName: `${label} Binary Fields`,
		name: 'photoBinaryFields',
		type: 'string',
		default: 'data',
		required,
		placeholder: 'data, data_1',
		description: 'Comma-separated names of binary fields on the input item that hold the photos',
		displayOptions: { show: { resource, operation, photoSource: ['binary'] } },
	},
];

const extraOptions = (resource: string[], operation: string[]): INodeProperties => ({
	displayName: 'Options',
	name: 'options',
	type: 'collection',
	placeholder: 'Add option',
	default: {},
	...show(resource, operation),
	options: [
		{ displayName: 'Request Key', name: 'requestKey', type: 'string', default: '', description: 'Idempotency key: a repeat with the same key returns the first run and is not charged again' },
		{ displayName: 'Webhook URL', name: 'webhookUrl', type: 'string', default: '', description: 'An https URL that receives the finished run (e.g. an n8n Webhook node)' },
	],
});

// ─── Node ────────────────────────────────────────────────────────────────────

export class Tanvo implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Tanvo',
		name: 'tanvo',
		icon: { light: 'file:tanvo.svg', dark: 'file:tanvo.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Generate images, video and songs with AI, or run ready-made photo apps, on Tanvo',
		defaults: { name: 'Tanvo' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'tanvoApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'image',
				options: [
					{ name: 'App', value: 'app', description: 'A ready-made photo app with preset looks' },
					{ name: 'Generation', value: 'generation', description: 'A run started earlier' },
					{ name: 'Image', value: 'image' },
					{ name: 'Music', value: 'music' },
					{ name: 'Video', value: 'video' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'generate',
				displayOptions: { show: { resource: ['image', 'video', 'music'] } },
				options: [{ name: 'Generate', value: 'generate', action: 'Generate', description: 'Start a run and optionally wait for the files' }],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'run',
				displayOptions: { show: { resource: ['app'] } },
				options: [{ name: 'Run', value: 'run', action: 'Run an app look', description: 'Run one of an app\'s preset looks on photos' }],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get',
				displayOptions: { show: { resource: ['generation'] } },
				options: [{ name: 'Get', value: 'get', action: 'Get a generation', description: 'Status and files of a run' }],
			},

			// Image
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getImageModels' },
				default: 'nano-banana-2',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				...show(['image'], ['generate']),
			},
			{ displayName: 'Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 4 }, default: '', required: true, description: 'What to make: subject, setting, light and style. For edits, what to change and what to keep.', ...show(['image'], ['generate']) },
			{
				displayName: 'Use Reference Images',
				name: 'useImages',
				type: 'boolean',
				default: false,
				description: 'Whether to edit or combine photos instead of generating from text alone',
				...show(['image'], ['generate']),
			},
			...photoFields(['image'], ['generate'], 'Images', false).map((f) => ({ ...f, displayOptions: { show: { ...f.displayOptions!.show, useImages: [true] } } })),
			{
				displayName: 'Image Settings',
				name: 'imageSettings',
				type: 'collection',
				placeholder: 'Add setting',
				default: {},
				...show(['image'], ['generate']),
				options: [
					{ displayName: 'Aspect Ratio', name: 'aspect', type: 'string', default: '1:1', description: 'E.g. 1:1, 16:9, 9:16, 4:3, 3:4.' },
					{ displayName: 'Resolution', name: 'resolution', type: 'options', default: '1K', options: [{ name: '1K', value: '1K' }, { name: '2K', value: '2K' }, { name: '4K', value: '4K' }] },
					{ displayName: 'Format', name: 'format', type: 'options', default: 'PNG', options: [{ name: 'PNG', value: 'PNG' }, { name: 'JPG', value: 'JPG' }, { name: 'WEBP', value: 'WEBP' }] },
					{ displayName: 'Negative Prompt', name: 'negativePrompt', type: 'string', default: '', description: 'What to avoid, on models that use it' },
				],
			},
			...waitFields(['image'], ['generate'], 180),
			extraOptions(['image'], ['generate']),

			// Video
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getVideoModels' },
				default: 'kling-3-0',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				...show(['video'], ['generate']),
			},
			{ displayName: 'Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 4 }, default: '', required: true, description: 'One scene: subject, action, camera movement, light and style', ...show(['video'], ['generate']) },
			{
				displayName: 'Video Settings',
				name: 'videoSettings',
				type: 'collection',
				placeholder: 'Add setting',
				default: {},
				...show(['video'], ['generate']),
				options: [
					{ displayName: 'Aspect Ratio', name: 'aspect', type: 'options', default: '16:9', options: [{ name: '16:9', value: '16:9' }, { name: '9:16', value: '9:16' }, { name: '1:1', value: '1:1' }] },
					{ displayName: 'Duration (Seconds)', name: 'duration', type: 'number', default: 5, description: 'One of the model\'s lengths, often 5 or 10' },
					{ displayName: 'End Frame URL', name: 'endImageUrl', type: 'string', default: '', description: 'An https image URL to end on, on models that support it' },
					{ displayName: 'Generate Audio', name: 'audio', type: 'boolean', default: true, description: 'Whether to add native sound, on models that offer it' },
					{ displayName: 'Negative Prompt', name: 'negativePrompt', type: 'string', default: '' },
					{ displayName: 'Resolution', name: 'resolution', type: 'options', default: '720p', options: [{ name: '480p', value: '480p' }, { name: '720p', value: '720p' }, { name: '1080p', value: '1080p' }, { name: '4K', value: '4K' }] },
					{ displayName: 'Start Frame URL', name: 'imageUrl', type: 'string', default: '', description: 'An https image URL to animate (image to video)' },
				],
			},
			...waitFields(['video'], ['generate'], 600),
			extraOptions(['video'], ['generate']),

			// Music
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				default: 'Describe',
				options: [
					{ name: 'Describe', value: 'Describe', description: 'Describe the song in a sentence; lyrics are written for you' },
					{ name: 'Lyrics', value: 'Lyrics', description: 'Sing your own lyrics (use [Verse] / [Chorus] tags)' },
					{ name: 'Instrumental', value: 'Instrumental', description: 'No vocals; describe the sound' },
				],
				...show(['music'], ['generate']),
			},
			{ displayName: 'Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 4 }, default: '', required: true, description: 'The description, your lyrics, or the sound you want, depending on the mode', ...show(['music'], ['generate']) },
			{
				displayName: 'Song Settings',
				name: 'songSettings',
				type: 'collection',
				placeholder: 'Add setting',
				default: {},
				...show(['music'], ['generate']),
				options: [
					{ displayName: 'Style', name: 'style', type: 'string', default: '', description: 'Genre, instruments, tempo, voice, e.g. "acoustic pop, warm female vocal"' },
					{ displayName: 'Title', name: 'title', type: 'string', default: '', description: 'Song title (Lyrics and Instrumental modes)' },
					{ displayName: 'Vocal', name: 'vocal', type: 'options', default: 'f', options: [{ name: 'Female', value: 'f' }, { name: 'Male', value: 'm' }], description: 'Lean towards a voice (Lyrics mode)' },
				],
			},
			...waitFields(['music'], ['generate'], 300),
			extraOptions(['music'], ['generate']),

			// App
			{
				displayName: 'App Name or ID',
				name: 'app',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getApps' },
				default: '',
				required: true,
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				...show(['app'], ['run']),
			},
			{
				displayName: 'Look Name or ID',
				name: 'look',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getLooks', loadOptionsDependsOn: ['app'] },
				default: '',
				description: 'The preset look to run (empty: the app\'s first look). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				...show(['app'], ['run']),
			},
			...photoFields(['app'], ['run'], 'Photos', false),
			{ displayName: 'Personal Touch', name: 'details', type: 'string', default: '', placeholder: 'e.g. for my sister Ana, with roses around it', description: 'Optional detail woven into the look\'s prompt', ...show(['app'], ['run']) },
			...waitFields(['app'], ['run'], 600),
			extraOptions(['app'], ['run']),

			// Generation
			{ displayName: 'Generation ID', name: 'generationId', type: 'string', default: '', required: true, description: 'The ID returned by a Generate or Run operation', ...show(['generation'], ['get']) },
			{
				displayName: 'Download Files',
				name: 'download',
				type: 'boolean',
				default: true,
				description: 'Whether to download the outputs into binary data when the run has succeeded',
				...show(['generation'], ['get']),
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: { show: { resource: ['generation'], operation: ['get'], download: [true] } },
			},
		],
	};

	methods = {
		loadOptions: {
			async getImageModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return modelOptions(await api<{ models: Model[] }>(this, 'GET', '/models'), 'image');
			},
			async getVideoModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return modelOptions(await api<{ models: Model[] }>(this, 'GET', '/models'), 'video');
			},
			async getApps(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const { apps } = await api<{ apps: App[] }>(this, 'GET', '/apps');
				return apps.map((a) => ({ name: `${a.name} (${a.kind})`, value: a.slug, description: a.description })).sort((x, y) => x.name.localeCompare(y.name));
			},
			async getLooks(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const slug = this.getCurrentNodeParameter('app') as string;
				if (!slug) return [];
				const { apps } = await api<{ apps: App[] }>(this, 'GET', '/apps');
				return (apps.find((a) => a.slug === slug)?.looks ?? []).map((l) => ({ name: l.name, value: l.id }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		let models: Model[] | undefined;
		let apps: App[] | undefined;
		const defaultsFor = async (model: string): Promise<IDataObject> => {
			models ??= (await api<{ models: Model[] }>(this, 'GET', '/models')).models;
			return { ...(models.find((m) => m.id === model)?.defaults ?? {}) };
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let g: Generation;

				if (resource === 'generation' && operation === 'get') {
					const id = this.getNodeParameter('generationId', i) as string;
					g = (await api<{ generation: Generation }>(this, 'GET', `/generations/${encodeURIComponent(id)}`)).generation;
					out.push(await result(this, g, i, this.getNodeParameter('download', i, true) as boolean));
					continue;
				}

				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				const body: IDataObject = { requestKey: options.requestKey || randomKey(), ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}) };

				if (resource === 'image') {
					const model = this.getNodeParameter('model', i) as string;
					const s = this.getNodeParameter('imageSettings', i, {}) as IDataObject;
					Object.assign(body, {
						kind: 'image',
						model,
						prompt: this.getNodeParameter('prompt', i) as string,
						options: { ...(await defaultsFor(model)), ...pick(s, ['aspect', 'resolution', 'format']) },
						...(s.negativePrompt ? { negativePrompt: s.negativePrompt } : {}),
					});
					if (this.getNodeParameter('useImages', i, false)) body.imageUrls = await photos(this, i);
				} else if (resource === 'video') {
					const model = this.getNodeParameter('model', i) as string;
					const s = this.getNodeParameter('videoSettings', i, {}) as IDataObject;
					Object.assign(body, {
						kind: 'video',
						model,
						prompt: this.getNodeParameter('prompt', i) as string,
						options: { ...(await defaultsFor(model)), ...pick(s, ['aspect', 'resolution', 'duration', 'audio']) },
						...(s.imageUrl ? { imageUrls: [s.imageUrl] } : {}),
						...(s.endImageUrl ? { endImageUrl: s.endImageUrl } : {}),
						...(s.negativePrompt ? { negativePrompt: s.negativePrompt } : {}),
					});
				} else if (resource === 'music') {
					const s = this.getNodeParameter('songSettings', i, {}) as IDataObject;
					Object.assign(body, {
						kind: 'music',
						model: 'suno-v6',
						prompt: this.getNodeParameter('prompt', i) as string,
						options: { tier: this.getNodeParameter('mode', i) as string, resolution: 'song', ...pick(s, ['style', 'title', 'vocal']) },
					});
				} else if (resource === 'app') {
					apps ??= (await api<{ apps: App[] }>(this, 'GET', '/apps')).apps;
					const slug = this.getNodeParameter('app', i) as string;
					const app = apps.find((a) => a.slug === slug);
					if (!app) throw new NodeOperationError(this.getNode(), `Unknown app "${slug}"`, { itemIndex: i });
					const lookId = this.getNodeParameter('look', i, '') as string;
					const look = lookId ? app.looks.find((l) => l.id === lookId) : app.looks[0];
					if (!look) throw new NodeOperationError(this.getNode(), `"${app.name}" has no look "${lookId}". Looks: ${app.looks.map((l) => l.id).join(', ')}`, { itemIndex: i });
					const details = (this.getNodeParameter('details', i, '') as string).trim();
					const imageUrls = app.kind === 'music' ? [] : await photos(this, i);
					const needed = app.inputs.filter((x) => x.min > 0).length;
					if (imageUrls.length < needed) {
						throw new NodeOperationError(this.getNode(), `${app.name} needs ${needed} photo(s): ${app.inputs.filter((x) => x.min > 0).map((x) => x.label).join(', ')}`, { itemIndex: i });
					}
					Object.assign(body, {
						kind: app.kind,
						model: look.model,
						prompt: details ? `${look.prompt}\n\nThis one is for: ${details}.` : look.prompt,
						options: { ...(await defaultsFor(look.model)), ...look.options },
						...(imageUrls.length ? { imageUrls } : {}),
					});
				} else {
					throw new NodeOperationError(this.getNode(), `Unsupported operation ${resource}/${operation}`, { itemIndex: i });
				}

				g = (await api<{ generation: Generation }>(this, 'POST', '/generations', body)).generation;
				const wait = this.getNodeParameter('wait', i, true) as boolean;
				if (wait) {
					const timeout = (this.getNodeParameter('timeout', i, 600) as number) * 1000;
					const every = g.kind === 'video' ? 6000 : 4000;
					const deadline = Date.now() + timeout;
					await sleep(Math.min(2000, every));
					while (!DONE.includes(g.status) && Date.now() + every < deadline) {
						g = (await api<{ generation: Generation }>(this, 'GET', `/generations/${encodeURIComponent(g.id)}`)).generation;
						if (!DONE.includes(g.status)) await sleep(every);
					}
					if (!DONE.includes(g.status)) g = (await api<{ generation: Generation }>(this, 'GET', `/generations/${encodeURIComponent(g.id)}`)).generation;
				}
				out.push(await result(this, g, i, wait && (this.getNodeParameter('download', i, true) as boolean)));
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeOperationError) throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i, message: apiMessage(error) });
			}
		}
		return [out];
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

async function api<T>(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: IDataObject): Promise<T> {
	const creds = await ctx.getCredentials('tanvoApi');
	const base = String(creds.baseUrl || 'https://tanvo.ai').replace(/\/$/, '');
	const options: IHttpRequestOptions = { method, url: `${base}/api/v1${path}`, json: true, headers: { 'User-Agent': 'n8n-nodes-tanvo/0.1.0' }, ...(body ? { body } : {}) };
	return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'tanvoApi', options)) as T;
}

/** The API's "code: message", with the hint for the codes users can act on. */
function apiMessage(error: unknown): string {
	const e = error as { response?: { data?: IDataObject; body?: IDataObject }; cause?: { response?: { data?: IDataObject } }; message?: string };
	const data = e.response?.data ?? e.response?.body ?? e.cause?.response?.data;
	if (data && typeof data === 'object' && data.error) {
		const issues = Array.isArray(data.issues) ? ` (${(data.issues as string[]).join('; ')})` : '';
		return `${String(data.error)}: ${String(data.message ?? '')}${issues}`;
	}
	return e.message ?? 'Tanvo request failed';
}

function modelOptions(r: { models: Model[] }, kind: string): INodePropertyOptions[] {
	return r.models
		.filter((m) => m.kind === kind)
		.map((m) => ({ name: `${m.name} (${m.credits_at_defaults} credits)`, value: m.id, description: m.free_tier ? 'Free engine' : undefined }));
}

function pick(o: IDataObject, keys: string[]): IDataObject {
	return Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== '').map((k) => [k, o[k]]));
}

function randomKey(): string {
	return `n8n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Photo inputs as URLs: given URLs as they are, binary fields uploaded through a signed upload slot. */
async function photos(ctx: IExecuteFunctions, i: number): Promise<string[]> {
	const source = ctx.getNodeParameter('photoSource', i, 'url') as string;
	if (source === 'url') {
		return (ctx.getNodeParameter('photoUrls', i, '') as string).split(',').map((s) => s.trim()).filter(Boolean);
	}
	const fields = (ctx.getNodeParameter('photoBinaryFields', i, 'data') as string).split(',').map((s) => s.trim()).filter(Boolean);
	const urls: string[] = [];
	for (const field of fields) {
		const meta = ctx.helpers.assertBinaryData(i, field);
		const buffer = await ctx.helpers.getBinaryDataBuffer(i, field);
		const slot = await api<{ upload_url: string; url: string }>(ctx, 'POST', '/uploads', { mime: meta.mimeType, bytes: buffer.length });
		await ctx.helpers.httpRequest({ method: 'PUT', url: slot.upload_url, body: buffer, headers: { 'Content-Type': meta.mimeType } });
		urls.push(slot.url);
	}
	return urls;
}

async function result(ctx: IExecuteFunctions, g: Generation, i: number, download: boolean): Promise<INodeExecutionData> {
	if (g.status === 'FAILED' || g.status === 'CANCELED') {
		throw new NodeOperationError(ctx.getNode(), `The ${g.kind} run ${g.id} failed: ${g.error ?? 'unknown error'}. Its credits were refunded.`, { itemIndex: i });
	}
	const item: INodeExecutionData = { json: g as unknown as IDataObject, pairedItem: { item: i } };
	if (download && g.status === 'SUCCEEDED' && g.outputs.length) {
		const field = (ctx.getNodeParameter('binaryPropertyName', i, 'data') as string) || 'data';
		const binary: IBinaryKeyData = {};
		for (const [n, o] of g.outputs.entries()) {
			const bytes = (await ctx.helpers.httpRequest({ method: 'GET', url: o.url, encoding: 'arraybuffer' })) as ArrayBuffer;
			const ext = (new URL(o.url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'bin').toLowerCase();
			binary[n === 0 ? field : `${field}_${n}`] = await ctx.helpers.prepareBinaryData(Buffer.from(bytes), `tanvo-${g.id}-${n}.${ext}`, o.mime);
		}
		item.binary = binary;
	}
	return item;
}
