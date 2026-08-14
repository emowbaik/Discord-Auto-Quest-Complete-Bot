import { CaptchaDataFromRequest } from './interface';
import { NoneCapSolver } from './providers/nonecap';
import { NopeCHASolver } from './providers/nopecha';

const nonecapClient = process.env.NONECAP_API_KEY
	? new NoneCapSolver(
			process.env.NONECAP_API_KEY,
			process.env.NONECAP_PROXY || undefined,
			Number(process.env.NONECAP_WAIT || 45),
		)
	: null;

const nopechaClient = process.env.NOPECHA_API_KEY
	? new NopeCHASolver(process.env.NOPECHA_API_KEY)
	: null;

if (nonecapClient) console.log('NoneCap API key found. Captcha solving is enabled (NoneCap).');
else if (nopechaClient) console.log('NopeCHA API key found. Captcha solving is enabled.');

export function solveCaptcha(data: CaptchaDataFromRequest): Promise<string> {
	if (nonecapClient) return nonecapClient.hcaptcha(data.captcha_sitekey, 'https://discord.com', data.captcha_rqdata);
	if (nopechaClient) return nopechaClient.hcaptcha(data.captcha_sitekey, 'https://discord.com', data.captcha_rqdata);
	return Promise.reject(new Error('No captcha provider configured (set NONECAP_API_KEY or NOPECHA_API_KEY).'));
}

export function canSolveCaptcha(): boolean {
	return nonecapClient !== null || nopechaClient !== null;
}
