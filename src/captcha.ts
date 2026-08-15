import { CaptchaDataFromRequest } from './interface';
import { NoneCapSolver } from './providers/nonecap';
import { NopeCHASolver } from './providers/nopecha';

function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[\r\n,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const nonecapKeys = parseList(process.env.NONECAP_API_KEY);
const nonecapProxies = parseList(process.env.NONECAP_PROXY);
const nonecapWait = Number(process.env.NONECAP_WAIT || 45);
const nonecapClients: NoneCapSolver[] = nonecapKeys.map((key, i) => {
	// single proxy -> reuse for all keys; multiple -> match by index
	const proxy =
		nonecapProxies[i] ??
		(nonecapProxies.length === 1 ? nonecapProxies[0] : undefined);
	return new NoneCapSolver(key, proxy || undefined, nonecapWait);
});

const nopechaClients: NopeCHASolver[] = parseList(process.env.NOPECHA_API_KEY).map(
	(key) => new NopeCHASolver(key),
);

if (nonecapClients.length)
	console.log(`NoneCap API key found. ${nonecapClients.length} key(s) enabled (NoneCap).`);
else if (nopechaClients.length)
	console.log(`NopeCHA API key found. ${nopechaClients.length} key(s) enabled.`);

let nonecapIndex = 0;
let nopechaIndex = 0;

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
			const retryable = /429|402|rate_limited|concurrency_limit|sitekey_rate_limited|insufficient_credits|key_credit_limit|credit/i.test(
				message,
			);
			const willRetry = attempt + 1 < n;
			console.warn(
				`${label} key ${idx + 1}/${n} failed: ${message}${willRetry ? ' -> trying next key' : ''}`,
			);
			if (!willRetry) throw lastError;
			// non-retryable errors also fall through to next key as fallback pool
			if (!retryable) {
				// still try next key — keys are independent accounts
			}
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

	if (nonecapClients.length) {
		try {
			const { result, nextIndex } = await tryClients(nonecapClients, nonecapIndex, args, 'NoneCap');
			nonecapIndex = nextIndex;
			return result;
		} catch (err) {
			// All NoneCap keys exhausted -> fall through to NopeCHA if available
			if (!nopechaClients.length) throw err;
			console.warn('All NoneCap keys failed, falling back to NopeCHA');
		}
	}

	if (nopechaClients.length) {
		const { result, nextIndex } = await tryClients(nopechaClients, nopechaIndex, args, 'NopeCHA');
		nopechaIndex = nextIndex;
		return result;
	}

	return Promise.reject(new Error('No captcha provider configured (set NONECAP_API_KEY or NOPECHA_API_KEY).'));
}

export function canSolveCaptcha(): boolean {
	return nonecapClients.length > 0 || nopechaClients.length > 0;
}
