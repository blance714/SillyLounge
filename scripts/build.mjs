import esbuild from 'esbuild';
import { buildOptions } from './build-config.mjs';

const watch = process.argv.includes('--watch');

if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log('[ChatUI] watching Preact root app...');
} else {
    await esbuild.build(buildOptions);
}
