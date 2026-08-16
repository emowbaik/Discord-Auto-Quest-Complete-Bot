import { fetch } from 'undici';

export type HCaptchaTask = {
	request_type: 'image_label_binary' | 'image_label_area_select' | 'image_drag_drop' | string;
	requester_question: { en: string };
	requester_question_example?: string[];
	tasklist: Array<{
		task_key: string;
		datapoint_uri: string;
		entities?: Array<{ entity_id: string; entity_uri: string; coords: [number, number]; size: [number, number] }>;
	}>;
	[key: string]: any;
};

export type HCaptchaRecognitionResult =
	| boolean[][] // image_label_binary -> [[true,false,...], ...] 9 booleans per group
	| Array<Array<{ x: number; y: number; w: number; h: number }>> // area_select
	| Array<Array<{ entity_id: string; x: number; y: number; w: number; h: number }>>; // drag_drop

export class NopeCHARecognitionSolver {
	private static readonly postUrl = 'https://api.nopecha.com/v1/recognition/hcaptcha';
	private static readonly getUrl = 'https://api.nopecha.com/v1/recognition/hcaptcha';

	constructor(private readonly apiKey: string) {}

	async solve(data: HCaptchaTask): Promise<HCaptchaRecognitionResult> {
		const jobId = await this.submit(data);
		return this.poll(jobId);
	}

	private async submit(data: HCaptchaTask): Promise<string> {
		const body = JSON.stringify({ data });
		for (const auth of [`Basic ${this.apiKey}`, `Bearer ${this.apiKey}`]) {
			const res = await fetch(NopeCHARecognitionSolver.postUrl, {
				method: 'POST',
				headers: { Authorization: auth, 'Content-Type': 'application/json' },
				body,
			});
			const json = (await res.json().catch(() => ({}))) as any;
			if (res.ok && json.data) return json.data as string;
			// 401/403 try next auth, else throw
			if (res.status === 401 || res.status === 403) continue;
			throw new Error(`NopeCHA recognition submit failed: ${JSON.stringify(json)}`);
		}
		throw new Error('NopeCHA recognition submit failed: auth rejected (check NOPECHA_API_KEY)');
	}

	private async poll(jobId: string): Promise<HCaptchaRecognitionResult> {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2000));
			for (const auth of [`Basic ${this.apiKey}`, `Bearer ${this.apiKey}`]) {
				const res = await fetch(`${NopeCHARecognitionSolver.getUrl}?id=${encodeURIComponent(jobId)}`, {
					headers: { Authorization: auth },
				});
				const json = (await res.json().catch(() => ({}))) as any;
				if (!res.ok) {
					if (json?.error === 11 || json?.code === 11) {
						// Incomplete job — keep polling
						break;
					}
					throw new Error(`NopeCHA recognition poll failed: ${JSON.stringify(json)}`);
				}
				if (json.data && json.data !== jobId) return json.data as HCaptchaRecognitionResult;
				break;
			}
		}
		throw new Error('NopeCHA recognition timeout');
	}
}
