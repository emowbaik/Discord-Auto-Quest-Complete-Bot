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

function getPrompt(reqType: string, question: string): string {
	if (reqType === 'image_drag_drop') return 'Look at the images. The task: "' + question + '". One small image is a draggable piece. Identify the CENTER (x,y) of the exact matching location/slot in the main background image where this piece must be dropped. Coordinates are in a 0-500 pixel grid. Return ONLY valid JSON: {"x": <0-500>, "y": <0-500>}. Be precise, examine the shapes/colors carefully. No markdown, no bbox arrays, single point only.';
	if (reqType === 'image_label_area_select') return 'Look at the image. The task: "' + question + '". Identify the CENTER (x,y) of EVERY object matching the instruction, in a 0-500 pixel grid. Return ONLY a JSON array: [{"x": <0-500>, "y": <0-500>}, ...]. One entry per matching object. No markdown.';
	return 'Look at the image grid. The task: "' + question + '". For each tile (left-to-right, top-to-bottom), answer true if it matches the instruction, false otherwise. Return ONLY a 2D boolean array matching the grid layout: [[true,false],[false,true]]. No markdown.';
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
		const prompt = getPrompt(reqType, question);
		const images: Array<{type:"image_url";image_url:{url:string}}> = [];
		for (const t of task.tasklist || []) { const uris=[t.datapoint_uri,...(t.entities||[]).map((e:any)=>e.entity_uri||'')].filter(Boolean); for(const uri of uris){ try { const r=await fetch(uri); const b=Buffer.from(await r.arrayBuffer()); const ct=r.headers.get('content-type')||'image/jpeg'; images.push({type:"image_url",image_url:{url:'data:'+ct+';base64,'+b.toString('base64')}}); } catch(e){ console.warn('[OpenAIVision] img fetch fail '+String(e instanceof Error?e.message:e)); } } }
		if (!images.length) throw new Error('No images in task');
		const body = {model:this.model,messages:[{role:'user',content:[{type:'text',text:prompt},...images]}],max_tokens:2048,temperature:0.1};
		const res = await fetch(this.baseUrl+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.apiKey},body:JSON.stringify(body)});
		if (!res.ok) { const txt = await res.text(); throw new Error('Vision API '+res.status+': '+txt.slice(0,300)); }
		const data = await res.json() as any;
		const raw = (data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content)||'';
		return this.parse(reqType, raw, task);
	}
	private parse(reqType: string, raw: string, task: HCaptchaTask): HCaptchaRecognitionResult {
		const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
		let parsed: any;
		try { parsed = JSON.parse(cleaned); } catch { let si = cleaned.indexOf('{'); if (si === -1) si = cleaned.indexOf('['); if (si === -1) throw new Error('Non-JSON: ' + raw.slice(0, 200)); parsed = JSON.parse(cleaned.slice(si)); }
		if (reqType==='image_label_binary') { if (!Array.isArray(parsed)) throw new Error('Expected 2D bool'); return parsed; }
		if (reqType==='image_drag_drop') { const eid=(task.tasklist&&task.tasklist[0]&&task.tasklist[0].task_key)||'e0'; if (typeof parsed.x!=='number') throw new Error('Missing x'); return [[{entity_id:eid,x:Number(parsed.x),y:Number(parsed.y),w:Number(parsed.w||20),h:Number(parsed.h||20)}]]; }
		if (!Array.isArray(parsed)) throw new Error('Expected array');
		return [parsed.map((p:any)=>({x:Number(p.x),y:Number(p.y),w:Number(p.w||0),h:Number(p.h||0)}))];
	}
}
