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
		// sanitize: NopeCHA expects exact hcaptcha shape — strip unknown wrappers like key/request_config if present but keep request_type/requester_question/tasklist
let payload: any = data;
if (data && typeof data === 'object') {
 payload = { request_type: (data as any).request_type, requester_question: (data as any).requester_question, tasklist: (data as any).tasklist };
 if ((data as any).requester_question_example) payload.requester_question_example = (data as any).requester_question_example;
 if ((data as any).requester_restricted_answer_set) payload.requester_restricted_answer_set = (data as any).requester_restricted_answer_set;
 // keep image_label_binary separate: ensure 9-wide boolean result compatible, but NopeCHA handles
 // debug raw submit
 console.log(`[NopeCHA Recognition] payload keys=${Object.keys(payload).join(',')} len=${JSON.stringify(payload).length}`);
 // ensure datapoint_uri https, keep entities
 payload.tasklist = (payload.tasklist||[]).map((t:any)=>({ task_key:t.task_key, datapoint_uri:t.datapoint_uri, ...(t.entities?{entities:t.entities}:{}) }));
}
const body = JSON.stringify({ data: payload });
console.log(`[NopeCHA Recognition] submit tasks=${payload.tasklist?.length} type=${payload.request_type} payloadKeys=${Object.keys(payload).join(',')} len=${body.length}`);
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
			// if error 10 (Invalid request / Failed to load data) try full raw fallback once
if (json?.error===10 && (data as any).key) {
 console.log('[NopeCHA Recognition] retry full raw (with key/request_config) after error 10');
 const fullBody = JSON.stringify({ data });
 for (const auth2 of [`Basic ${this.apiKey}`, `Bearer ${this.apiKey}`]) {
  const r2 = await fetch(NopeCHARecognitionSolver.postUrl, { method:'POST', headers:{ Authorization:auth2,'Content-Type':'application/json'}, body: fullBody });
  const j2 = await r2.json().catch(()=>({})) as any;
  if (r2.ok && j2.data) return j2.data as string;
  if (r2.status===401||r2.status===403) continue;
  throw new Error(`NopeCHA recognition submit retry failed: ${JSON.stringify(j2)}`);
 }
}
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
						if (json?.error===10) {
					console.warn(`[NopeCHA Recognition] poll error 10 — likely unsupported task/exhausted datapoint. Will fallback to manual.`);
				}
				throw new Error(`NopeCHA recognition poll failed: ${JSON.stringify(json)} bodyOk=${res.ok} status=${res.status}`);
				}
				if (json.data && json.data !== jobId) return json.data as HCaptchaRecognitionResult;
				break;
			}
		}
		throw new Error('NopeCHA recognition timeout');
	}
}
