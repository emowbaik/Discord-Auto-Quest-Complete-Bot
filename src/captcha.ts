import { CaptchaDataFromRequest } from './interface';
import { NopeCHASolver } from './providers/nopecha';

const nopechaClient = process.env.NOPECHA_API_KEY
	? new NopeCHASolver(process.env.NOPECHA_API_KEY)
	: null;

if (nopechaClient) {
	console.log('NopeCHA API key found. Captcha solving is enabled.');
}

export function solveCaptcha(data: CaptchaDataFromRequest): Promise<string> {
	if (!nopechaClient) {
		return Promise.reject(new Error('NOPECHA_API_KEY is not configured.'));
	}
	return nopechaClient.hcaptcha(data.captcha_sitekey, 'https://discord.com', data.captcha_rqdata);
}

export function canSolveCaptcha(): boolean {
	return nopechaClient !== null;
}
