import { CaptchaDataFromRequest } from './interface';
import { NopeCHASolver } from './providers/nopecha';
import { NopeCHARecognitionSolver, type HCaptchaTask, type HCaptchaRecognitionResult } from './providers/nopechaRecognition';

function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[\r\n,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

// ponytail: NoneCap removed — Discord enterprise hcaptcha without sticky proxy was consistently rejected (10008) even when dashboard showed 100% solved. Keep one provider (NopeCHA) to stay boring. Re-add via src/providers/nonecap.ts + NONECAP_* env if needed.
const nopechaClients: NopeCHASolver[] = parseList(process.env.NOPECHA_API_KEY).map(
	(key) => new NopeCHASolver(key),
);
const nopechaRecogClients: NopeCHARecognitionSolver[] = parseList(process.env.NOPECHA_API_KEY).map(
	(key) => new NopeCHARecognitionSolver(key),
);

if (nopechaClients.length)
	console.log(`NopeCHA API key found. ${nopechaClients.length} key(s) enabled.`);

let nopechaIndex = 0;
let recogIndex = 0;

async function tryClients<T>(
	clients: { hcaptcha: (sitekey: string, url: string, rqdata?: string) => Promise<T> }[],
	startIndex: number,
	args: [string, string, string | undefined],
	label: string,
): Promise<{ result: T; nextIndex: number }> {
	let lastError: unknown;
	const n = clients.length;
	for (let attempt = 0; attempt < n; attempt++) {
		const idx = (startIndex + attempt) % n;
		try {
			const result = await clients[idx].hcaptcha(args[0], args[1], args[2]);
			return { result, nextIndex: (idx + 1) % n };
		} catch (err) {
			lastError = err;
			const message = err instanceof Error ? err.message : String(err);
			const willRetry = attempt + 1 < n;
			console.warn(
				`${label} key ${idx + 1}/${n} failed: ${message}${willRetry ? ' -> trying next key' : ''}`,
			);
			if (!willRetry) throw lastError;
		}
	}
	throw lastError;
}

export async function solveCaptcha(data: CaptchaDataFromRequest): Promise<string> {
	const args: [string, string, string | undefined] = [
		data.captcha_sitekey,
		'https://discord.com',
		data.captcha_rqdata,
	];

	if (nopechaClients.length) {
		const { result, nextIndex } = await tryClients(nopechaClients, nopechaIndex, args, 'NopeCHA');
		nopechaIndex = nextIndex;
		return result;
	}

	return Promise.reject(new Error('No captcha provider configured (set NOPECHA_API_KEY).'));
}

// Recognition path — free 100/day (image task, not Token). Called from browserClaim when Token returns error 18.
export async function solveHCaptchaRecognition(task: HCaptchaTask): Promise<HCaptchaRecognitionResult> {
	if (!nopechaRecogClients.length) throw new Error('No captcha provider configured (set NOPECHA_API_KEY).');
	const n = nopechaRecogClients.length;
	let lastError: unknown;
	for (let attempt = 0; attempt < n; attempt++) {
		const idx = (recogIndex + attempt) % n;
		try {
			const result = await nopechaRecogClients[idx].solve(task);
			recogIndex = (idx + 1) % n;
			return result;
		} catch (err) {
			lastError = err;
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`NopeCHA Recognition key ${idx + 1}/${n} failed: ${msg}${attempt + 1 < n ? ' -> next' : ''}`);
			if (attempt + 1 >= n) throw lastError;
		}
	}
	throw lastError;
}

export function canSolveCaptcha(): boolean {
	return nopechaClients.length > 0 || nopechaRecogClients.length > 0;
}
