import { fetch } from 'undici';

export type HCaptchaTask = {
	request_type: 'image_label_binary' | 'image_label_area_select' | 'image_drag_drop' | string;
	requester_question: { en: string };
	tasklist: Array<{
		task_key: string;
		datapoint_uri: string;
		entities?: Array<{ entity_id: string; entity_uri: string; coords: [number, number]; size: [number, number] }>;
	}>;
	[key: string]: any;
};

export type HCaptchaRecognitionResult =
	| boolean[][]
	| Array<Array<{ x: number; y: number; w: number; h: number }>>
	| Array<Array<{ entity_id: string; x: number; y: number; w: number; h: number }>>;

const SYSTEM_PROMPT_GRID = 'You are an hCaptcha solver. You will receive images from an hCaptcha challenge grid.\nThe user message contains the challenge instruction (e.g. "Click all images containing a cat").\nAnalyze each image and return ONLY a JSON array of zero-based indices for images that match the instruction.\nExample response: [0, 2, 5]\nIf no images match, return an empty array: []\nDo NOT include any explanation or text outside the JSON array.';

const SYSTEM_PROMPT_AREA = 'You are an hCaptcha solver. You will receive one or more images of an hCaptcha challenge.\nIf multiple images are provided, they are sequential frames of an ANIMATED challenge captured ~180ms apart — use them to determine motion (which object moves, which is fastest/highest/brightest, etc.).\nThe instruction tells you what to click.\nReturn ONLY valid JSON — no explanation:\n- Single click: {"x": 0.42, "y": 0.31}\n- Multiple clicks: [{"x": 0.2, "y": 0.3}, {"x": 0.7, "y": 0.5}]\nAll coordinates are normalized 0.0-1.0 relative to the image dimensions (x=left→right, y=top→bottom).';

function getPrompt(reqType: string, question: string): { system: string; user: string } {
	if (reqType === 'image_drag_drop') return { system: SYSTEM_PROMPT_AREA, user: question || 'Drag the element to where it fits.' };
	if (reqType === 'image_label_area_select') return { system: SYSTEM_PROMPT_AREA, user: question || 'Select all matching areas.' };
	return { system: SYSTEM_PROMPT_GRID, user: question || 'Select all matching images.' };
}

export class OpenAIVisionSolver {
	private baseUrl: string;
	private apiKey: string;
	private model: string;
	constructor(baseUrl: string, apiKey: string, model: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
		this.apiKey = apiKey;
		this.model = model;
	}
	async solve(task: HCaptchaTask): Promise<HCaptchaRecognitionResult> {
		const reqType = task.request_type || 'image_label_binary';
		const question = (task.requester_question && task.requester_question.en) || 'Select matching';
		const { system, user } = getPrompt(reqType, question);
		const images: Array<{type:"image_url";image_url:{url:string}}> = [];
		for (const t of task.tasklist || []) { const uris=[t.datapoint_uri,...(t.entities||[]).map((e:any)=>e.entity_uri||'')].filter(Boolean); for(const uri of uris){ try { const r=await fetch(uri); const b=Buffer.from(await r.arrayBuffer()); const ct=r.headers.get('content-type')||'image/jpeg'; images.push({type:"image_url",image_url:{url:'data:'+ct+';base64,'+b.toString('base64')}}); } catch(e){ console.warn('[OpenAIVision] img fetch fail '+String(e instanceof Error?e.message:e)); } } }
		if (!images.length) throw new Error('No images in task');
		const body = {model:this.model,messages:[{role:'system',content:system},{role:'user',content:[{type:'text',text:user},...images]}],max_tokens:2048,temperature:0};
		const res = await fetch(this.baseUrl+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.apiKey},body:JSON.stringify(body)});
		if (!res.ok) { const txt = await res.text(); throw new Error('Vision API '+res.status+': '+txt.slice(0,300)); }
		const data = await res.json() as any;
		let raw = (data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content)||'';
		// ponytail: reasoning models put answer in reasoning_content when tokens exhausted
		if (!raw) raw = (data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.reasoning_content)||'';
		return this.parse(reqType, raw, task);
	}
	private parse(reqType: string, raw: string, task: HCaptchaTask): HCaptchaRecognitionResult {
		const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
		let parsed: any;
		try { parsed = JSON.parse(cleaned); } catch { let si = cleaned.indexOf('{'); if (si === -1) si = cleaned.indexOf('['); if (si === -1) throw new Error('Non-JSON: ' + raw.slice(0, 200)); parsed = JSON.parse(cleaned.slice(si)); }
		if (reqType==='image_label_binary') { if (!Array.isArray(parsed)) throw new Error('Expected 2D bool'); return parsed; }
		// Normalized 0.0-1.0 coords -> scale to 0-500 for browserClaim compatibility
		const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
		const scale = (n: number) => Math.round(clamp01(n) * 500);
		if (reqType==='image_drag_drop') {
			const eid=(task.tasklist&&task.tasklist[0]&&task.tasklist[0].task_key)||'e0';
			// Tolerant extraction: models may return {x,y}, [{x,y}], {target:{x,y}}, or numeric strings
			let p:any = parsed;
			if (Array.isArray(p)) p = p[0];
			if (p && typeof p==='object' && p.target && typeof p.target==='object') p = p.target;
			const nx = p ? Number(p.x) : NaN; const ny = p ? Number(p.y) : NaN;
			if (!isFinite(nx)) {
				console.warn('[OpenAIVision] drag_drop unparseable answer:', raw.slice(0,300));
				throw new Error('Missing x');
			}
			return [[{entity_id:eid,x:scale(nx),y:scale(isFinite(ny)?ny:0),w:20,h:20}]];
		}
		if (!Array.isArray(parsed)) throw new Error('Expected array');
		return [parsed.map((p:any)=>({x:scale(p.x),y:scale(p.y),w:Number(p.w||0),h:Number(p.h||0)}))];
	}
}
