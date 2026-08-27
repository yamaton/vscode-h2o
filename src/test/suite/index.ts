import * as fs from 'fs';
import * as path from 'path';
import Mocha = require('mocha');

export async function run(): Promise<void> {
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
		timeout: 20000,
	});
	const testsRoot = __dirname;
	const testFiles: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
			} else if (entry.isFile() && entry.name.endsWith('.test.js')) {
				testFiles.push(entryPath);
			}
		}
	};
	visit(testsRoot);
	if (testFiles.length === 0) {
		throw new Error(`No Extension Host tests found under ${testsRoot}`);
	}
	testFiles.sort().forEach(testFile => mocha.addFile(testFile));

	await new Promise<void>((resolve, reject) => {
		mocha.run(failures => {
			if (failures > 0) {
				reject(new Error(`${failures} Extension Host test(s) failed`));
			} else {
				resolve();
			}
		});
	});
}
