import { fetch } from 'undici';
import { Constants } from '../constants';

export class NopeCHASolver {
	private static readonly baseUrl = 'https://api.nopecha.com/v1/token/hcaptcha';

	constructor(private readonly apiKey: string) {}

	async hcaptcha(sitekey: string, url: string, rqdata?: string): Promise<string> {
		const jobId = await this.submit(sitekey, url, rqdata);
		return this.poll(jobId);
	}

	private async submit(sitekey: string, url: string, rqdata?: string): Promise<string> {
		const response = await fetch(NopeCHASolver.baseUrl, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({
				sitekey,
				url,
				useragent: Constants.USER_AGENT,
				...(rqdata ? { data: { rqdata } } : {}),
			}),
		});
		const json = (await response.json()) as { data?: string; error?: string; message?: string };
		if (!response.ok || !json.data) {
			throw new Error(`NopeCHA submit failed: ${JSON.stringify(json)}`);
		}
		return json.data;
	}

	private async poll(jobId: string): Promise<string> {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 3000));
			const response = await fetch(`${NopeCHASolver.baseUrl}?id=${encodeURIComponent(jobId)}`, {
				headers: this.headers(false),
			});
			const json = (await response.json()) as { data?: string; error?: string; message?: string };
			if (!response.ok) {
				throw new Error(`NopeCHA poll failed: ${JSON.stringify(json)}`);
			}
			if (json.data && json.data !== jobId) {
				return json.data;
			}
		}
		throw new Error('NopeCHA timeout while waiting for hCaptcha token');
	}

	private headers(withJson = true): HeadersInit {
		return {
			...(withJson ? { 'Content-Type': 'application/json' } : {}),
			Authorization: `Basic ${this.apiKey}`,
		};
	}
}
