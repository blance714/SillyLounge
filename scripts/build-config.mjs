export const buildOptions = {
    entryPoints: ['ui/app.tsx'],
    outfile: 'dist/root-app.mjs',
    bundle: true,
    format: 'esm',
    target: 'es2020',
    sourcemap: true,
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    external: [
        '../shield/*',
        '../store/*',
    ],
    logLevel: 'info',
};
