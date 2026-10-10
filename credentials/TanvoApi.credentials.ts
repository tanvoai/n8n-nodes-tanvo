import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class TanvoApi implements ICredentialType {
	name = 'tanvoApi';

	displayName = 'Tanvo API';

	icon = { light: 'file:tanvo.svg', dark: 'file:tanvo.dark.svg' } as const;

	documentationUrl = 'https://tanvo.ai/developers/api#auth';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Create one at https://tanvo.ai/settings/apikeys. It starts with sk_.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://tanvo.ai',
			description: 'Only change this to point at another Tanvo deployment',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}/api/v1',
			url: '/me',
			method: 'GET',
		},
	};
}
