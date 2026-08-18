import { CaptchaDataFromRequest } from './interface';
import { OpenAIVisionSolver, type HCaptchaTask, type HCaptchaRecognitionResult } from './providers/openaiVision';

const openaiBaseUrl = process.env.OPENAI_BASE_URL || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const openaiModel = process.env.OPENAI_MODEL || 'llava-v1.5-7b';

let visionSolver: OpenAIVisionSolver | null = null;
if (openaiBaseUrl && openaiApiKey) {
	visionSolver = new OpenAIVisionSolver(openaiBaseUrl, openaiApiKey, openaiModel);
	console.log(`OpenAI Vision configured: ${openaiBaseUrl} model=${openaiModel}`);
} else {
	console.warn('OpenAI Vision not configured. Set OPENAI_BASE_URL and OPENAI_API_KEY in .env');
}

export async function solveCaptcha(data: CaptchaDataFromRequest): Promise<string> {
	return Promise.reject(new Error('Token-based captcha solving removed. Use browser claim with OPENAI vision.'));
}

export async function solveHCaptchaRecognition(task: HCaptchaTask): Promise<HCaptchaRecognitionResult> {
	if (!visionSolver) throw new Error('No vision provider configured. Set OPENAI_BASE_URL and OPENAI_API_KEY.');
	return visionSolver.solve(task);
}

export function canSolveCaptcha(): boolean {
	return visionSolver !== null;
}

export type { HCaptchaTask, HCaptchaRecognitionResult };
