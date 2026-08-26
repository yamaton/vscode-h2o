import { runExtensionTests } from './extension.test';

export async function run(): Promise<void> {
	console.log('Running Extension Host integration checks...');
	await runExtensionTests();
	console.log('Extension Host integration checks passed.');
}
